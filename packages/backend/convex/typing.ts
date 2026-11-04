import { TYPING_MS } from "@companybot/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Participant, agentOfDm, namer, requireChat, visibleChat } from "./chatOps";
import { requireMember, sweepExpired } from "./lib";
import { canReadReply } from "./replyPrivacy";
import { STALE_TURN_MS, canStopTurn } from "./turns";

// Typing indicators: who's typing in a place (chat + thread). Timing rules: core typing.ts.
// Agents show while their turn runs, with its current step (agentTurns.step, set by agent.ts),
// so a run that posts nothing still shows what it's doing. See wiki/chat.md.

/** Most typists one place shows. */
const SHOWN_MAX = 10;

const place = { chatId: v.id("chats"), threadId: v.optional(v.id("chatMessages")) };

/** You're typing here. Ignored where nobody could see it: an agent DM, or a thread that isn't one. */
export const ping = mutation({
	args: place,
	handler: async (ctx, { chatId, threadId }) => {
		const member = await requireMember(ctx);
		const chat = await requireChat(ctx, member, chatId);
		if (chat.archived || agentOfDm(chat)) return;
		if (threadId) {
			const parent = await ctx.db.get(threadId);
			if (!parent || parent.chatId !== chatId || parent.threadId) return;
		}
		const row = await rowOf(ctx, chatId, threadId, member.userId);
		if (row) await ctx.db.patch(row._id, { at: Date.now() });
		else await ctx.db.insert("typing", { workspaceId: member.workspaceId, chatId, threadId, userId: member.userId, at: Date.now() });
	},
});

/**
 * Who's typing here, you left out: people who pinged in the last TYPING_MS, and agents working
 * now with their step ("Searching records for Acme…"; null while they write). A query doesn't
 * re-run as time passes, so the app also expires people itself.
 */
export const list = query({
	args: place,
	handler: async (
		ctx,
		{ chatId, threadId },
	): Promise<{ people: (Participant & { at: number })[]; agents: (Participant & { step: string | null; turnId: Id<"agentTurns">; canStop: boolean; stopping: boolean })[] }> => {
		const visible = await visibleChat(ctx, chatId);
		if (!visible) return { people: [], agents: [] };
		// Pictures for the agents' avatars on the line.
		const names = namer(ctx, { images: true });
		const now = Date.now();
		const rows = await ctx.db
			.query("typing")
			.withIndex("by_place", (q) => q.eq("chatId", chatId).eq("threadId", threadId).gt("at", now - TYPING_MS))
			.take(SHOWN_MAX + 1);
		const people = await Promise.all(
			rows.filter((r) => r.userId !== visible.member.userId).map(async (r) => ({ ...(await names.user(r.userId)), at: r.at })),
		);
		// A turn stuck running (its action died) is failed only when the next one starts: don't show it forever.
		const running = await ctx.db
			.query("agentTurns")
			.withIndex("by_chat", (q) => q.eq("chatId", chatId).eq("threadId", threadId).eq("status", "running"))
			.take(SHOWN_MAX);
		const agents = await Promise.all(
			running
				.filter((t) => now - (t.startedAt ?? t._creationTime) < STALE_TURN_MS)
				// "Thinking…" or its step until its message starts (any turn may post nothing), then "typing".
				// Stop (turns.stop): for the person it works for, or anyone with turns.stopAny.
				.map(async (t) => {
					const reply = t.replyId && await ctx.db.get(t.replyId);
					return {
					...(await names.agent(t.agentId)),
					step: reply && !(await canReadReply(ctx, visible.member, reply)) ? "Private reply" : t.step?.label ?? null,
					turnId: t._id,
					canStop: canStopTurn(visible.member, t),
					stopping: !!t.stopping,
				};
				}),
		);
		return { people: people.slice(0, SHOWN_MAX), agents };
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
		.withIndex("by_user", (q) => q.eq("userId", userId).eq("chatId", chatId).eq("threadId", threadId))
		.first();

/** Runs hourly (crons.ts): deletes rows from people who typed and never sent. */
export const forgetStale = internalMutation({
	args: {},
	handler: async (ctx) => {
		const stale = ctx.db.query("typing").withIndex("by_at", (q) => q.lt("at", Date.now() - TYPING_MS));
		await sweepExpired(ctx, stale, (row) => ctx.db.delete(row._id), internal.typing.forgetStale);
	},
});
