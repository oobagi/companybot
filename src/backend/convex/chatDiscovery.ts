import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";
import { liveWorkspace } from "./lib";

/** Everyone can view: post restrictions do not make a channel private. */
export const publicSearchChat = (chat: Pick<Doc<"chats">, "kind" | "private" | "access" | "archived">) =>
	chat.kind === "channel" && !chat.private && !chat.archived && (!chat.access || chat.access.some((e) => e.role === "everyone"));

/** Idempotent for the backfill and existing seats; joining creates read state and activity separately. */
export async function ensureSeatActivity(ctx: MutationCtx, chat: Doc<"chats">, seat: Pick<Doc<"chatMembers">, "_id" | "userId">) {
	const existing = await ctx.db.query("seatActivity").withIndex("by_seat", (q) => q.eq("seatId", seat._id)).first();
	if (!existing) await ctx.db.insert("seatActivity", { workspaceId: chat.workspaceId, chatId: chat._id, seatId: seat._id, userId: seat.userId, activityAt: chat.lastMessageAt, restricted: !publicSearchChat(chat) });
}

/** Small restricted chats are immediately current. Pending large-chat sends read only one state row. */
export async function touchSeats(ctx: MutationCtx, chat: Doc<"chats">) {
	if (publicSearchChat(chat)) return;
	const state = await ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).first();
	if (state?.pendingAt !== undefined) {
		await ctx.db.patch(state._id, { activityAt: chat.lastMessageAt });
		return;
	}
	const rows = await ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).take(101);
	if (rows.length <= 100) {
		for (const row of rows) await ctx.db.patch(row._id, { activityAt: chat.lastMessageAt });
		return;
	}
	const pendingAt = Date.now();
	if (state) await ctx.db.patch(state._id, { activityAt: chat.lastMessageAt, pendingAt });
	else await ctx.db.insert("chatActivity", { workspaceId: chat.workspaceId, chatId: chat._id, activityAt: chat.lastMessageAt, pendingAt });
	await ctx.scheduler.runAfter(60_000, internal.chatDiscovery.refreshSeats, { chatId: chat._id, cursor: null, pendingAt });
}

/** Sweep a snapshot, then immediately sweep again if a send arrived while pages were running. */
export const refreshSeats = internalMutation({
	args: { chatId: v.id("chats"), cursor: v.union(v.string(), v.null()), pendingAt: v.number(), stamp: v.optional(v.number()) },
	handler: async (ctx, { chatId, cursor, pendingAt, stamp }) => {
		const state = await ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).first();
		if (!state || state.pendingAt !== pendingAt) return;
		const chat = await ctx.db.get(chatId);
		if (!chat || !(await liveWorkspace(ctx, chat.workspaceId))) return;
		if (publicSearchChat(chat)) { await ctx.db.patch(state._id, { pendingAt: undefined }); return; }
		const at = stamp ?? state.activityAt;
		const page = await ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).paginate({ cursor, numItems: 100 });
		for (const row of page.page) await ctx.db.patch(row._id, { activityAt: at });
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId, cursor: page.continueCursor, pendingAt, stamp: at });
		else if (state.activityAt !== at) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId, cursor: null, pendingAt });
		else await ctx.db.patch(state._id, { pendingAt: undefined });
	},
});

async function updateAudience(ctx: MutationCtx, chat: Doc<"chats">, rows: Doc<"seatActivity">[]) {
	const restricted = !publicSearchChat(chat);
	for (const row of rows) if (row.restricted !== restricted) await ctx.db.patch(row._id, { restricted });
}

export async function refreshAudience(ctx: MutationCtx, chat: Doc<"chats">) {
	const searchPublic = publicSearchChat(chat);
	await ctx.db.patch(chat._id, { searchPublic });
	const messages = await ctx.db.query("chatMessages").withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id)).take(101);
	for (const message of messages.slice(0, 100)) if (message.searchPublic !== searchPublic) await ctx.db.patch(message._id, { searchPublic });
	if (messages.length > 100) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshMessages, { chatId: chat._id, cursor: null });
	const rows = await ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).take(101);
	await updateAudience(ctx, chat, rows.slice(0, 100));
	if (rows.length > 100) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeatAudience, { chatId: chat._id, cursor: null });
	if (!searchPublic) await touchSeats(ctx, chat);
}

export const refreshSeatAudience = internalMutation({
	args: { chatId: v.id("chats"), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { chatId, cursor }) => {
		const chat = await ctx.db.get(chatId);
		if (!chat || !(await liveWorkspace(ctx, chat.workspaceId))) return;
		const page = await ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).paginate({ cursor, numItems: 100 });
		await updateAudience(ctx, chat, page.page);
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeatAudience, { chatId, cursor: page.continueCursor });
	},
});

/** Reindex history after access changes. Live permission/source checks remain authoritative during fan-out. */
export const refreshMessages = internalMutation({
	args: { chatId: v.id("chats"), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { chatId, cursor }) => {
		const chat = await ctx.db.get(chatId);
		if (!chat) return;
		const searchPublic = publicSearchChat(chat);
		await ctx.db.patch(chatId, { searchPublic });
		const page = await ctx.db.query("chatMessages").withIndex("by_chat_thread", (q) => q.eq("chatId", chatId)).paginate({ cursor, numItems: 100 });
		for (const message of page.page) if (message.searchPublic !== searchPublic) await ctx.db.patch(message._id, { searchPublic });
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshMessages, { chatId, cursor: page.continueCursor });
	},
});
