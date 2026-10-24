import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, query } from "./_generated/server";
import { type Namer, canSee, chatLabel, namer } from "./chatOps";
import { type Member, getMember } from "./lib";

// The activity log: every tool call an agent made, with its input and output.
// An entry is as private as the chat it happened in. Outputs can hold things only
// the person the agent acted for may see (a private channel, their own inbox), so
// only that person gets them.

/** Most entries a list returns, and most rows it reads to find them. */
const LIST_LIMIT = 100;
const SCAN_LIMIT = 1_000;

/** Written by the runner (agent.ts) as each tool call finishes. */
export const log = internalMutation({
	args: {
		turnId: v.id("agentTurns"),
		callId: v.string(),
		tool: v.string(),
		changes: v.boolean(),
		input: v.string(),
		output: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { turnId, error, ...call }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn?.replyId) return;
		await ctx.db.insert("agentActivity", {
			workspaceId: turn.workspaceId,
			agentId: turn.agentId,
			actorId: turn.actorId,
			turnId,
			chatId: turn.chatId,
			threadId: turn.threadId,
			replyId: turn.replyId,
			...call,
			...(error !== undefined && { error }),
			status: error === undefined ? "done" : "error",
		});
	},
});

/** Recent agent activity the person can see, newest first, optionally for one agent. */
export const list = query({
	args: { agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const names = namer(ctx);
		const labels = new Map<Id<"chats">, string | null>();
		const entries = [];
		const rows = await ctx.db
			.query("agentActivity")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.order("desc")
			.take(SCAN_LIMIT);
		for (const row of rows) {
			if (agentId && row.agentId !== agentId) continue;
			if (!labels.has(row.chatId)) labels.set(row.chatId, await visibleLabel(ctx, row.chatId, member, names));
			const chat = labels.get(row.chatId);
			if (!chat) continue;
			entries.push({ ...(await toEntry(row, member, names)), chat });
			if (entries.length >= LIST_LIMIT) break;
		}
		return entries;
	},
});

/** One reply's tool calls, in order, if the person can see its chat. */
export const forReply = query({
	args: { replyId: v.id("chatMessages") },
	handler: async (ctx, { replyId }) => {
		const member = await getMember(ctx);
		const reply = await ctx.db.get(replyId);
		const chat = reply && (await ctx.db.get(reply.chatId));
		if (!member || !chat || !(await canSee(ctx, chat, member))) return [];
		const names = namer(ctx);
		const rows = await ctx.db
			.query("agentActivity")
			.withIndex("by_reply", (q) => q.eq("replyId", replyId))
			.collect();
		return Promise.all(rows.map((row) => toEntry(row, member, names)));
	},
});

async function visibleLabel(ctx: QueryCtx, chatId: Id<"chats">, member: Member, names: Namer) {
	const chat = await ctx.db.get(chatId);
	return chat && (await canSee(ctx, chat, member)) ? chatLabel(ctx, chat, names, member.userId) : null;
}

async function toEntry(row: Doc<"agentActivity">, member: Member, names: Namer) {
	const mine = row.actorId === member.userId;
	return {
		_id: row._id,
		time: row._creationTime,
		agent: (await names.agent(row.agentId)).name,
		actor: (await names.user(row.actorId)).name,
		mine,
		chatId: row.chatId,
		replyId: row.replyId,
		callId: row.callId,
		tool: row.tool,
		changes: row.changes,
		status: row.status,
		input: row.input,
		/** Only for the person the agent acted for; see the note at the top. */
		output: mine ? row.output : undefined,
		error: row.error,
	};
}
