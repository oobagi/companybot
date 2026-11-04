import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";

/** Everyone can view: post restrictions do not make a channel private. */
export const publicSearchChat = (chat: Pick<Doc<"chats">, "kind" | "private" | "access" | "archived">) =>
	chat.kind === "channel" && !chat.private && !chat.archived && (!chat.access || chat.access.some((e) => e.role === "everyone"));

const SEAT_ACTIVITY_INTERVAL = 60_000;

/** Visibility changes update the audience immediately; activity writes are at most once a minute per seat. */
async function updateSeat(ctx: MutationCtx, chat: Doc<"chats">, seat: Doc<"chatMembers">) {
	const restricted = !publicSearchChat(chat);
	const patch: Partial<Pick<Doc<"chatMembers">, "activityAt" | "restricted">> = {};
	if (seat.restricted !== restricted) patch.restricted = restricted;
	if (restricted && (seat.activityAt === undefined || chat.lastMessageAt - seat.activityAt >= SEAT_ACTIVITY_INTERVAL)) patch.activityAt = chat.lastMessageAt;
	if (!Object.keys(patch).length) return false;
	await ctx.db.patch(seat._id, patch);
	return true;
}

/** Public messages never read/write seats. Restricted activity is throttled; only changed batches fan out. */
export async function touchSeats(ctx: MutationCtx, chat: Doc<"chats">, audience = false) {
	if (publicSearchChat(chat) && !audience) return;
	const seats = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).take(101);
	let changed = false;
	for (const seat of seats.slice(0, 100)) changed = (await updateSeat(ctx, chat, seat)) || changed;
	if (seats.length > 100 && (changed || audience)) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId: chat._id, cursor: null, audience });
}

export async function refreshAudience(ctx: MutationCtx, chat: Doc<"chats">) {
	const searchPublic = publicSearchChat(chat);
	await ctx.db.patch(chat._id, { searchPublic });
	const messages = await ctx.db.query("chatMessages").withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id)).take(101);
	for (const message of messages.slice(0, 100)) if (message.searchPublic !== searchPublic) await ctx.db.patch(message._id, { searchPublic });
	if (messages.length > 100) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshMessages, { chatId: chat._id, cursor: null });
	await touchSeats(ctx, chat, true);
}

/** Bounded fan-out, reading current state on every page so stale scheduled jobs cannot undo newer changes. */
export const refreshSeats = internalMutation({
	args: { chatId: v.id("chats"), cursor: v.union(v.string(), v.null()), audience: v.optional(v.boolean()) },
	handler: async (ctx, { chatId, cursor, audience }) => {
		const chat = await ctx.db.get(chatId);
		if (!chat || (publicSearchChat(chat) && !audience)) return;
		const page = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chatId)).paginate({ cursor, numItems: 100 });
		for (const seat of page.page) await updateSeat(ctx, chat, seat);
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.chatDiscovery.refreshSeats, { chatId, cursor: page.continueCursor, audience });
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
