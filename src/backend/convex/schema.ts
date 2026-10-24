import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const role = v.union(v.literal("owner"), v.literal("member"));

export const agentConfig = v.object({
	name: v.string(),
	description: v.string(),
	instructions: v.string(),
	model: v.string(),
	tools: v.array(v.string()),
});

export const toolStatus = v.union(v.literal("running"), v.literal("done"), v.literal("error"));

export const messagePart = v.union(
	v.object({ type: v.literal("text"), text: v.string() }),
	v.object({ type: v.literal("tool"), id: v.string(), name: v.string(), status: toolStatus }),
	/** Props were validated against the widget's schema when the agent placed it. */
	v.object({ type: v.literal("widget"), id: v.string(), widget: v.object({ type: v.string(), props: v.any() }) }),
);

/** What a reply used, as the runner reports it. Tokens and cost are summed over its model calls. */
export const replyUsage = v.object({
	model: v.string(),
	steps: v.number(),
	inputTokens: v.number(),
	cachedInputTokens: v.number(),
	outputTokens: v.number(),
	contextTokens: v.number(),
	costUsd: v.number(),
	durationMs: v.number(),
	firstTokenMs: v.optional(v.number()),
});

export const replyStats = v.object({
	...replyUsage.fields,
	/** The conversation's running total once this reply finished, summaries included. */
	conversationCostUsd: v.number(),
});

// Shared settings carry a `version` that goes up on every save. A save sends the
// version it started from; if someone saved in between, it's refused as a conflict.

/** core's CustomTrigger. */
export const customTrigger = v.union(
	v.object({ type: v.literal("schedule"), time: v.string(), weekdays: v.array(v.number()) }),
	v.object({ type: v.literal("webhook") }),
	v.object({ type: v.literal("event"), event: v.literal("message.posted"), channelId: v.string() }),
	v.object({ type: v.literal("event"), event: v.literal("member.joined") }),
);

/** core's AutomationAudience. */
export const audience = v.union(v.literal("creator"), v.literal("subscribers"), v.literal("channel"));

export default defineSchema({
	...authTables,

	// Local backends only (`pnpm dev`): the latest sign-in code per email, read back by the app.
	localSignInCodes: defineTable({ email: v.string(), code: v.string() }).index("by_email", ["email"]),

	workspaces: defineTable({ name: v.string(), version: v.optional(v.number()) }),

	members: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		role,
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"]),

	invites: defineTable({
		workspaceId: v.id("workspaces"),
		email: v.string(),
		role,
	})
		.index("by_email", ["email"])
		.index("by_workspace", ["workspaceId"]),

	// Each workspace has its own agents. Every save also writes an agentVersions row.
	agents: defineTable({
		workspaceId: v.id("workspaces"),
		...agentConfig.fields,
		archived: v.boolean(),
		version: v.number(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
	}).index("by_workspace", ["workspaceId"]),

	agentVersions: defineTable({
		agentId: v.id("agents"),
		version: v.number(),
		config: agentConfig,
		savedBy: v.id("users"),
	}).index("by_agent", ["agentId", "version"]),

	memories: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		scope: v.union(v.literal("workspace"), v.literal("personal")),
		ownerId: v.union(v.id("users"), v.null()),
		content: v.string(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
		/** Set when the agent made the last change, acting for `updatedBy`. */
		updatedByAgent: v.optional(v.boolean()),
		version: v.number(),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_agent", ["agentId"]),

	// Personal preferences: only the person sees them; they follow them across devices.
	preferences: defineTable({
		userId: v.id("users"),
		/** What agents and teammates call you. */
		displayName: v.string(),
		sendWith: v.union(v.literal("enter"), v.literal("mod-enter")),
		/** The time zone they picked. Left out means automatic: `deviceTimeZone`. */
		timeZone: v.optional(v.string()),
		/** Their computer's time zone, reported by the app. */
		deviceTimeZone: v.optional(v.string()),
	}).index("by_user", ["userId"]),

	// Connectors: an owner installs one and picks which roles may use it.
	connectorInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		connectorId: v.string(),
		roles: v.array(role),
		installedBy: v.id("users"),
	}).index("by_workspace", ["workspaceId", "connectorId"]),

	// An account connected to a connector: the workspace's (userId null) or one person's.
	// Credentials are AES-GCM encrypted with CONNECTIONS_KEY and never leave the server.
	connectorConnections: defineTable({
		workspaceId: v.id("workspaces"),
		connectorId: v.string(),
		userId: v.union(v.id("users"), v.null()),
		credentials: v.string(),
		connectedBy: v.id("users"),
		/** Set when the last attempt to use it failed, so the app can say so. */
		error: v.optional(v.string()),
	})
		.index("by_workspace", ["workspaceId", "connectorId", "userId"]),

	// A connector sign-in in progress: started in the app, finished by /oauth/callback.
	// `data` holds the encrypted OAuthState (client, PKCE verifier). One use; expires.
	connectorOAuthFlows: defineTable({
		state: v.string(),
		connectorId: v.string(),
		userId: v.id("users"),
		data: v.string(),
		expiresAt: v.number(),
	})
		.index("by_state", ["state"])
		.index("by_user", ["userId"]),

	// Legacy: the connector tables' names before "plugins" became "connectors". Emptied by
	// the `connector*` migrations (migrations.ts); drop these once it has run on prod.
	pluginInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		pluginId: v.string(),
		roles: v.array(role),
		installedBy: v.id("users"),
	}),
	pluginConnections: defineTable({
		workspaceId: v.id("workspaces"),
		pluginId: v.string(),
		userId: v.union(v.id("users"), v.null()),
		credentials: v.string(),
		connectedBy: v.id("users"),
		error: v.optional(v.string()),
	}),
	pluginOAuthFlows: defineTable({
		state: v.string(),
		pluginId: v.string(),
		userId: v.id("users"),
		data: v.string(),
		expiresAt: v.number(),
	}),

	skillInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		skillId: v.string(),
		/** Set for skills an owner made (id "custom-…"); library ones come from the catalog. Shared setting: versioned. */
		custom: v.optional(
			v.object({
				name: v.string(),
				description: v.string(),
				instructions: v.string(),
				version: v.number(),
				updatedBy: v.id("users"),
				updatedAt: v.number(),
			}),
		),
	}).index("by_workspace", ["workspaceId", "skillId"]),

	// ---- Chat: channels, DMs (people and agents), threads, reactions. See wiki/chat.md. ----

	// A channel (named, public or private) or a DM (fixed set of people and agents).
	chats: defineTable({
		workspaceId: v.id("workspaces"),
		kind: v.union(v.literal("channel"), v.literal("dm")),
		/** Channels only: lowercase, no "#", unique per workspace. */
		name: v.optional(v.string()),
		topic: v.optional(v.string()),
		/** Private channels are visible to their members only. DMs are always private. */
		private: v.boolean(),
		/** DMs only: sorted participant keys ("u:<id>", "a:<id>") joined by ",", to find an existing DM. */
		dmKey: v.optional(v.string()),
		/** The channel everyone joins (#general). Can't be left or made private. */
		isDefault: v.optional(v.boolean()),
		archived: v.boolean(),
		createdBy: v.id("users"),
		lastMessageAt: v.number(),
		/** USD spent on agent replies and summaries here (main timeline). */
		costUsd: v.optional(v.number()),
	})
		.index("by_workspace", ["workspaceId", "kind"])
		.index("by_dm_key", ["workspaceId", "dmKey"])
		.index("by_name", ["workspaceId", "name"]),

	// Who's in a chat: one person or one agent per row.
	chatMembers: defineTable({
		chatId: v.id("chats"),
		workspaceId: v.id("workspaces"),
		userId: v.optional(v.id("users")),
		agentId: v.optional(v.id("agents")),
		/** People only: newest message time they've seen in the main timeline. */
		lastReadAt: v.optional(v.number()),
	})
		.index("by_chat", ["chatId"])
		.index("by_user", ["userId", "chatId"])
		.index("by_agent", ["agentId", "chatId"]),

	// A message in a chat's main timeline, or in a thread (threadId = the parent message).
	// Written by a person (authorUserId) or an agent (authorAgentId), never both.
	chatMessages: defineTable({
		chatId: v.id("chats"),
		workspaceId: v.id("workspaces"),
		threadId: v.optional(v.id("chatMessages")),
		authorUserId: v.optional(v.id("users")),
		authorAgentId: v.optional(v.id("agents")),
		text: v.string(),
		parts: v.array(messagePart),
		/** Who was @mentioned. Mentioned agents get a turn. */
		mentions: v.object({ userIds: v.array(v.id("users")), agentIds: v.array(v.id("agents")) }),
		status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
		error: v.optional(v.string()),
		/** Agent replies only, once finished. `conversationCostUsd` is the chat's (or thread's) running total. */
		stats: v.optional(replyStats),
		editedAt: v.optional(v.number()),
		/** Deleted messages keep their row (threads hang off them) but lose their content. */
		deleted: v.optional(v.boolean()),
		/** Thread parents only. */
		replyCount: v.optional(v.number()),
		lastReplyAt: v.optional(v.number()),
		/** Thread parents only: USD spent on agent replies and summaries in the thread. */
		costUsd: v.optional(v.number()),
		/** Set when an automation sent this message for the person. */
		automation: v.optional(v.object({ id: v.string(), name: v.string() })),
	})
		.index("by_chat_thread", ["chatId", "threadId"])
		.index("by_workspace", ["workspaceId"])
		.searchIndex("search_text", { searchField: "text", filterFields: ["workspaceId", "chatId"] }),

	// One emoji from one person or agent on one message.
	reactions: defineTable({
		messageId: v.id("chatMessages"),
		chatId: v.id("chats"),
		emoji: v.string(),
		userId: v.optional(v.id("users")),
		agentId: v.optional(v.id("agents")),
	}).index("by_message", ["messageId", "emoji"]),

	// Queue of agent replies. One `running` per agent per place (chat + thread); the rest wait.
	agentTurns: defineTable({
		workspaceId: v.id("workspaces"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		agentId: v.id("agents"),
		/** The message that mentioned the agent (or any message, in an agent DM). */
		triggerId: v.id("chatMessages"),
		/** The agent acts as this person: their role, connector connections, and access. */
		actorId: v.id("users"),
		/** The streaming reply, once running. */
		replyId: v.optional(v.id("chatMessages")),
		/** The agent's session for this place, once running. */
		sessionId: v.optional(v.id("agentSessions")),
		/** The exact user message sent to the model this turn. Replayed as-is in later turns. */
		prompt: v.optional(v.string()),
		status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error")),
		startedAt: v.optional(v.number()),
	})
		.index("by_place", ["agentId", "chatId", "threadId", "status"])
		.index("by_status", ["status"])
		.index("by_session", ["sessionId"]),

	// One agent's ongoing context in one place (chat + thread). Append-only: past turns
	// replay exactly as sent, so prompt caching hits. Older turns fold into `summary`.
	agentSessions: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		/** Summary of turns created at or before `summarizedUpTo` (a turn's _creationTime). */
		summary: v.optional(v.string()),
		summarizedUpTo: v.optional(v.number()),
		compacting: v.optional(v.boolean()),
		/** USD spent on this session's replies and summaries. */
		costUsd: v.optional(v.number()),
	}).index("by_place", ["agentId", "chatId", "threadId"]),

	// The activity log: every tool call an agent made, acting for `actorId`. Readable by
	// whoever can see the chat it happened in; `output` only by the person it acted for.
	agentActivity: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		actorId: v.id("users"),
		turnId: v.id("agentTurns"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		replyId: v.id("chatMessages"),
		/** Same id as the reply's tool part, so the app can open one from the other. */
		callId: v.string(),
		tool: v.string(),
		/** False only for read-only tools. */
		changes: v.boolean(),
		/** JSON, cut to ACTIVITY_MAX_CHARS. */
		input: v.string(),
		output: v.optional(v.string()),
		error: v.optional(v.string()),
		status: v.union(v.literal("done"), v.literal("error")),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_reply", ["replyId"]),

	// Automations: an owner installs one and picks the agent that runs it.
	automationInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		automationId: v.string(),
		agentId: v.id("agents"),
		enabled: v.boolean(),
		/** Schedules run in this time zone; set from the installer's computer. */
		timeZone: v.string(),
		installedBy: v.id("users"),
		/** Local date of the last scheduled run, so a schedule runs once a day. */
		lastRunDate: v.optional(v.string()),
		lastRunAt: v.optional(v.number()),
		/** What the last run did, in a line, e.g. "Sent to 3 people". */
		lastResult: v.optional(v.string()),
		/** Who it runs for. Unset on installs from before audiences: read with `audienceOf`. */
		audience: v.optional(audience),
		/** Audience "channel": post each run here, once. */
		channelId: v.optional(v.id("chats")),
		/** The owner who picked the channel; channel runs act as them (or another owner if they've left). */
		channelSetBy: v.optional(v.id("users")),
		/** Event automations: the secret in their webhook URL (`/automations/<token>`). */
		webhookToken: v.optional(v.string()),
		/** Set for automations an owner made (id "custom-…"); library ones come from the catalog. Shared setting: versioned. */
		custom: v.optional(
			v.object({
				name: v.string(),
				prompt: v.string(),
				trigger: customTrigger,
				version: v.number(),
				updatedBy: v.id("users"),
				updatedAt: v.number(),
			}),
		),
	})
		.index("by_workspace", ["workspaceId", "automationId"])
		.index("by_enabled", ["enabled"])
		.index("by_webhook", ["webhookToken"]),

	// People who turned on an automation whose audience is "subscribers".
	automationSubscriptions: defineTable({
		installId: v.id("automationInstalls"),
		userId: v.id("users"),
	})
		.index("by_install", ["installId", "userId"])
		.index("by_user", ["userId"]),

	// Webhook events already run, by the sender's event id, so a retried delivery runs once.
	automationEvents: defineTable({
		installId: v.id("automationInstalls"),
		eventId: v.string(),
	}).index("by_install", ["installId", "eventId"]),
});
