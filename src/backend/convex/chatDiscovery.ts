import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";

/** Everyone can view: post restrictions do not make a channel private. */
export const publicSearchChat = (chat: Pick<Doc<"chats">, "kind" | "private" | "access" | "archived">) =>
	chat.kind === "channel" && !chat.private && !chat.archived && (!chat.access || chat.access.some((e) => e.role === "everyone"));

/** Small chats update inline. Only large fan-outs need scheduled continuation. */
export async function touchSeats(ctx: MutationCtx, chat: Doc<"chats">) {
	const seats = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).take(101);
	for (const seat of seats.slice(0, 100)) await ctx.db.patch(seat._id, { activityAt: chat.lastMessageAt, restricted: !publicSearchChat(chat) });
	if (seats.length > 100) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId: chat._id, cursor: null });
}

export async function refreshAudience(ctx: MutationCtx, chat: Doc<"chats">) {
	const searchPublic = publicSearchChat(chat);
	await ctx.db.patch(chat._id, { searchPublic });
	const messages = await ctx.db.query("chatMessages").withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id)).take(101);
	for (const message of messages.slice(0, 100)) if (message.searchPublic !== searchPublic) await ctx.db.patch(message._id, { searchPublic });
	if (messages.length > 100) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshMessages, { chatId: chat._id, cursor: null });
	await touchSeats(ctx, chat);
}

/** Bounded fan-out, reading current state on every page so stale scheduled jobs cannot undo newer changes. */
export const refreshSeats = internalMutation({
	args: { chatId: v.id("chats"), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { chatId, cursor }) => {
		const chat = await ctx.db.get(chatId);
		if (!chat) return;
		const page = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chatId)).paginate({ cursor, numItems: 100 });
		for (const seat of page.page) await ctx.db.patch(seat._id, { activityAt: chat.lastMessageAt, restricted: !publicSearchChat(chat) });
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId, cursor: page.continueCursor });
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
