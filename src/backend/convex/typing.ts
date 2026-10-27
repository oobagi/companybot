import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { type Participant, chatMembersOf, namer, requireChat, visibleChat } from "./chatOps";
import { mutation, query } from "./functions";
import { requireMember } from "./lib";

// Typing indicators. The app calls `ping` at most every TYPING_PING_MS while someone types;
// a row older than TYPING_MS no longer counts. Like Discord's, there's no "stopped typing":
// it runs out, or sending clears it. Agents type while their turn runs. See wiki/chat.md.

/** How often the app pings while someone types. */
export const TYPING_PING_MS = 4_000;
/** How long a ping counts. A little over the ping interval, so steady typing never flickers. */
export const TYPING_MS = 6_000;

const place = { chatId: v.id("chats"), threadId: v.optional(v.id("chatMessages")) };

/** You're typing here. */
export const ping = mutation({
	args: place,
	handler: async (ctx, { chatId, threadId }) => {
		const member = await requireMember(ctx);
		const chat = await requireChat(ctx, member, chatId);
		if (chat.archived) return;
		const row = await rowOf(ctx, chatId, threadId, member.userId);
		if (row) await ctx.db.patch(row._id, { at: Date.now() });
		else await ctx.db.insert("typing", { workspaceId: member.workspaceId, chatId, threadId, userId: member.userId, at: Date.now() });
	},
});

/**
 * Who's typing here, you left out: people with their last ping (the app hides ones older than
 * TYPING_MS; a query can't, since it doesn't re-run as time passes), and agents replying now.
 */
export const list = query({
	args: place,
	handler: async (ctx, { chatId, threadId }): Promise<{ people: (Participant & { at: number })[]; agents: Participant[] }> => {
		const visible = await visibleChat(ctx, chatId);
		if (!visible) return { people: [], agents: [] };
		const names = namer(ctx);
		const rows = await ctx.db
			.query("typing")
			.withIndex("by_place", (q) => q.eq("chatId", chatId).eq("threadId", threadId))
			.take(20);
		const people = await Promise.all(
			rows.filter((r) => r.userId !== visible.member.userId).map(async (r) => ({ ...(await names.user(r.userId)), at: r.at })),
		);
		const agents: Participant[] = [];
		for (const seat of await chatMembersOf(ctx, chatId)) {
			if (!seat.agentId) continue;
			const running = await ctx.db
				.query("agentTurns")
				.withIndex("by_place", (q) => q.eq("agentId", seat.agentId!).eq("chatId", chatId).eq("threadId", threadId).eq("status", "running"))
				.first();
			if (running) agents.push(await names.agent(seat.agentId));
		}
		return { people, agents };
	},
});

/** Sending a message ends your typing there. */
export async function stopTyping(ctx: MutationCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined, userId: Id<"users">) {
	const row = await rowOf(ctx, chatId, threadId, userId);
	if (row) await ctx.db.delete(row._id);
}

const rowOf = (ctx: MutationCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined, userId: Id<"users">) =>
	ctx.db
		.query("typing")
		.withIndex("by_place", (q) => q.eq("chatId", chatId).eq("threadId", threadId).eq("userId", userId))
		.first();

/** Runs hourly (crons.ts): deletes rows from people who typed and never sent. */
export const forgetStale = internalMutation({
	args: {},
	handler: async (ctx) => {
		const stale = await ctx.db
			.query("typing")
			.withIndex("by_at", (q) => q.lt("at", Date.now() - TYPING_MS))
			.take(500);
		for (const row of stale) await ctx.db.delete(row._id);
		if (stale.length === 500) await ctx.scheduler.runAfter(0, internal.typing.forgetStale);
	},
});
