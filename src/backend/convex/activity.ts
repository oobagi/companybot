import { actionLabel, toolGroup } from "@companybot/core";
import { connectorIn } from "./connectorAccess";
import type { PaginationOptions } from "convex/server";
import { type ObjectType, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { query } from "./functions";
import { type Namer, canSee, chatLabel, namer, recentVisibleChats } from "./chatOps";
import { titleOf } from "./connectorTools";
import { type Member, capped, erased, getMember, liveWorkspace } from "./lib";
import { canReadReplyDetails, canReadSources, readReplyDetails } from "./replyPrivacy";
import { inheritPlaces } from "./replySources";
import { allowedHow } from "./schema";

// The activity log: every tool call an agent made, with its input and output.
// An entry follows its reply's source audience as well as its chat. Outputs can hold things only
// the person the agent acted for may see (a private channel, their own inbox), so
// only that person gets them.

/** Most entries returned, and read per accessible chat or actor. */
const LIST_LIMIT = 100;

/** Written by the runner (agent.ts) as each tool call finishes. */
const logArgs = {
	turnId: v.id("agentTurns"),
	callId: v.string(),
	tool: v.string(),
	changes: v.boolean(),
	input: v.string(),
	output: v.optional(v.string()),
	error: v.optional(v.string()),
	allowed: v.optional(allowedHow),
};

export const log = internalMutation({
	args: logArgs,
	handler: (ctx, args) => logCall(ctx, args),
});

/** Logs one finished call. Also run inside an approved call's own write (approvals.ts `withReceipt`), so the line can't go missing. */
export async function logCall(ctx: MutationCtx, { turnId, error, allowed, output, ...call }: ObjectType<typeof logArgs>) {
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
}

/** One bounded history read, shared by the old array API and the screen's status API. */
async function recentActivity(ctx: QueryCtx, member: Member, agentId?: Id<"agents">) {
	const names = namer(ctx);
	const labels = new Map<Id<"chats">, string | null>();
	const replies = new Map<Id<"chatMessages">, boolean>();
	const discovery = await recentVisibleChats(ctx, member);
	const entries = new Map<string, Awaited<ReturnType<typeof toEntry>> & { chat: string }>();
	let remaining = 1200;
	let truncated = discovery.truncated;
	// Continue beyond masked replies, up to a shared read budget. A full batch never
	// means exhaustion: the status API tells the screen when unread history remains.
	for (const chatId of [null, ...discovery.chats.map((chat) => chat._id)]) {
		let before = Infinity;
		let visible = 0;
		while (visible < LIST_LIMIT && remaining > 0) {
			const count = Math.min(50, remaining);
			const rows = await (chatId
				? ctx.db.query("agentActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId).lt("_creationTime", before))
				: ctx.db.query("agentActivity").withIndex("by_workspace_actor", (q) => q.eq("workspaceId", member.workspaceId).eq("actorId", member.userId).lt("_creationTime", before))
			).order("desc").take(count);
			remaining -= rows.length;
			for (const row of rows) {
				if (agentId && row.agentId !== agentId) continue;
				if (!labels.has(row.chatId)) labels.set(row.chatId, await visibleLabel(ctx, row.chatId, member, names));
				const chat = labels.get(row.chatId);
				if (!chat) continue;
				if (row.replyId && !replies.has(row.replyId)) replies.set(row.replyId, await visibleReply(ctx, row, member));
				if (!(row.replyId ? replies.get(row.replyId) : await visibleReply(ctx, row, member))) continue;
				visible++;
				if (!entries.has(row._id)) entries.set(row._id, { ...(await toEntry(ctx, row, member, names)), chat });
			}
			if (rows.length < count) break;
			before = rows[rows.length - 1]!._creationTime;
			if (!remaining) truncated = true;
		}
		if (!remaining) { truncated = true; break; }
	}
	return { entries: [...entries.values()].sort((a, b) => b.time - a.time).slice(0, LIST_LIMIT), truncated, budgetExhausted: remaining === 0 };
}

/** Kept for installed clients expecting an array; both APIs use the same bounded read. */
export const list = query({
	args: { agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const result = await recentActivity(ctx, member, agentId);
		return result.entries;
	},
});
export const recent = query({
	args: { agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		return member ? recentActivity(ctx, member, agentId) : { entries: [], truncated: false, budgetExhausted: false };
	},
});

/** One reply's tool calls, in order, if the person can see its chat. */
export const forReply = query({
	args: { replyId: v.id("chatMessages") },
	handler: async (ctx, { replyId }) => {
		const member = await getMember(ctx);
		const reply = await ctx.db.get(replyId);
		const chat = reply && (await ctx.db.get(reply.chatId));
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member)) || !(await canReadReplyDetails(ctx, member, reply!))) return [];
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
	const connector = row.tool.includes(".") ? await connectorIn(ctx, member.workspaceId, toolGroup(row.tool)) : undefined;
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
		// Skill proposals may contain private instructions, even before the write is refused.
		input: !mine && (row.tool === "skills.create" || row.tool === "skills.edit") ? "{}" : row.input,
		/** Only for the person the agent acted for; see the note at the top. */
		output: mine ? row.output : undefined,
		error: !mine && (row.tool === "skills.create" || row.tool === "skills.edit") ? undefined : row.error,
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

/** One bounded indexed page. Masked rows can make a page empty, but its continuation
 * cursor is preserved and isDone stays false: consumers can keep advancing without
 * rereading or skipping history. Unlike the recent list this API is explicitly paginated. */
export async function activityPage(ctx: QueryCtx, member: Member, opts: PaginationOptions) {
	const result = await ctx.db.query("agentActivity")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.order("desc").paginate(capped(opts, 20));
	const names = namer(ctx);
	const page = [];
	for (const row of result.page) {
		const chat = await visibleLabel(ctx, row.chatId, member, names);
		if (chat && await visibleReply(ctx, row, member)) {
			if (row.replyId) await readReplyDetails(ctx, member, await ctx.db.get(row.replyId));
			else if (row.wake) await inheritPlaces(ctx, member, (await ctx.db.get(row.wake.wakeupId))?.usedPlaces);
			page.push({ ...(await toEntry(ctx, row, member, names)), chat });
		}
	}
	return { ...result, page };
}

async function visibleReply(ctx: QueryCtx, row: Doc<"agentActivity">, member: Member) {
	const reply = row.replyId && await ctx.db.get(row.replyId);
	if (row.replyId) return !!reply && await canReadReplyDetails(ctx, member, reply);
	if (row.wake) {
		const wakeup = await ctx.db.get(row.wake.wakeupId);
		if (!wakeup) return row.actorId === member.userId;
		if (!(await canReadSources(ctx, member, wakeup.usedPlaces))) return false;
	}
	return row.wake ? true : row.actorId === member.userId;
}
