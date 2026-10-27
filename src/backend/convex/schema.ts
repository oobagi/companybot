import { viewConfig } from "./recordValidators";
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const notify = v.union(v.literal("all"), v.literal("mentions"), v.literal("off"));

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
	/** `label`: what it did, for people ("Send SMS with Fake CRM"; core `callLabel`). Older parts lack it. */
	v.object({ type: v.literal("tool"), id: v.string(), name: v.string(), label: v.optional(v.string()), status: toolStatus }),
	/** Props were validated against the widget's schema when the agent placed it. */
	v.object({ type: v.literal("widget"), id: v.string(), widget: v.object({ type: v.string(), props: v.any() }) }),
	/** A tool call held for approval (`id` is the tool call's id). The app reads its state from `approvals`. */
	v.object({ type: v.literal("approval"), id: v.string(), approvalId: v.id("approvals"), tool: v.string() }),
);

export const approvalStatus = v.union(
	v.literal("pending"),
	v.literal("approved"),
	v.literal("running"),
	v.literal("done"),
	v.literal("failed"),
	v.literal("denied"),
);

export const trashKind = v.union(v.literal("record"), v.literal("database"), v.literal("field"), v.literal("page"), v.literal("channel"));

/** core's Risk. */
export const risk = v.union(v.literal("none"), v.literal("inside"), v.literal("outside"), v.literal("locked"));

/** core's AllowedHow: why a call that would ask ran. */
export const allowedHow = v.object({
	how: v.union(v.literal("once"), v.literal("always"), v.literal("automation")),
	by: v.id("users"),
	at: v.number(),
	automation: v.optional(v.string()),
	/** The rule that allowed it (Always or an automation grant). Gone if it was removed since. */
	ruleId: v.optional(v.id("permissionRules")),
});

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

/** core's FieldValue. Empty values aren't stored. Currency is core's Money. */
export const fieldValue = v.union(
	v.string(),
	v.number(),
	v.boolean(),
	v.array(v.string()),
	v.object({ minor: v.number(), currency: v.string() }),
);

/** core's FieldKind. */
export const fieldKind = v.union(
	v.literal("text"),
	v.literal("number"),
	v.literal("currency"),
	v.literal("date"),
	v.literal("checkbox"),
	v.literal("choice"),
	v.literal("email"),
	v.literal("phone"),
	v.literal("url"),
	v.literal("user"),
	v.literal("link"),
);

/** core's AutomationAudience. */
export const audience = v.union(v.literal("creator"), v.literal("subscribers"), v.literal("channel"));

export default defineSchema({
	...authTables,
	// Convex Auth's, plus `erasedAt`.
	users: defineTable({
		...authTables.users.validator.fields,
		/** Set when the account is erased (workspace.eraseAccount): the row stays, scrubbed, so history shows a former member, and a sign-in from before acts as nobody. */
		erasedAt: v.optional(v.number()),
	})
		.index("email", ["email"])
		.index("phone", ["phone"]),

	// Local backends only (`pnpm dev`): the latest sign-in code per email, read back by the app.
	localSignInCodes: defineTable({ email: v.string(), code: v.string() }).index("by_email", ["email"]),

	workspaces: defineTable({
		name: v.string(),
		version: v.optional(v.number()),
		/** ISO 4217: the default for new amounts. Each amount stores its own. Unset means DEFAULT_CURRENCY. */
		currency: v.optional(v.string()),
		/** Whether agents read and write memories. Off keeps them, unused. Unset means on. */
		memory: v.optional(v.boolean()),
		/** Set when an owner deletes it: every access refuses at once, then a cascade deletes its rows (lifecycle.ts). */
		deleting: v.optional(v.boolean()),
	}),

	members: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		role,
		/** Normalized for bounded invitation checks. COMPAT: backfilled by memberEmails. */
		email: v.optional(v.string()),
	})
		.index("by_user", ["userId", "workspaceId"])
		// Oldest first: Convex orders an index's ties by _creationTime.
		.index("by_joined", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_role", ["workspaceId", "role"])
		.index("by_email", ["workspaceId", "email"]),

	// One per email per workspace. Only someone signed in with that email can accept it.
	invites: defineTable({
		workspaceId: v.id("workspaces"),
		email: v.string(),
		role,
		/** Missing on invites from before invite emails. */
		invitedBy: v.optional(v.id("users")),
	})
		.index("by_email", ["email"])
		.index("by_workspace", ["workspaceId"])
		.index("by_workspace_email", ["workspaceId", "email"]),

	// Each invite email sent, so a workspace can't flood an inbox (`inviteEmailProblem`).
	inviteEmails: defineTable({
		workspaceId: v.id("workspaces"),
		email: v.string(),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_email", ["workspaceId", "email"]),

	// Each workspace has its own agents. Every save also writes an agentVersions row.
	agents: defineTable({
		workspaceId: v.id("workspaces"),
		...agentConfig.fields,
		archived: v.boolean(),
		version: v.number(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
	}).index("by_workspace", ["workspaceId"]).index("by_workspace_active", ["workspaceId", "archived"]),

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
		/** Commit timestamp. COMPAT(0.1.0-alpha.6): only memory.forgetForRemovedMember reads it; drop it with that. */
		createdTs: v.optional(v.commitTs()),
	})
		.index("by_workspace", ["workspaceId"])
		// One person's personal memories in a workspace (team memories have no owner).
		.index("by_owner", ["ownerId", "workspaceId", "createdTs"])
		// Newest first within a scope, across owners (lists), or one owner's personal memories.
		.index("by_agent_scope", ["agentId", "scope"])
		.index("by_agent_owner", ["agentId", "scope", "ownerId"])
		// Agent search over every memory, however many (memoryOps.searchMemories).
		.searchIndex("search_content", { searchField: "content", filterFields: ["agentId", "scope", "ownerId"] }),

	// Personal preferences: only the person sees them; they follow them across devices.
	// Where apps that send no workspace act: the first workspace the person joined, set once.
	// COMPAT(0.1.0-alpha.7): delete with legacyMemberOf.
	legacyWorkspaces: defineTable({
		userId: v.id("users"),
		workspaceId: v.id("workspaces"),
	}).index("by_user", ["userId"]),

	preferences: defineTable({
		userId: v.id("users"),
		/** What agents and teammates call you. */
		displayName: v.string(),
		sendWith: v.union(v.literal("enter"), v.literal("mod-enter")),
		/** Desktop notifications and the dock badge: DMs and mentions (default), mentions only, or off. */
		notify: v.optional(notify),
		/** The time zone they picked. Left out means automatic: `deviceTimeZone`. */
		timeZone: v.optional(v.string()),
		/** Their computer's time zone, reported by the app. */
		deviceTimeZone: v.optional(v.string()),
		/** The workspace they used last: only a hint for a device opening for the first time. Each device keeps its own. */
		workspaceId: v.optional(v.id("workspaces")),
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"]),

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
		.index("by_workspace", ["workspaceId", "connectorId", "userId"])
		.index("by_user", ["userId", "workspaceId"]),

	// A connector sign-in in progress: started in the app, finished by /oauth/callback.
	// `data` holds the encrypted OAuthState (client, PKCE verifier). One use; expires.
	connectorOAuthFlows: defineTable({
		state: v.string(),
		connectorId: v.string(),
		userId: v.id("users"),
		/** The workspace it connects in. Missing on sign-ins started before people could be in several. */
		workspaceId: v.optional(v.id("workspaces")),
		/**
		 * The membership and install it started under. Saving checks both are still the ones there,
		 * so a sign-in from before a removal and rejoin, or an uninstall and reinstall, can't connect.
		 * Missing on sign-ins started before this; those are refused (they expire in 15 minutes anyway).
		 */
		memberId: v.optional(v.id("members")),
		connectorInstallId: v.optional(v.id("connectorInstalls")),
		data: v.string(),
		expiresAt: v.number(),
	})
		.index("by_state", ["state"])
		.index("by_user", ["userId", "workspaceId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_install", ["connectorInstallId"]),

	// Legacy: the connector tables' names before "plugins" became "connectors". Emptied by
	// the `connector*` migrations (migrations.ts).
	// COMPAT(0.1.0-alpha.6): once those migrations have run on prod, drop these three tables and the migrations.
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
		/** Set for skills people made (id "custom-…"); library ones come from the catalog. Shared setting: versioned. */
		custom: v.optional(
			v.object({
				name: v.string(),
				/** Who made it; they can always edit it (`canEditMade`). Missing on skills owners made before members could. */
				createdBy: v.optional(v.id("users")),
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
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		lastMessageAt: v.number(),
		/** USD spent on agent replies and summaries here (main timeline). */
		costUsd: v.optional(v.number()),
	})
		.index("by_workspace", ["workspaceId", "kind"])
		.index("by_dm_key", ["workspaceId", "dmKey"])
		.index("by_name", ["workspaceId", "name", "archived"]),

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
		.index("by_workspace", ["workspaceId", "userId"])
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
		/** A delivered message from an agent, on this person's behalf. */
		actingFor: v.optional(v.id("users")),
		text: v.string(),
		parts: v.array(messagePart),
		/** Who was @mentioned. Mentioned agents get a turn. `recordIds`: records the message references. */
		mentions: v.object({
			userIds: v.array(v.id("users")),
			agentIds: v.array(v.id("agents")),
			recordIds: v.optional(v.array(v.id("records"))),
		}),
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
		/** Server-written provenance. `foreign` snapshots whose words the run follows; absent on older messages, which ask. */
		automation: v.optional(v.object({ id: v.string(), name: v.string(), foreign: v.optional(v.boolean()) })),
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
	}).index("by_message", ["messageId", "emoji"])
		.index("by_actor", ["messageId", "emoji", "userId", "agentId"]),

	// A person @mentioned in a main-timeline message, so unread mentions are found by index
	// however much else was said since. `at`: the message's _creationTime. Gone when it's deleted.
	userMentions: defineTable({
		userId: v.id("users"),
		chatId: v.id("chats"),
		messageId: v.id("chatMessages"),
		at: v.number(),
	})
		.index("by_user_chat", ["userId", "chatId", "at"])
		.index("by_message", ["messageId", "userId"]),

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
		/** Set when the turn follows a decision on this approval: it runs the call if approved, then tells the agent. */
		approvalId: v.optional(v.id("approvals")),
	})
		.index("by_place", ["agentId", "chatId", "threadId", "status"])
		.index("by_session", ["sessionId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_chat", ["chatId"]),

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
	})
		.index("by_place", ["agentId", "chatId", "threadId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_chat", ["chatId"]),

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
		/** Only `actorId` sees it (activity.ts). Cleared when their account is erased. */
		output: v.optional(v.string()),
		error: v.optional(v.string()),
		status: v.union(v.literal("done"), v.literal("error")),
		/** Calls that would have asked: who allowed it and how. */
		allowed: v.optional(allowedHow),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_reply", ["replyId"])
		.index("by_actor", ["actorId"]),

	// A tool call an agent held for approval, shown as a card in its reply (see core approvals.ts).
	// Locked to `hash` (SHA-256 of the exact tool + input): the approver confirms that hash,
	// and the runner re-checks it before running, so only the approved content can run.
	approvals: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		/** The person the agent acted for. Only they can decide, and the call runs as them. */
		actorId: v.id("users"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		/** The turn that asked, and its reply holding the card. */
		turnId: v.id("agentTurns"),
		replyId: v.id("chatMessages"),
		callId: v.string(),
		tool: v.string(),
		/** Canonical JSON (approvals.canonicalJson) of the exact input. Never clipped: this is what runs. */
		input: v.string(),
		hash: v.string(),
		status: approvalStatus,
		expiresAt: v.number(),
		decidedAt: v.optional(v.number()),
		/** Approved calls: the result (JSON, clipped) or error. Shown only to the actor, like the activity log; cleared when their account is erased. */
		result: v.optional(v.string()),
		error: v.optional(v.string()),
		/**
		 * The tool's risk when it asked, so the card knows whether to offer "Always allow". Unset on old rows: no offer.
		 * COMPAT(0.1.0-alpha.6): delete or backfill rows without it (only dev has any), then make it required.
		 * Prod got approvals with `risk`. Drop the fallbacks marked in approvals.ts with it.
		 */
		risk: v.optional(risk),
		/**
		 * Set when the call came from an automation's run: an Always grant is scoped to it, never wider.
		 * COMPAT(0.1.0-alpha.6): rows from before it fall back to the turn's trigger in `alwaysFor`; drop that fallback.
		 */
		automationInstallId: v.optional(v.id("automationInstalls")),
		/** Set when the actor chose "Always allow": a rule was saved too. */
		always: v.optional(v.boolean()),
	})
		.index("by_reply", ["replyId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_actor", ["actorId"]),

	// Automations: an owner installs a library one, or anyone makes their own, and picks the agent that runs it.
	automationInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		automationId: v.string(),
		agentId: v.id("agents"),
		enabled: v.boolean(),
		/** Schedules run in this time zone: the maker's or installer's, when they set it up. */
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
		/** Who picked the channel. Library automations' channel runs act as them (or another owner if they've left); ones people make act as their maker. */
		channelSetBy: v.optional(v.id("users")),
		/** Webhook automations: the secret in their URL (`/automations/<token>`). */
		webhookToken: v.optional(v.string()),
		/** Set for automations people made (id "custom-…"); library ones come from the catalog. Shared setting: versioned. */
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

	// ---- Permissions: per-person rules and owner locks on agent actions. See wiki/permissions.md. ----
	// An action is one tool: "<connector>.<tool>" on one connector install, or a built-in's id.
	// Read fresh for every call (permissions.check); never copied into a session.

	// One person's Always or Never for one action. With `automationInstallId`, an Always granted
	// when they turned that automation on: it applies to that automation's runs only.
	permissionRules: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		action: v.string(),
		/** Connector actions: the install it was set on. Uninstalling deletes it. */
		connectorInstallId: v.optional(v.id("connectorInstalls")),
		automationInstallId: v.optional(v.id("automationInstalls")),
		setting: v.union(v.literal("always"), v.literal("never")),
		setAt: v.number(),
	})
		.index("by_user", ["userId", "action"])
		.index("by_workspace", ["workspaceId", "userId"])
		.index("by_automation", ["automationInstallId"])
		.index("by_connector", ["connectorInstallId"]),

	// An owner's lock on one action, for everyone (core LockSetting).
	permissionLocks: defineTable({
		workspaceId: v.id("workspaces"),
		action: v.string(),
		connectorInstallId: v.optional(v.id("connectorInstalls")),
		lock: v.union(v.literal("ask"), v.literal("block"), v.literal("none")),
		setBy: v.id("users"),
		setAt: v.number(),
	})
		.index("by_workspace", ["workspaceId", "action"])
		.index("by_connector", ["connectorInstallId"]),

	// The tools a connector's server last listed, so settings can show its actions before
	// anyone uses them. Display only: calls are always decided on the live tool.
	connectorTools: defineTable({
		workspaceId: v.id("workspaces"),
		connectorId: v.string(),
		tools: v.array(v.object({ name: v.string(), title: v.optional(v.string()), description: v.string(), risk })),
	}).index("by_workspace", ["workspaceId", "connectorId"]),

	// ---- End permissions ----

	// Webhook delivery ids. Keep the automationEvents table name to avoid a migration.
	automationEvents: defineTable({
		installId: v.id("automationInstalls"),
		eventId: v.string(),
	}).index("by_install", ["installId", "eventId"]),

	// ---- Databases and records: clients, deals, tasks, calls, and databases people add. See wiki/data.md. ----

	// A database. Built-ins come from core's recordTypeCatalog (`key` "client", "deal"…).
	recordTypes: defineTable({
		version: v.optional(v.number()),
		workspaceId: v.id("workspaces"),
		/** Stable, unique per workspace. */
		key: v.string(),
		name: v.string(),
		plural: v.string(),
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_workspace", ["workspaceId", "key"]),

	// Named sorting, filtering and columns, shared with the workspace.
	databaseViews: defineTable({
		workspaceId: v.id("workspaces"),
		typeId: v.id("recordTypes"),
		...viewConfig,
		version: v.number(),
	}).index("by_type", ["typeId"]),

	// A field on a database. Its values live on `records.values[key]`; renaming keeps the key.
	recordFields: defineTable({
		workspaceId: v.id("workspaces"),
		typeId: v.id("recordTypes"),
		key: v.string(),
		label: v.string(),
		kind: fieldKind,
		/** Removed options stay, `retired`, so records using them keep their meaning. */
		options: v.optional(v.array(v.object({ id: v.string(), label: v.string(), retired: v.optional(v.boolean()) }))),
		linkTypeId: v.optional(v.id("recordTypes")),
		multiple: v.optional(v.boolean()),
		/** Display order. */
		position: v.number(),
		/** In Trash: its values stay on every record but can't be set, filtered or sorted. */
		archived: v.boolean(),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_type", ["typeId", "key"])
		.index("by_type_kind", ["typeId", "kind"]),

	records: defineTable({
		workspaceId: v.id("workspaces"),
		typeId: v.id("recordTypes"),
		/** `values.name`, kept here for display. */
		title: v.string(),
		values: v.record(v.string(), fieldValue),
		/** Title and other text values, for the search index. */
		searchText: v.string(),
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
		/** Set when an agent made the last change, acting for `updatedBy`. */
		updatedByAgent: v.optional(v.id("agents")),
	})
		.index("by_type", ["typeId", "archived"])
		.index("by_workspace", ["workspaceId"])
		.index("by_type_updated", ["typeId", "archived", "updatedAt"])
		.searchIndex("search", { searchField: "searchText", filterFields: ["workspaceId", "typeId", "archived"] }),

	// A page: a standalone doc (wiki, SOP, meeting notes) or a record's body. Its content lives
	// in the prosemirrorSync component, keyed by the page's id (pageSync.ts). See wiki/pages.md.
	pages: defineTable({
		workspaceId: v.id("workspaces"),
		/** Set for a record's body; standalone pages have none. */
		recordId: v.optional(v.id("records")),
		/** Standalone pages only: a record's body shows the record's name. */
		title: v.string(),
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
	})
		.index("by_workspace", ["workspaceId", "recordId", "archived", "title"])
		.searchIndex("search_title", { searchField: "title", filterFields: ["workspaceId", "archived"] }),

	// A page's history: one row per run of edits, like Notion's: whoever started it, and
	// anyone else who edited meanwhile. Its content is the component's snapshot at `version`; the rest are pruned.
	pageVersions: defineTable({
		pageId: v.id("pages"),
		/** Counts up per page, so the oldest past PAGE_VERSIONS_MAX are found by index. */
		n: v.number(),
		/** The component's document version this one ends at. */
		version: v.number(),
		userId: v.id("users"),
		agentId: v.optional(v.id("agents")),
		/** Others who edited while it was open (an agent, for whom), in order. */
		others: v.optional(v.array(v.object({ userId: v.id("users"), agentId: v.optional(v.id("agents")) }))),
		editedAt: v.number(),
		/** Set when it restored an older version: that version's time. */
		restored: v.optional(v.number()),
	}).index("by_page", ["pageId", "n"]),

	// The index behind filtering and sorting on any field: one row per value of a live
	// record (core's indexEntries). Archived records have none. Never read for display.
	// Rows linking to an archived record stay; queries treat that target as gone.
	recordValues: defineTable({
		recordId: v.id("records"),
		fieldId: v.id("recordFields"),
		str: v.optional(v.string()),
		num: v.optional(v.number()),
		/** Link fields: the record linked to. Also answers "what links here". */
		ref: v.optional(v.id("records")),
		/** The record's _creationTime, so equal values list newest first and combined filters can merge by it. */
		at: v.number(),
	})
		.index("by_record", ["recordId", "fieldId"])
		// Ending in `at` then `recordId`, so records sharing a value and creation time still page in a fixed order.
		.index("by_field_str", ["fieldId", "str", "at", "recordId"])
		.index("by_field_num", ["fieldId", "num", "at", "recordId"])
		// Currency: `str` is the code and `num` the amount in its smallest unit, so amounts sort within their currency.
		.index("by_field_money", ["fieldId", "str", "num", "at", "recordId"])
		// A field's rows by creation time: the name field's lists every live record, newest first.
		.index("by_field_at", ["fieldId", "at", "recordId"])
		.index("by_ref", ["ref", "fieldId", "at", "recordId"]),

	// Every change to a record or field, oldest to newest: who (or which agent, acting
	// for whom), and each value's old → new. Undo applies a change in reverse.
	recordHistory: defineTable({
		workspaceId: v.id("workspaces"),
		typeId: v.id("recordTypes"),
		recordId: v.optional(v.id("records")),
		fieldId: v.optional(v.id("recordFields")),
		subject: v.optional(v.string()),
		action: v.union(
			v.literal("created"),
			v.literal("updated"),
			v.literal("archived"),
			v.literal("restored"),
			v.literal("database.created"),
			v.literal("database.updated"),
			v.literal("database.archived"),
			v.literal("database.restored"),
			v.literal("view.created"),
			v.literal("view.updated"),
			v.literal("view.deleted"),
			v.literal("field.created"),
			v.literal("field.updated"),
			v.literal("field.archived"),
			v.literal("field.restored"),
		),
		/** Records: changed values by field key. Fields: changed settings ("label", "options"). */
		changes: v.array(v.object({ key: v.string(), old: v.optional(fieldValue), new: v.optional(fieldValue) })),
		userId: v.id("users"),
		agentId: v.optional(v.id("agents")),
		/** Set on an undo: the change it reversed. */
		undoes: v.optional(v.id("recordHistory")),
		/** Set once this change has been undone. */
		undoneBy: v.optional(v.id("recordHistory")),
	})
		.index("by_record", ["recordId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_type", ["typeId"])
		.index("by_field", ["fieldId"]),

	// A chat message that references a record, so the record can show where it was discussed.
	recordMentions: defineTable({
		recordId: v.id("records"),
		messageId: v.id("chatMessages"),
		chatId: v.id("chats"),
	})
		.index("by_record", ["recordId"])
		.index("by_message", ["messageId"])
		.index("by_chat", ["chatId"]),

	// What's in Trash: one row per deleted record, database, field, page or channel (trash.ts).
	// The item itself stays, `archived`, until it's restored or deleted for good: by an owner,
	// or after TRASH_DAYS by `trash.sweep`. See wiki/data.md#trash.
	trash: defineTable({
		workspaceId: v.id("workspaces"),
		kind: trashKind,
		/** The record's, database's, field's, page's or chat's id. */
		itemId: v.string(),
		/** Its name when deleted, for listing and search. */
		name: v.string(),
		/** Records and fields: their database. */
		typeId: v.optional(v.id("recordTypes")),
		deletedBy: v.id("users"),
		/** Set when an agent deleted it, acting for `deletedBy`. */
		agentId: v.optional(v.id("agents")),
		deletedAt: v.number(),
	})
		.index("by_workspace", ["workspaceId", "deletedAt"])
		.index("by_kind", ["workspaceId", "kind", "deletedAt"])
		.index("by_item", ["itemId"])
		.index("by_type", ["typeId"])
		.index("by_deleted", ["deletedAt"])
		.searchIndex("search", { searchField: "name", filterFields: ["workspaceId", "kind"] }),

	// A cascade deleting what belonged to something that went (cascade.ts): one page of one
	// edge of lifecycle.ts per run, resumed from `edge` and `cursor`. `key` names what's going,
	// so rejoining or reinstalling waits until its old rows are gone.
	cascades: defineTable({
		scope: v.union(v.literal("workspace"), v.literal("member"), v.literal("user"), v.literal("connectorInstall"), v.literal("automationInstall"), trashKind),
		root: v.object({
			workspaceId: v.optional(v.id("workspaces")),
			userId: v.optional(v.id("users")),
			connectorId: v.optional(v.string()),
			connectorInstallId: v.optional(v.id("connectorInstalls")),
			automationInstallId: v.optional(v.id("automationInstalls")),
			pageId: v.optional(v.id("pages")),
			recordId: v.optional(v.id("records")),
			typeId: v.optional(v.id("recordTypes")),
			fieldId: v.optional(v.id("recordFields")),
			chatId: v.optional(v.id("chats")),
		}),
		key: v.string(),
		/** The edge it's on, as "table.index" ("" before the first). */
		edge: v.string(),
		cursor: v.union(v.string(), v.null()),
		/** Rows to read next, when the last page didn't fit in one run (cascade.ts). */
		rows: v.optional(v.number()),
		updatedAt: v.number(),
		/** Its latest scheduled run, so `resume` can tell a failed run from a slow one. */
		run: v.optional(v.id("_scheduled_functions")),
		/** Runs that failed in a row, and the last one's error. */
		attempts: v.optional(v.number()),
		error: v.optional(v.string()),
		/** Set after MAX_ATTEMPTS failures: `resume` leaves it until someone fixes the cause and runs `cascade:retry`. */
		stuck: v.optional(v.boolean()),
	})
		.index("by_key", ["key"])
		.index("by_updated", ["stuck", "updatedAt"]),
});
