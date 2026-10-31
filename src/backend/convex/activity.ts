import { actionLabel, findConnector, toolGroup } from "@companybot/core";
import type { PaginationOptions } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation } from "./_generated/server";
import { query } from "./functions";
import { type Namer, canSee, chatLabel, namer } from "./chatOps";
import { type Member, capped, erased, getMember, liveWorkspace } from "./lib";
import { titleOf } from "./connectorTools";
import { allowedHow } from "./schema";

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
		allowed: v.optional(allowedHow),
	},
	handler: async (ctx, { turnId, error, allowed, output, ...call }) => {
		const turn = await ctx.db.get(turnId);
		// Not into a workspace being deleted: its cascade may be past this table.
		if (!turn?.replyId || !(await liveWorkspace(ctx, turn.workspaceId))) return;
		// Only the actor sees the output: once their account is erased, the call is logged without it.
		const keep = output !== undefined && !(await erased(ctx, turn.actorId));
		await ctx.db.insert("agentActivity", {
			workspaceId: turn.workspaceId,
			agentId: turn.agentId,
			actorId: turn.actorId,
			turnId,
			chatId: turn.chatId,
			threadId: turn.threadId,
			replyId: turn.replyId,
			...call,
			...(keep && { output }),
			...(error !== undefined && { error }),
			...(allowed && { allowed }),
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
			entries.push({ ...(await toEntry(ctx, row, member, names)), chat });
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
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member))) return [];
		const names = namer(ctx);
		const rows = await ctx.db
			.query("agentActivity")
			.withIndex("by_reply", (q) => q.eq("replyId", replyId))
			.collect();
		return Promise.all(rows.map((row) => toEntry(ctx, row, member, names)));
	},
});

async function visibleLabel(ctx: QueryCtx, chatId: Id<"chats">, member: Member, names: Namer) {
	const chat = await ctx.db.get(chatId);
	return chat && !chat.archived && (await canSee(ctx, chat, member)) ? chatLabel(ctx, chat, names, member.userId) : null;
}

async function toEntry(ctx: QueryCtx, row: Doc<"agentActivity">, member: Member, names: Namer) {
	const mine = row.actorId === member.userId;
	const connector = row.tool.includes(".") ? findConnector(toolGroup(row.tool)) : undefined;
	return {
		_id: row._id,
		time: row._creationTime,
		agent: (await names.agent(row.agentId)).name,
		actor: (await names.user(row.actorId)).name,
		mine,
		chatId: row.chatId,
		replyId: row.replyId ?? null,
		callId: row.callId,
		tool: row.tool,
		/** What it did, for people: "Send SMS with Fake CRM" (the same words as its tool line), or how a wake went. */
		label: row.wake ? wakeLabel(row.wake) : `${actionLabel(row.tool, await titleOf(ctx, row.workspaceId, row.tool))}${connector ? ` with ${connector.name}` : ""}`,
		wake: row.wake ? { outcome: row.wake.outcome, reason: row.wake.reason ?? null } : null,
		changes: row.changes,
		status: row.status,
		input: row.input,
		/** Only for the person the agent acted for; see the note at the top. */
		output: mine ? row.output : undefined,
		error: row.error,
		/** Calls that would have asked: who allowed it and how, and whether that rule still stands. */
		allowed: row.allowed
			? {
					how: row.allowed.how,
					by: (await names.user(row.allowed.by)).name,
					at: row.allowed.at,
					automation: row.allowed.automation ?? null,
					ruleStillOn: row.allowed.ruleId ? !!(await ctx.db.get(row.allowed.ruleId)) : null,
				}
			: null,
	};
}

/** A wake's line (wakeups.ts): "Woke up and posted a message", "Woke up, skipped: …". */
function wakeLabel({ outcome, reason }: NonNullable<Doc<"agentActivity">["wake"]>) {
	const how = { fired: "running…", skipped: "skipped", ran: "nothing to say", notified: "posted a message", failed: "failed" }[outcome];
	return `Woke up: ${how}${reason ? `. ${reason}` : ""}`;
}

/** One bounded indexed page, applying the same chat visibility and output privacy as the app. */
export async function activityPage(ctx: QueryCtx, member: Member, opts: PaginationOptions) {
	const result = await ctx.db.query("agentActivity")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.order("desc").paginate(capped(opts, 20));
	const names = namer(ctx);
	const page = [];
	for (const row of result.page) {
		const chat = await visibleLabel(ctx, row.chatId, member, names);
		if (chat) page.push({ ...(await toEntry(ctx, row, member, names)), chat });
	}
	return { ...result, page };
}
