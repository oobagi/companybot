import {
	FOLLOWUPS_PER_AGENT,
	FOLLOWUPS_PER_RECORD,
	type FollowupInput,
	type FollowupSummary,
	NOTIFY_MAX,
	type WakeOutcome,
	can,
	followupNoteError,
	followupTime,
	followupWhen,
	nextRepeat,
	repeatEvery,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { mutation, query } from "./functions";
import { addToChat, canSee, chatLabel, insertMessage, namer } from "./chatOps";
import { type Member, asToolResult, getMember, liveWorkspace, memberOf, nameOf, requireMember, sweepExpired, timeZoneOf } from "./lib";
import { automationScope } from "./automationOps";
import { recordById } from "./recordOps";
import { enqueueTurn, runningTurn } from "./turns";

// Wakeups: an agent wakes later in a place (chat + thread), acting for a person. A wakeup is when
// plus what. When: a time (`at`, through the scheduler; with `every` it's re-armed after each wake,
// `times` wakes in all or forever) or a job (`jobId`: #114 calls `wake` with its result). What: a
// note (a follow-up's task) or none (look around: #162's heartbeat). `wake` is the only path from
// one to a turn. The turn is quiet: its reply is never shown, and the agent speaks with chat.notify.
// Each wake writes one line in Activity. See wiki/architecture.md (Automations).

/** Fired and cancelled wakeups are forgotten this long after. */
export const SETTLED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Most pending wakeups a list returns. */
const LIST_MAX = 200;

type Gate = (ctx: MutationCtx, row: Doc<"wakeups">) => Promise<string | null>;
/**
 * Checked before a note-less wakeup (look around) queues its turn: a reason skips this wake, and its
 * Activity line says why. None yet; #162 adds the heartbeat's (busy or off hours, digest, triage).
 */
const lookAroundGate: Gate | undefined = undefined;

type NewWakeup = Pick<Doc<"wakeups">, "workspaceId" | "agentId" | "chatId" | "threadId" | "actorId" | "createdBy" | "note" | "recordId" | "typeId" | "foreign" | "at" | "every" | "times" | "jobId">;

/** Stores a wakeup and, if it has a time, schedules it. #114 makes `{ jobId }` ones; #162 note-less `{ at, every }` ones. */
export async function createWakeup(ctx: MutationCtx, wakeup: NewWakeup) {
	const id = await ctx.db.insert("wakeups", { ...wakeup, status: "pending" });
	if (wakeup.at !== undefined) await armAt(ctx, id, wakeup.at);
	return id;
}

/**
 * (Re)schedules a wakeup for `at`, pending again, and cancels the scheduled fire before it (best
 * effort: `fire` does nothing unless `at` still matches). Moving a follow-up, or a heartbeat
 * setting its next beat, is this. Cancelled ones stay cancelled.
 */
export async function armAt(ctx: MutationCtx, id: Id<"wakeups">, at: number) {
	const row = await ctx.db.get(id);
	if (!row || row.status === "cancelled") return;
	await unschedule(ctx, row);
	const scheduledId = await ctx.scheduler.runAt(at, internal.wakeups.fire, { id, at });
	await ctx.db.patch(id, { status: "pending", at, scheduledId, held: undefined, settledAt: undefined, reason: undefined });
}

async function unschedule(ctx: MutationCtx, row: Doc<"wakeups">) {
	if (!row.scheduledId) return;
	try {
		await ctx.scheduler.cancel(row.scheduledId);
	} catch {
		// Already ran or gone: `fire` re-checks the row anyway.
	}
}

/** Cancels a pending wakeup, saying why. Nothing runs for it after this. */
export async function cancelWakeup(ctx: MutationCtx, row: Doc<"wakeups">, reason: string) {
	if (row.status !== "pending") return;
	await unschedule(ctx, row);
	await ctx.db.patch(row._id, { status: "cancelled", reason, held: undefined, settledAt: Date.now() });
}

/** A wakeup's time came (scheduled by `armAt`). Stale calls (moved, cancelled, already fired) do nothing. */
export const fire = internalMutation({
	args: { id: v.id("wakeups"), at: v.number() },
	handler: async (ctx, { id, at }) => {
		const row = await ctx.db.get(id);
		// A held one tries again too (armAt clears `held`): `wake` holds it again if it's still waiting.
		if (!row || row.status !== "pending" || row.at !== at) return;
		// The next one is scheduled first, so a wake that fails or is skipped doesn't end the repeat.
		if (repeatsAfter(row)) await armAt(ctx, id, nextRepeat(at, row.every!, Date.now(), await timeZoneOf(ctx, row.actorId)));
		await wake(ctx, id);
	},
});

/** Something it waited on is back from Trash: try again. */
export const release = internalMutation({
	args: { id: v.id("wakeups") },
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id);
		if (!row?.held || row.status !== "pending") return;
		await ctx.db.patch(id, { held: undefined });
		await wake(ctx, id);
	},
});

/** Whether a wakeup has another wake after the one now: it repeats, and `times` (if set) isn't used up. */
const repeatsAfter = (row: Doc<"wakeups">) => !!row.every && (row.times === undefined || (row.wakes ?? 0) + 1 < row.times);

/** Called when anything comes back from Trash (trashOps): held wakeups in the workspace try again. */
export async function releaseHeld(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	const held = await ctx.db
		.query("wakeups")
		.withIndex("by_held", (q) => q.eq("workspaceId", workspaceId).eq("held", true))
		.take(LIST_MAX);
	for (const row of held) await ctx.scheduler.runAfter(0, internal.wakeups.release, { id: row._id });
}

/**
 * The only path from a wakeup to a turn. Re-checks, as of now, that its person is still a member
 * who can see the chat, and that its agent, chat and record are there; then the kind's gate; then
 * queues a quiet turn as that person, with the wakeup as its input. A job's `result` (#114) is
 * kept on the row for the turn. Every call writes one line in Activity.
 */
export async function wake(ctx: MutationCtx, id: Id<"wakeups">, outcome?: { result?: string }) {
	let row = await ctx.db.get(id);
	if (!row || row.status !== "pending") return;
	if (outcome?.result !== undefined) await ctx.db.patch(id, { result: outcome.result });
	// A workspace being deleted wakes nothing: its cascade takes the row.
	if (!(await liveWorkspace(ctx, row.workspaceId))) return;
	row = (await ctx.db.get(id))!;
	const stop = async (reason: string) => {
		await cancelWakeup(ctx, row!, reason);
		await logWake(ctx, row!, "skipped", reason);
	};
	// Never as anyone else: their follow-ups end with them.
	const member = await memberOf(ctx, row.actorId, row.workspaceId);
	if (!member) return stop("Its person left the workspace.");
	const agent = await ctx.db.get(row.agentId);
	const chat = await ctx.db.get(row.chatId);
	const record = row.recordId ? await ctx.db.get(row.recordId) : undefined;
	if (!agent) return stop("Its agent was deleted.");
	if (!chat) return stop("Its chat was deleted.");
	if (record === null) return stop("Its record was deleted.");
	const type = record && (await ctx.db.get(record.typeId));
	if (agent.archived || chat.archived || record?.archived || type?.archived) {
		await ctx.db.patch(id, { held: true });
		return logWake(ctx, row, "skipped", "Waiting: its agent, chat or record is in Trash. It wakes if that's restored.");
	}
	if (!(await canSee(ctx, chat, member))) return stop("Its person can no longer see the chat.");
	if (row.threadId && !(await ctx.db.get(row.threadId))) return stop("Its thread was deleted.");

	// Its last wake settles it; a repeating one stays pending (`fire` already armed the next).
	const settle = { lastWokeAt: Date.now(), wakes: (row.wakes ?? 0) + 1, ...(!repeatsAfter(row) && { status: "fired" as const, settledAt: Date.now() }) };
	const skip = row.note === undefined && lookAroundGate ? await lookAroundGate(ctx, row) : null;
	if (skip) {
		await ctx.db.patch(id, settle);
		return logWake(ctx, row, "skipped", skip);
	}
	const wakeLogId = await logWake(ctx, row, "fired");
	if (chat.kind === "channel") await addToChat(ctx, chat, { agentId: agent._id });
	await enqueueTurn(ctx, chat, { agentId: agent._id, chatId: chat._id, threadId: row.threadId, actorId: row.actorId, wakeupId: id, wakeLogId });
	await ctx.db.patch(id, settle);
}

/** A wake's one line in Activity, as private as its chat. */
function logWake(ctx: MutationCtx, row: Doc<"wakeups">, outcome: WakeOutcome, reason?: string) {
	return ctx.db.insert("agentActivity", {
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		actorId: row.actorId,
		chatId: row.chatId,
		threadId: row.threadId,
		callId: row._id,
		tool: "wakeups.wake",
		changes: false,
		input: JSON.stringify({ note: row.note ?? null, ...(row.recordId && { recordId: row.recordId }), ...(row.jobId && { jobId: row.jobId }) }),
		status: "done",
		wake: { wakeupId: row._id, outcome, ...(reason && { reason }) },
	});
}

/** Moves a wake turn's Activity line on: "ran" (quietly), "notified" or "failed". */
export async function setWakeOutcome(ctx: MutationCtx, turn: Doc<"agentTurns">, outcome: WakeOutcome) {
	const line = turn.wakeLogId && (await ctx.db.get(turn.wakeLogId));
	if (!line?.wake) return;
	// Once it spoke up, it stays "notified".
	if (line.wake.outcome === "notified" && outcome !== "notified") return;
	await ctx.db.patch(line._id, { turnId: turn._id, status: outcome === "failed" ? "error" : "done", wake: { ...line.wake, outcome } });
}

// ---- Who sees and cancels them ----

/** Whether `member` can see a wakeup: it's as private as its chat. */
async function visibleTo(ctx: QueryCtx, member: Member, row: Doc<"wakeups">) {
	const chat = await ctx.db.get(row.chatId);
	return !!chat && !chat.archived && (await canSee(ctx, chat, member));
}

/** Its person, whoever set it up, or an owner (`automations.manage`). */
const canCancel = (member: Member, row: Doc<"wakeups">) =>
	row.actorId === member.userId || row.createdBy === member.userId || can(member, "automations.manage");

async function requireCancellable(ctx: QueryCtx, member: Member, id: string) {
	const wakeupId = ctx.db.normalizeId("wakeups", id);
	const row = wakeupId && (await ctx.db.get(wakeupId));
	if (!row || row.workspaceId !== member.workspaceId || row.status !== "pending") throw new ConvexError("No pending follow-up with that id.");
	// Owners cancel ones they can't see too: Settings lists them without their note.
	if (!canCancel(member, row) || (!can(member, "automations.manage") && !(await visibleTo(ctx, member, row))))
		throw new ConvexError("Only its person, whoever set it up, or an owner can cancel it.");
	return row;
}

/**
 * Pending wakeups, soonest first: ones in chats `member` can see, and for owners the rest too,
 * without their note, so what's running is always visible and can be stopped.
 */
async function pendingFor(ctx: QueryCtx, member: Member, recordId?: Id<"records">) {
	const rows = recordId
		? await ctx.db
				.query("wakeups")
				.withIndex("by_record", (q) => q.eq("recordId", recordId).eq("status", "pending"))
				.take(LIST_MAX)
		: await ctx.db
				.query("wakeups")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("status", "pending"))
				.take(LIST_MAX);
	const out = [];
	for (const row of rows) {
		if (row.workspaceId !== member.workspaceId) continue;
		const visible = await visibleTo(ctx, member, row);
		if (visible || can(member, "automations.manage")) out.push({ row, visible });
	}
	return out.sort((a, b) => (a.row.at ?? Infinity) - (b.row.at ?? Infinity));
}

/** Settings → Automations and a record's screen: pending wakeups of every kind. */
export const list = query({
	args: { recordId: v.optional(v.id("records")) },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const names = namer(ctx);
		return Promise.all(
			(await pendingFor(ctx, member, recordId)).map(async ({ row, visible }) => {
				const chat = visible ? await ctx.db.get(row.chatId) : null;
				const record = visible && row.recordId ? await ctx.db.get(row.recordId) : null;
				const type = record && (await ctx.db.get(record.typeId));
				return {
					_id: row._id,
					/** Null for ones in a chat you can't see (owners still see that they exist), and for check-ins that look around. */
					note: visible ? (row.note ?? null) : null,
					at: row.at ?? null,
					every: row.every ?? null,
					/** Wakes left, this one included; null: until cancelled. */
					left: row.every ? (row.times === undefined ? null : row.times - (row.wakes ?? 0)) : null,
					job: !!row.jobId,
					held: row.held ?? false,
					actor: (await names.user(row.actorId)).name,
					mine: row.actorId === member.userId,
					agent: (await names.agent(row.agentId)).name,
					place: chat ? { chatId: chat._id, threadId: row.threadId ?? null, label: await chatLabel(ctx, chat, names, member.userId) } : null,
					record: record && type ? { _id: record._id, title: record.title, typeKey: type.key } : null,
					canCancel: canCancel(member, row),
				};
			}),
		);
	},
});

export const cancel = mutation({
	args: { id: v.id("wakeups") },
	handler: async (ctx, { id }) => {
		const member = await requireMember(ctx);
		const row = await requireCancellable(ctx, member, id);
		await cancelWakeup(ctx, row, `Cancelled by ${await nameOf(ctx, member.userId)}.`);
	},
});

/** Runs hourly (crons.ts): forgets wakeups that fired or were cancelled over SETTLED_KEEP_MS ago, in batches. */
export const forgetSettled = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = ctx.db.query("wakeups").withIndex("by_settled", (q) => q.gt("settledAt", 0).lt("settledAt", Date.now() - SETTLED_KEEP_MS));
		await sweepExpired(ctx, old, (row) => ctx.db.delete(row._id), internal.wakeups.forgetSettled);
	},
});

// ---- Agent tools (core's WakeupStore), acting as the turn's person ----

export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const { note, at, in: after, every: often, times, recordId } = input as FollowupInput;
		return asToolResult(async () => {
			const problem = followupNoteError(note);
			if (problem) return { error: problem };
			const timeZone = await timeZoneOf(ctx, member.userId);
			const time = followupTime({ at, in: after }, Date.now(), timeZone);
			if (typeof time === "string") return { error: time };
			if (times !== undefined && often === undefined) return { error: 'Give "every" with "times".' };
			const every = often === undefined ? undefined : repeatEvery(often);
			if (typeof every === "string") return { error: every };
			const record = recordId ? await recordById(ctx, member, recordId) : null;
			if (record?.archived) return { error: `${record.title} is in Trash.` };
			if (record && (await pendingCount(ctx, "by_record", record._id, FOLLOWUPS_PER_RECORD)) >= FOLLOWUPS_PER_RECORD)
				return { error: `${record.title} already has ${FOLLOWUPS_PER_RECORD} follow-ups. Cancel one first.` };
			if ((await pendingCount(ctx, "by_agent", turn.agentId, FOLLOWUPS_PER_AGENT)) >= FOLLOWUPS_PER_AGENT)
				return { error: `This agent already has ${FOLLOWUPS_PER_AGENT} follow-ups waiting. Cancel some first.` };
			// A run that followed others' words (a webhook, an event, someone else's automation, or a wake
			// made in one) passes that on: its wake asks before acting as the person, like that run would.
			const { foreign } = await automationScope(ctx, turn);
			const id = await createWakeup(ctx, {
				workspaceId: member.workspaceId,
				agentId: turn.agentId,
				chatId: turn.chatId,
				threadId: turn.threadId,
				actorId: member.userId,
				createdBy: member.userId,
				note: note.trim(),
				...(record && { recordId: record._id, typeId: record.typeId }),
				foreign,
				at: time,
				...(every !== undefined && { every, ...(times !== undefined && { times }) }),
			});
			const repeat = every === undefined ? "" : `, then every ${often!.trim()}${times === undefined ? " until cancelled" : `, ${times} times in all`}`;
			return { created: id, when: followupWhen(time, timeZone) + repeat, ...(record && { record: record.title }) };
		});
	},
});

async function pendingCount(ctx: QueryCtx, index: "by_record" | "by_agent", id: Id<"records"> | Id<"agents">, max: number) {
	const rows = await ctx.db
		.query("wakeups")
		.withIndex(index, (q) => q.eq(index === "by_record" ? "recordId" : "agentId", id as never).eq("status", "pending"))
		.take(max);
	return rows.length;
}

export const listFor = internalQuery({
	args: { turnId: v.id("agentTurns"), recordId: v.optional(v.string()) },
	handler: async (ctx, { turnId, recordId }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const record = recordId ? await recordById(ctx, member, recordId) : null;
			const timeZone = await timeZoneOf(ctx, member.userId);
			const names = namer(ctx);
			const followups: FollowupSummary[] = [];
			for (const { row, visible } of await pendingFor(ctx, member, record?._id)) {
				if (!visible) continue;
				const about = row.recordId && (await ctx.db.get(row.recordId));
				followups.push({
					id: row._id,
					when: row.at ? followupWhen(row.at, timeZone) + (row.every ? ", then repeating" : "") : "When its job finishes",
					...(row.note !== undefined && { note: row.note }),
					agent: (await names.agent(row.agentId)).name,
					for: (await names.user(row.actorId)).name,
					...(about && { record: about.title }),
				});
			}
			return { followups };
		});
	},
});

export const cancelFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.string() },
	handler: async (ctx, { turnId, id }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const row = await requireCancellable(ctx, member, id);
			await cancelWakeup(ctx, row, `Cancelled by ${await nameOf(ctx, member.userId)}.`);
			return { cancelled: row._id };
		});
	},
});

/** chat.notify: a wake turn speaks up in its place, as the agent. Its Activity line says it did. */
export const notifyFor = internalMutation({
	args: { turnId: v.id("agentTurns"), text: v.string() },
	handler: async (ctx, { turnId, text }) => {
		const { turn, chat } = await runningTurn(ctx, turnId);
		if (!turn.wakeupId) return { error: "Only when you woke up on your own. Here, just reply." };
		if (!text.trim()) return { error: "Say something." };
		const sent = await ctx.db
			.query("agentActivity")
			.withIndex("by_reply", (q) => q.eq("replyId", turn.replyId))
			.filter((q) => q.eq(q.field("tool"), "chat.notify"))
			.take(NOTIFY_MAX);
		if (sent.length >= NOTIFY_MAX) return { error: `That's ${NOTIFY_MAX} messages already. Put the rest in one.` };
		await insertMessage(ctx, chat, {
			threadId: turn.threadId,
			authorAgentId: turn.agentId,
			text,
			parts: [{ type: "text", text }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
		});
		await setWakeOutcome(ctx, turn, "notified");
		return { posted: true as const };
	},
});
