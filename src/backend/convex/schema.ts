import { viewConfig } from "./recordValidators";
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { fieldKinds, fileTypes, reasonings, replyModes, risks, roles, trashKinds, usageKinds, wakeOutcomes } from "@companybot/core";
import { v } from "convex/values";

/** One of `values`, each a literal. */
const oneOf = <T extends string>(values: readonly T[]) => v.union(...values.map((value) => v.literal(value)));

export const notify = v.union(v.literal("all"), v.literal("mentions"), v.literal("off"));

export const role = oneOf(roles);

export const wakeOutcome = oneOf(wakeOutcomes);

export const agentConfig = v.object({
	name: v.string(),
	description: v.string(),
	instructions: v.string(),
	model: v.string(),
	/** Unset on agents and versions saved before it existed: `defaultReasoning`. */
	reasoning: v.optional(oneOf(reasonings)),
	tools: v.array(v.string()),
});

/** A file on a message: its name, the type its bytes say it is, and (pictures) its size in pixels. */
export const fileInfo = v.object({
	name: v.string(),
	type: oneOf(fileTypes),
	size: v.number(),
	width: v.optional(v.number()),
	height: v.optional(v.number()),
});
export const attachment = v.object({ storageId: v.id("_storage"), ...fileInfo.fields });

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

export const trashKind = oneOf(trashKinds);

/** core's Risk. */
export const risk = oneOf(risks);

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
	/** What the pictures it made cost (imageGen.ts), apart from `costUsd`: they're in `usage` as kind "image", not "chat". */
	imageCostUsd: v.optional(v.number()),
	/** What its web searches cost (turns.addSearchCost), apart from `costUsd`: they're in `usage` as kind "search". */
	searchCostUsd: v.optional(v.number()),
	/** Added to the `usage` table (usage.ts). Replies from before it are counted once by migrations.usageThisMonth. */
	counted: v.optional(v.boolean()),
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
export const fieldKind = oneOf(fieldKinds);

/** core's AutomationAudience. */
export const audience = v.union(v.literal("creator"), v.literal("subscribers"), v.literal("channel"));

/** core's ModelInfo. */
export const modelInfo = v.object({
	id: v.string(),
	name: v.string(),
	provider: v.string(),
	contextWindow: v.optional(v.number()),
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	vision: v.optional(v.boolean()),
});
export const imageModelInfo = v.object({
	id: v.string(),
	name: v.string(),
	provider: v.string(),
	multimodal: v.optional(v.boolean()),
	perImage: v.optional(v.number()),
});

// Stored definitions keep retired library installs independent of shipped catalogs.
const skillDefinition = v.object({ id: v.string(), name: v.string(), description: v.string(), version: v.string(), instructions: v.string() });
const automationDefinition = v.object({
	id: v.string(), name: v.string(), description: v.string(), details: v.string(), version: v.string(), publisher: v.string(),
	connectors: v.array(v.string()), prompt: v.string(),
	trigger: v.union(
		v.object({ type: v.literal("schedule"), time: v.string(), weekdays: v.array(v.number()) }),
		v.object({ type: v.literal("event"), event: v.union(v.literal("message.posted"), v.literal("member.joined")), label: v.string(), channelId: v.optional(v.string()) }),
		v.object({ type: v.literal("webhook"), webhookEvent: v.optional(v.literal("call.ended")), label: v.string(), sample: v.object({ id: v.string(), event: v.optional(v.string()), person: v.optional(v.object({ email: v.string() })), data: v.optional(v.record(v.string(), v.any())) }) }),
	),
});

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
	// AI Gateway's models that can run an agent, and those that make pictures, one row (modelCatalog.ts).
	// `imageModels` is unset on a row from before it, until the next refresh.
	modelCatalog: defineTable({ models: v.array(modelInfo), imageModels: v.optional(v.array(imageModelInfo)), fetchedAt: v.number() }),

	workspaces: defineTable({
		name: v.string(),
		version: v.optional(v.number()),
		/** ISO 4217: the default for new amounts. Each amount stores its own. Unset means DEFAULT_CURRENCY. */
		currency: v.optional(v.string()),
		/** Whether agents read and write memories. Off keeps them, unused. Unset means on. */
		memory: v.optional(v.boolean()),
		/** What agents make pictures with (an AI Gateway model id). Unset means core's defaultImageModel. */
		imageModel: v.optional(v.string()),
		/** What decides whether agents reply in "When relevant" channels (core router.ts); unset: ROUTER_MODEL. */
		routerModel: v.optional(v.string()),
		/** USD agents may spend on pictures a month; 0 turns them off. Unset means IMAGE_BUDGET_DEFAULT_USD. */
		imageBudgetUsd: v.optional(v.number()),
		/** Hours a thread stays under its channel in the sidebar after its last reply (core `threadWindows`; 0 forever). Unset means THREAD_HOURS_DEFAULT. */
		threadHours: v.optional(v.number()),
		/** Set when an owner deletes it: every access refuses at once, then a cascade deletes its rows (lifecycle.ts). */
		deleting: v.optional(v.boolean()),
		/** Its logo (images.ts). Unset shows its initials. */
		image: v.optional(v.id("_storage")),
	}),

	members: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		role,
		/** Normalized for bounded invitation checks. Every row has it; optional only in the type. */
		email: v.optional(v.string()),
		/** The tutorial above the composer (onboarding.ts): steps done, or hidden. Unset for people who joined before it: they get none. */
		tutorial: v.optional(v.object({ done: v.array(v.string()), dismissed: v.optional(v.boolean()) })),
	})
		.index("by_user", ["userId", "workspaceId"])
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
		/** In Trash (the `trash` table says who deleted it, and when): hidden from chat, runs nothing. */
		archived: v.boolean(),
		version: v.number(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
		/** Its picture (images.ts): not part of its config, so versions and restores leave it alone. Unset shows its initials. */
		image: v.optional(v.id("_storage")),
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
		/** Who first saved it. Missing on memories from before it was kept: read as `updatedBy`. */
		createdBy: v.optional(v.id("users")),
		/** True while a team memory is in Archive (the `trash` table says who deleted it, and when); unset otherwise, which reads filter on by index. */
		archived: v.optional(v.literal(true)),
		version: v.number(),
		/** Retained for stored rows: no migration cleared this retired cleanup timestamp. */
		createdTs: v.optional(v.commitTs()),
	})
		.index("by_workspace", ["workspaceId", "archived"])
		// One person's personal memories in a workspace (team memories have no owner).
		.index("by_owner", ["ownerId", "workspaceId"])
		// Newest first within a scope, across owners (lists), or one owner's personal memories (never in Archive).
		.index("by_agent_scope", ["agentId", "scope", "archived"])
		.index("by_agent_owner", ["agentId", "scope", "ownerId"])
		// Agent search over every memory, however many (memoryOps.searchMemories).
		.searchIndex("search_content", { searchField: "content", filterFields: ["agentId", "scope", "ownerId", "archived"] }),

	// What a memory said before each edit, newest kept (MEMORY_VERSIONS_MAX), so a wrong edit can be undone.
	memoryVersions: defineTable({
		memoryId: v.id("memories"),
		/** The memory's version this content was. */
		version: v.number(),
		content: v.string(),
		/** Who saved this content, and when. */
		savedBy: v.id("users"),
		savedByAgent: v.optional(v.boolean()),
		savedAt: v.number(),
	}).index("by_memory", ["memoryId", "version"]),

	// Personal preferences: only the person sees them; they follow them across devices.
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
		/** Their photo (images.ts), shown in every workspace. Unset shows their initials. */
		image: v.optional(v.id("_storage")),
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"]),

	// Files people uploaded (images.ts), not yet attached to anything. Attaching one uses its row up;
	// rows nobody claims go after a day, with their files (images.sweepUploads).
	uploads: defineTable({
		storageId: v.id("_storage"),
		userId: v.id("users"),
		/** The workspace the app had open. */
		workspaceId: v.optional(v.id("workspaces")),
		createdAt: v.number(),
		/** Set for a file for a message (files.ts), unset for a picture; each is only claimed as its own kind. */
		file: v.optional(fileInfo),
	})
		.index("by_storage", ["storageId"])
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_created", ["createdAt"]),

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

	skillInstalls: defineTable({
		definition: v.optional(skillDefinition),
		workspaceId: v.id("workspaces"),
		skillId: v.string(),
		/** Set for skills people made (id "custom-…"); retired library ones use definition. Shared setting: versioned. */
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
		/** Skills: in Archive (the `trash` table says who deleted it, and when). Agents don't see it. */
		archived: v.optional(v.boolean()),
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
		/** DMs only: sorted participant keys ("u:<id>", "a:<id>") joined by ",", to find an existing DM. A side chat copies its parent's. */
		dmKey: v.optional(v.string()),
		/** Side chats only: a separate conversation with an agent, under the person's agent DM (`parentId`). */
		parentId: v.optional(v.id("chats")),
		/** Side chats only: what it's about, from its first message until renamed. */
		title: v.optional(v.string()),
		/** The channel everyone joins (#general). Can't be left or made private. */
		isDefault: v.optional(v.boolean()),
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		lastMessageAt: v.number(),
		/** USD spent on agent replies and summaries here (main timeline). */
		costUsd: v.optional(v.number()),
		/** Channels: when agents answer without an @mention (core router.ts). Unset is "mentions", so no migration. */
		replyMode: v.optional(oneOf(replyModes)),
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
		/** Files attached to it (files.ts), in order. Deleted with the message, or when it is. */
		attachments: v.optional(v.array(attachment)),
		/** Cards for the first links in its text (linkPreviews.ts), in text order. `hidden`: the sender took it down. */
		linkPreviews: v.optional(v.array(v.object({ previewId: v.id("linkPreviews"), hidden: v.optional(v.boolean()) }))),
		/** Who was @mentioned. Mentioned agents get a turn. `recordIds`: records the message references. `skillIds`: skills named with `/`. */
		mentions: v.object({
			userIds: v.array(v.id("users")),
			agentIds: v.array(v.id("agents")),
			recordIds: v.optional(v.array(v.id("records"))),
			skillIds: v.optional(v.array(v.string())),
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
		/** Thread parents only: the last 3 to reply, newest first. Unset on parents from before it. */
		replyAuthors: v.optional(v.array(v.object({ userId: v.optional(v.id("users")), agentId: v.optional(v.id("agents")) }))),
		/** Thread parents only: USD spent on agent replies and summaries in the thread. */
		costUsd: v.optional(v.number()),
		/** Server-written provenance. `foreign` snapshots whose words the run follows; absent on older messages, which ask. */
		automation: v.optional(v.object({ id: v.string(), name: v.string(), foreign: v.optional(v.boolean()) })),
		/** A wake turn's own reply (wakeups.ts): kept for the agent's session, never shown. The agent speaks with chat.notify. */
		quiet: v.optional(v.boolean()),
	})
		.index("by_chat_thread", ["chatId", "threadId"])
		/** Thread parents, newest reply first: the sidebar's active threads. Messages without replies have no `lastReplyAt` and sort first. */
		.index("by_chat_lastReply", ["chatId", "lastReplyAt"])
		.index("by_workspace", ["workspaceId"])
		.searchIndex("search_text", { searchField: "text", filterFields: ["workspaceId", "chatId"] }),

	// What a link looked like when we fetched it (linkUnfurl.ts), one row per URL per workspace, shared
	// by every message that posts it and refetched when a day old. The picture is our own copy.
	linkPreviews: defineTable({
		workspaceId: v.id("workspaces"),
		url: v.string(),
		/** None of these: the page had nothing to show (or couldn't be read); asked again after an hour. */
		title: v.optional(v.string()),
		description: v.optional(v.string()),
		siteName: v.optional(v.string()),
		image: v.optional(v.id("_storage")),
		fetchedAt: v.number(),
	}).index("by_workspace_url", ["workspaceId", "url"]),

	// A reply's content while it streams (turns.updateReply). Its many writes a second re-run only
	// the streaming bubble's query, not every message list; it moves onto the message when it ends.
	replyStreams: defineTable({
		messageId: v.id("chatMessages"),
		text: v.string(),
		parts: v.array(messagePart),
	}).index("by_message", ["messageId"]),

	// Who's typing where: one row per person per place (chat + thread), its `at` bumped every
	// few seconds while they type, deleted when they send. Stale after TYPING_MS (typing.ts).
	typing: defineTable({
		workspaceId: v.id("workspaces"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		userId: v.id("users"),
		at: v.number(),
	})
		.index("by_place", ["chatId", "threadId", "at"])
		.index("by_user", ["userId", "chatId", "threadId"])
		.index("by_workspace", ["workspaceId", "userId"])
		.index("by_at", ["at"]),

	// One emoji from one person or agent on one message.
	reactions: defineTable({
		messageId: v.id("chatMessages"),
		chatId: v.id("chats"),
		emoji: v.string(),
		userId: v.optional(v.id("users")),
		agentId: v.optional(v.id("agents")),
	}).index("by_message", ["messageId", "emoji", "userId", "agentId"]),

	// A person @mentioned in a message (main timeline or a thread), so unread mentions are found
	// by index however much else was said since. `at`: the message's _creationTime. Gone when it's deleted.
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
		/** The message that mentioned the agent (or any message, in an agent DM). Unset on old welcome turns, and the approvals that follow one. */
		triggerId: v.optional(v.id("chatMessages")),
		// Retired: welcomes were agent turns; now they're fixed text (onboarding.ts). migrations.clearTurnWelcome clears it.
		// COMPAT(0.1.0-alpha.9): once that has run on prod, drop this field, the migration and its test.
		welcome: v.optional(v.union(v.literal("new_workspace"), v.literal("joined"))),
		/** The agent acts as this person: their role, connector connections, and access. */
		actorId: v.id("users"),
		/** The streaming reply, once running. */
		replyId: v.optional(v.id("chatMessages")),
		/** The agent's session for this place, once running. */
		sessionId: v.optional(v.id("agentSessions")),
		/** The exact user message sent to the model this turn. Replayed as-is in later turns. */
		prompt: v.optional(v.string()),
		/** Nobody @mentioned the agent: the router queued it (router.ts). */
		routed: v.optional(v.literal(true)),
		status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error")),
		startedAt: v.optional(v.number()),
		/** Set when the turn follows a decision on this approval: it runs the call if approved, then tells the agent. */
		approvalId: v.optional(v.id("approvals")),
		/** A wake turn (wakeups.ts): its input is the wakeup, its reply is quiet, and `wakeLogId` is its line in Activity. */
		wakeupId: v.optional(v.id("wakeups")),
		wakeLogId: v.optional(v.id("agentActivity")),
		/** What its pictures cost so far (imageGen.ts), for its reply's stats. */
		imageCostUsd: v.optional(v.number()),
		/** What its web searches cost so far (turns.addSearchCost), for its reply's stats. */
		searchCostUsd: v.optional(v.number()),
		/**
		 * What its finished model calls used so far, saved after each one (turns.saveUsage) with its cost
		 * already recorded, so a turn whose action dies keeps what it paid and its stats.
		 */
		usage: v.optional(v.object({ ...replyUsage.fields, counted: v.optional(v.boolean()) })),
		/**
		 * What it's doing now, while running ("Searching records for Acme…", "Thinking…"), for the line
		 * under the composer (typing.ts). Unset while it writes, and once it ends. Never model reasoning.
		 */
		step: v.optional(v.object({ label: v.string(), at: v.number() })),
	})
		.index("by_place", ["agentId", "chatId", "threadId", "status"])
		.index("by_session", ["sessionId"])
		.index("by_workspace", ["workspaceId"])
		// Also: who's replying in a place right now (typing.ts).
		.index("by_chat", ["chatId", "threadId", "status"]),

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
		/** Unset on a wake's line until (unless) it queues a turn. */
		turnId: v.optional(v.id("agentTurns")),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		/** Unset on a wake's line: a wake turn's reply is quiet. */
		replyId: v.optional(v.id("chatMessages")),
		/** Same id as the reply's tool part, so the app can open one from the other. A wake's line: the wakeup's id. */
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
		/** One line per wake (wakeups.ts): what woke and how it went. `tool` is "wakeups.wake". */
		wake: v.optional(v.object({ wakeupId: v.id("wakeups"), outcome: wakeOutcome, reason: v.optional(v.string()) })),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_reply", ["replyId"])
		.index("by_actor", ["actorId"]),

	// An agent waking later, in a place, as a person: when (a time, maybe repeating, or a job finishing,
	// #114) and what (a note: a follow-up's task; none: look around, #162's heartbeat). One table and one
	// path to a turn (wakeups.ts `wake`) for all of them.
	wakeups: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		/** Who it runs for, with their access, read fresh at each wake. */
		actorId: v.id("users"),
		/** Who set it up: may cancel it, like the actor and owners. */
		createdBy: v.id("users"),
		/** What to do when it wakes. None: look around for anything worth doing (#162). */
		note: v.optional(v.string()),
		recordId: v.optional(v.id("records")),
		/** The record's database, so deleting one forever cancels its records' wakeups. */
		typeId: v.optional(v.id("recordTypes")),
		/** Made in a run that followed others' words: its turns ask before `inside` actions (permissions.md). */
		foreign: v.boolean(),
		/** `pending` until its last wake (or its job's) or it's cancelled; one that repeats stays pending between wakes. */
		status: v.union(v.literal("pending"), v.literal("fired"), v.literal("cancelled")),
		reason: v.optional(v.string()),
		/**
		 * When: a time (`at`; with `every` ms it's re-armed after each wake, `times` wakes in all or
		 * forever), or a job finishing (`jobId`, #114).
		 */
		at: v.optional(v.number()),
		every: v.optional(v.number()),
		times: v.optional(v.number()),
		/** Wakes so far. */
		wakes: v.optional(v.number()),
		jobId: v.optional(v.string()),
		/** A job's result (#114), JSON, for the wake turn. */
		result: v.optional(v.string()),
		/** Due while its agent, record or chat is in Archive: wakes when it's restored (trashOps). */
		held: v.optional(v.boolean()),
		/** The scheduled `fire`, so moving or cancelling it can cancel that too (best effort: `fire` re-checks). */
		scheduledId: v.optional(v.id("_scheduled_functions")),
		lastWokeAt: v.optional(v.number()),
		/** When it fired for good or was cancelled; forgotten 30 days later. */
		settledAt: v.optional(v.number()),
	})
		.index("by_workspace", ["workspaceId", "status", "at"])
		.index("by_actor", ["workspaceId", "actorId", "status"])
		.index("by_agent", ["agentId", "status"])
		.index("by_record", ["recordId", "status"])
		.index("by_type", ["typeId"])
		.index("by_chat", ["chatId"])
		.index("by_held", ["workspaceId", "held"])
		.index("by_job", ["jobId"])
		.index("by_settled", ["settledAt"]),

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
		/** Risk when it asked. Optional because old stored approvals have no backfill migration; they cannot offer Always. */
		risk: v.optional(risk),
		/** Set for automation calls, so Always grants stay scoped to that install. */
		automationInstallId: v.optional(v.id("automationInstalls")),
		/** Set when the actor chose "Always allow": a rule was saved too. */
		always: v.optional(v.boolean()),
	})
		.index("by_reply", ["replyId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_actor", ["actorId"]),

	// Automations people make and retained library installs; each picks the agent that runs it.
	automationInstalls: defineTable({
		definition: v.optional(automationDefinition),
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
		/** Who it runs for; automationAudiences backfilled existing installs in alpha.6. */
		audience,
		/** Audience "channel": post each run here, once. */
		channelId: v.optional(v.id("chats")),
		/** Who picked the channel. Library automations' channel runs act as them (or another owner if they've left); ones people make act as their maker. */
		channelSetBy: v.optional(v.id("users")),
		/** Webhook automations: the secret in their URL (`/automations/<token>`). */
		webhookToken: v.optional(v.string()),
		/** Set for automations people made (id "custom-…"); retired library ones use definition. Shared setting: versioned. */
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
		/** Automations: in Archive (the `trash` table says who deleted it, and when). Nothing triggers it. */
		archived: v.optional(v.boolean()),
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

	// ---- Databases and records. See wiki/data.md. ----

	// A database created by the team. Existing keys stay stable.
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
		/** Only standalone pages can be nested. */
		parentId: v.optional(v.id("pages")),
		/** Standalone pages only: a record's body shows the record's name. */
		title: v.string(),
		/** In Trash (the `trash` table says who deleted it, and when). */
		archived: v.boolean(),
		createdBy: v.id("users"),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
	})
		.index("by_workspace", ["workspaceId", "recordId", "archived", "title"])
		.index("by_parent", ["workspaceId", "parentId", "recordId", "archived", "title"])
		.searchIndex("search_title", { searchField: "title", filterFields: ["workspaceId", "archived"] }),

	pageMoves: defineTable({
		workspaceId: v.id("workspaces"),
		pageId: v.id("pages"),
		n: v.number(),
		userId: v.id("users"),
		agentId: v.optional(v.id("agents")),
		from: v.string(),
		to: v.string(),
	}).index("by_page", ["pageId", "n"]).index("by_workspace", ["workspaceId"]),

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

	// Pictures in a page: uploaded (pages.addImage), or pasted from another page in the workspace
	// (pageOps.adoptImages). Kept while the page is, even once out of its content, so restoring an
	// older version brings them back. The file goes with the last page that has it.
	pageImages: defineTable({ workspaceId: v.id("workspaces"), pageId: v.id("pages"), storageId: v.id("_storage"), url: v.string() })
		.index("by_page", ["pageId", "url"])
		.index("by_url", ["workspaceId", "url"])
		.index("by_storage", ["storageId"]),

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

	// What's in Archive: one row per deleted record, database, field, page, channel, agent, or skill or automation people made (trash.ts).
	// The item itself stays, `archived`, until it's restored or deleted for good: by an owner,
	// or after TRASH_DAYS by `trash.sweep`. See wiki/data.md#trash.
	trash: defineTable({
		workspaceId: v.id("workspaces"),
		kind: trashKind,
		/** The item's row id: record, database, field, page, chat, agent, or skill or automation install. */
		itemId: v.string(),
		/** Its name when deleted, for listing and search. */
		name: v.string(),
		/** Page deletion included live children, captured when it entered Trash. */
		includesSubpages: v.optional(v.boolean()),
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

	// What AI cost, by month (UTC "2026-10"): one row per person, agent, kind and model, added to by
	// `recordUsage` (usage.ts) as each paid call finishes, so the Usage screen reads a few rows, not messages.
	usage: defineTable({
		workspaceId: v.id("workspaces"),
		month: v.string(),
		/** Who it ran for. Unset for calls that ran for nobody in particular. */
		userId: v.optional(v.id("users")),
		agentId: v.optional(v.id("agents")),
		kind: oneOf(usageKinds),
		model: v.optional(v.string()),
		costUsd: v.number(),
	})
		.index("by_bucket", ["workspaceId", "month", "userId", "agentId", "kind", "model"])
		.index("by_user", ["workspaceId", "userId", "month"]),

	// A picture call's estimated cost, held against the monthly image budget while the gateway works
	// (imageGen.ts), so parallel calls can't all pass it. Settled into `usage`, or released on failure or after HOLD_MS.
	imageHolds: defineTable({ workspaceId: v.id("workspaces"), costUsd: v.number() }).index("by_workspace", ["workspaceId"]),

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
			agentId: v.optional(v.id("agents")),
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
