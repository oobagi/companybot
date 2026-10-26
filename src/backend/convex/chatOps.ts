import { describeWidget } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, getMember, memberOf, nameOf } from "./lib";

// Shared by the app's chat functions (chats.ts, messages.ts) and the agent runner
// (turns.ts), so both follow the same visibility rules. See wiki/chat.md.

/** A person or agent, display-ready. Fits core's `Participant`. */
export type Participant = { type: "user"; id: Id<"users">; name: string } | { type: "agent"; id: Id<"agents">; name: string };

/** Finds a DM by who's in it: sorted "u:<id>" / "a:<id>" keys joined by ",". */
export const dmKeyOf = (userIds: Id<"users">[], agentIds: Id<"agents">[]) =>
	[...new Set([...userIds.map((id) => `u:${id}`), ...agentIds.map((id) => `a:${id}`)])].sort().join(",");

/** The agent in an agent DM (exactly one person and one agent), else null. */
export function agentOfDm(chat: Doc<"chats">): Id<"agents"> | null {
	if (chat.kind !== "dm" || !chat.dmKey) return null;
	const keys = chat.dmKey.split(",");
	const agents = keys.filter((k) => k.startsWith("a:"));
	return agents.length === 1 && keys.length === 2 ? (agents[0]!.slice(2) as Id<"agents">) : null;
}

/** Lowercase, dashes for spaces, no "#". Empty if nothing usable is left. */
export const normalizeChannelName = (name: string) =>
	name
		.trim()
		.toLowerCase()
		.replace(/^#+/, "")
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);

export const chatMembersOf = (ctx: QueryCtx, chatId: Id<"chats">) =>
	ctx.db
		.query("chatMembers")
		.withIndex("by_chat", (q) => q.eq("chatId", chatId))
		.collect();

export const membership = (ctx: QueryCtx, chatId: Id<"chats">, userId: Id<"users">) =>
	ctx.db
		.query("chatMembers")
		.withIndex("by_user", (q) => q.eq("userId", userId).eq("chatId", chatId))
		.first();

/** Public channels are open to the whole workspace; private channels and DMs to their members. */
export async function canSee(ctx: QueryCtx, chat: Doc<"chats">, member: Member) {
	if (chat.workspaceId !== member.workspaceId) return false;
	if (chat.kind === "channel" && !chat.private) return true;
	return !!(await membership(ctx, chat._id, member.userId));
}

/** A channel by name ("#sales" or "sales") that the person can see. */
export async function channelNamed(ctx: QueryCtx, member: Member, name: string) {
	const clean = name.trim().replace(/^#/, "").toLowerCase();
	const chat = await ctx.db
		.query("chats")
		.withIndex("by_name", (q) => q.eq("workspaceId", member.workspaceId).eq("name", clean))
		.first();
	return chat && chat.kind === "channel" && !chat.archived && (await canSee(ctx, chat, member)) ? chat : null;
}

/** You and the chat, if you can see it. For queries, which show nothing rather than fail. */
export async function visibleChat(ctx: QueryCtx, chatId: Id<"chats">) {
	const member = await getMember(ctx);
	const chat = member && (await ctx.db.get(chatId));
	if (!member || !chat || !(await canSee(ctx, chat, member))) return null;
	return { member, chat };
}

/** A chat the person can see. Others look like they don't exist. */
export async function requireChat(ctx: QueryCtx, member: Member, chatId: Id<"chats">) {
	const chat = await ctx.db.get(chatId);
	if (!chat || !(await canSee(ctx, chat, member))) throw new ConvexError("Chat not found.");
	return chat;
}

/** Adds a person or agent if they aren't in yet. New people start with everything read. */
export async function addToChat(ctx: MutationCtx, chat: Doc<"chats">, who: { userId?: Id<"users">; agentId?: Id<"agents"> }) {
	const existing = who.userId
		? await membership(ctx, chat._id, who.userId)
		: await ctx.db
				.query("chatMembers")
				.withIndex("by_agent", (q) => q.eq("agentId", who.agentId).eq("chatId", chat._id))
				.first();
	if (existing) return;
	await ctx.db.insert("chatMembers", {
		chatId: chat._id,
		workspaceId: chat.workspaceId,
		...who,
		...(who.userId && { lastReadAt: Date.now() }),
	});
}

/** Sets the person's `lastReadAt` to now, if they're in the chat. */
export async function markChatRead(ctx: MutationCtx, chatId: Id<"chats">, userId: Id<"users">) {
	const row = await membership(ctx, chatId, userId);
	if (row) await ctx.db.patch(row._id, { lastReadAt: Date.now() });
}

/** The workspace's #general, created if missing. */
export async function ensureGeneral(ctx: MutationCtx, workspaceId: Id<"workspaces">, createdBy: Id<"users">) {
	const existing = await ctx.db
		.query("chats")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("kind", "channel"))
		.filter((q) => q.eq(q.field("isDefault"), true))
		.first();
	if (existing) return existing;
	const id = await ctx.db.insert("chats", {
		workspaceId,
		kind: "channel",
		name: "general",
		topic: "Everyone in the workspace.",
		private: false,
		isDefault: true,
		archived: false,
		createdBy,
		lastMessageAt: Date.now(),
	});
	return (await ctx.db.get(id))!;
}

/** Refuses people outside the workspace. */
export async function requireWorkspaceUsers(ctx: QueryCtx, workspaceId: Id<"workspaces">, userIds: Id<"users">[]) {
	for (const id of userIds) {
		if (!(await memberOf(ctx, id, workspaceId))) throw new ConvexError("Someone you picked isn't in this workspace.");
	}
}

/** Refuses agents that are archived or from another workspace. */
export async function requireActiveAgents(ctx: QueryCtx, workspaceId: Id<"workspaces">, agentIds: Id<"agents">[]) {
	for (const id of agentIds) {
		const agent = await ctx.db.get(id);
		if (!agent || agent.workspaceId !== workspaceId || agent.archived) throw new ConvexError("That agent isn't available.");
	}
}

/** The DM between exactly these people and agents, created if it doesn't exist yet. */
export async function findOrCreateDm(
	ctx: MutationCtx,
	workspaceId: Id<"workspaces">,
	createdBy: Id<"users">,
	userIds: Id<"users">[],
	agentIds: Id<"agents">[],
): Promise<Id<"chats">> {
	const dmKey = dmKeyOf(userIds, agentIds);
	const existing = await ctx.db
		.query("chats")
		.withIndex("by_dm_key", (q) => q.eq("workspaceId", workspaceId).eq("dmKey", dmKey))
		.first();
	if (existing) return existing._id;
	const chatId = await ctx.db.insert("chats", {
		workspaceId,
		kind: "dm",
		private: true,
		dmKey,
		archived: false,
		createdBy,
		lastMessageAt: Date.now(),
	});
	const chat = (await ctx.db.get(chatId))!;
	for (const userId of userIds) await addToChat(ctx, chat, { userId });
	for (const agentId of agentIds) await addToChat(ctx, chat, { agentId });
	return chatId;
}

/**
 * Stores a message and updates its place: the chat's `lastMessageAt` for the main
 * timeline, the parent's reply count for a thread.
 */
export async function insertMessage(
	ctx: MutationCtx,
	chat: Doc<"chats">,
	message: Omit<Doc<"chatMessages">, "_id" | "_creationTime" | "chatId" | "workspaceId">,
) {
	const id = await ctx.db.insert("chatMessages", { chatId: chat._id, workspaceId: chat.workspaceId, ...message });
	const now = Date.now();
	if (message.threadId) {
		const parent = await ctx.db.get(message.threadId);
		if (parent) await ctx.db.patch(parent._id, { replyCount: (parent.replyCount ?? 0) + 1, lastReplyAt: now });
	} else await ctx.db.patch(chat._id, { lastMessageAt: now });
	return id;
}

/** Your newest mention in a chat's main timeline after `since`, if any. */
export const latestMentionSince = (ctx: QueryCtx, chatId: Id<"chats">, userId: Id<"users">, since: number) =>
	ctx.db
		.query("userMentions")
		.withIndex("by_user_chat", (q) => q.eq("userId", userId).eq("chatId", chatId).gt("at", since))
		.order("desc")
		.first();

/**
 * Records who a main-timeline message mentions (see userMentions), or `slice` of them.
 * Skips anyone already recorded, so it's safe to re-run.
 */
export async function addUserMentions(ctx: MutationCtx, message: Doc<"chatMessages">, slice?: { from: number; to: number }) {
	if (message.threadId || message.deleted) return;
	const userIds = [...new Set(message.mentions.userIds)].slice(slice?.from, slice?.to);
	for (const userId of userIds) {
		const existing = await ctx.db
			.query("userMentions")
			.withIndex("by_message", (q) => q.eq("messageId", message._id).eq("userId", userId))
			.first();
		if (!existing) await ctx.db.insert("userMentions", { userId, chatId: message.chatId, messageId: message._id, at: message._creationTime });
	}
}

export async function removeUserMentions(ctx: MutationCtx, messageId: Id<"chatMessages">) {
	for (const row of await ctx.db.query("userMentions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect()) {
		await ctx.db.delete(row._id);
	}
}

export const reactionsOf = (ctx: QueryCtx, messageId: Id<"chatMessages">) =>
	ctx.db
		.query("reactions")
		.withIndex("by_message", (q) => q.eq("messageId", messageId))
		.collect();

/** Toggles one person's or agent's reaction. Returns whether it's now on. */
export async function toggleReaction(
	ctx: MutationCtx,
	message: Doc<"chatMessages">,
	emoji: string,
	who: { userId: Id<"users"> } | { agentId: Id<"agents"> },
) {
	const existing = (
		await ctx.db
			.query("reactions")
			.withIndex("by_message", (q) => q.eq("messageId", message._id).eq("emoji", emoji))
			.collect()
	).find((r) => ("userId" in who ? r.userId === who.userId : r.agentId === who.agentId));
	if (existing) {
		await ctx.db.delete(existing._id);
		return false;
	}
	await ctx.db.insert("reactions", { messageId: message._id, chatId: message.chatId, emoji, ...who });
	return true;
}

/** Display names for people and agents, cached for one query. */
export function namer(ctx: QueryCtx) {
	const cache = new Map<string, Promise<string>>();
	const cached = (id: string, load: () => Promise<string>) => {
		if (!cache.has(id)) cache.set(id, load());
		return cache.get(id)!;
	};
	const user = async (id: Id<"users">): Promise<Participant> => ({
		type: "user",
		id,
		name: await cached(id, () => nameOf(ctx, id)),
	});
	const agent = async (id: Id<"agents">): Promise<Participant> => ({
		type: "agent",
		id,
		name: await cached(id, async () => (await ctx.db.get(id))?.name ?? "Agent"),
	});
	/** A member row or message author: a person or an agent. */
	const of = (row: { userId?: Id<"users">; agentId?: Id<"agents"> } | { authorUserId?: Id<"users">; authorAgentId?: Id<"agents"> }) => {
		const userId = "authorUserId" in row ? row.authorUserId : "userId" in row ? row.userId : undefined;
		const agentId = "authorAgentId" in row ? row.authorAgentId : "agentId" in row ? row.agentId : undefined;
		return userId ? user(userId) : agent(agentId!);
	};
	return { user, agent, of };
}

export type Namer = ReturnType<typeof namer>;

/** "#sales", or "DM with Ada, Ben" (everyone but `except`). */
export async function chatLabel(ctx: QueryCtx, chat: Doc<"chats">, names: Namer, except?: string) {
	if (chat.kind === "channel") return `#${chat.name}`;
	const members = await Promise.all((await chatMembersOf(ctx, chat._id)).map(names.of));
	const others = members.filter((m) => m.id !== except).map((m) => m.name);
	return `DM with ${others.join(", ") || "yourself"}`;
}

/**
 * An agent's own past reply as it replays in its session: the text, widget notes, and
 * the tools it used. Without the tools, the agent can't tell later that it really did act.
 */
export function replyForModel(m: Doc<"chatMessages">) {
	const tools = m.parts.flatMap((p) => (p.type === "tool" ? [`${p.name} (${p.status === "error" ? "failed" : "done"})`] : []));
	// Held calls are noted without their outcome, so this text never changes once the reply is done (prompt caching).
	const held = m.parts.flatMap((p) => (p.type === "approval" ? [p.tool] : []));
	return [
		textForModel(m),
		tools.length > 0 && `[Tools you used: ${tools.join(", ")}]`,
		held.length > 0 && `[Held for approval: ${held.join(", ")}]`,
	]
		.filter(Boolean)
		.join("\n");
}

/** A message's text plus a note for each widget it showed, for agents. */
export function textForModel(m: Doc<"chatMessages">, who = "You") {
	const widgets = m.parts.flatMap((p) => (p.type === "widget" ? [describeWidget(p.widget, who)] : []));
	return [m.text, ...widgets].filter(Boolean).join("\n");
}
