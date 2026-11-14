import { integrationEvent } from "./integrationEventLog";
import { autonomyProblem, isHandoff } from "./agentPolicy";
import { publicSearchChat } from "./chatDiscovery";
import type { PlaceMessage, Skill } from "@companybot/core";
import type { ModelMessage } from "ai";
import { QUIET_WINDOW_MS, PROMPT_MESSAGE_CAP, THINKING_STEP, approxTokens, can, defaultReasoning, deniedMessage, calledTools, fallbackModels, responseOf, steerNote, stepsFor, withoutFileImages } from "@companybot/core";
import { ConvexError, getDocumentSize, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { mutation } from "./functions";
import { automationScope } from "./automationOps";
import { answerAsk, handOff } from "./chains";
import {
	type Namer,
	activityOf,
	canPost,
	canReplyAs,
	canSee,
	chatMembersOf,
	countMessage,
	label,
	membership,
	moveBelow,
	type Participant,
	requireChat,
	namer,
	reactOnce,
	requireReactionAudience,
	reactionGroups,
	setActivity,
	textForModel,
} from "./chatOps";
import { type RecordTags, recordTags, storeTags, syncRecordMentions } from "./recordTags";
import { filesForModel, turnImages } from "./files";
import { type Member, type Who, installedSkills, liveWorkspace, memberOf, nameOf, requireMember, timeZoneOf } from "./lib";
import { previewMessage } from "./linkPreviews";
import { catalogModels } from "./modelCatalog";
import { chatAccess } from "./placeAccess";
import { recordOut } from "./recordTools";
import { canReadReplyDetails, readReplyDetails, canReadReply, readReply, canReadSources } from "./replyPrivacy";
import { inheritPlaces, notePlace, placeAudience, turnSources, type UsedPlace, writeSources } from "./replySources";
import { messagePart, postDecision, replyStats, replyUsage } from "./schema";
import { recordUsage } from "./usage";
import { setWakeOutcome } from "./wakeups";

// The agent turn queue and everything the runner (agent.ts) reads and writes.
// One `running` turn per agent per place (chat + thread); the rest wait in order.

/** A running turn this old (e.g. the action crashed) is failed so the queue moves on. */
export const STALE_TURN_MS = 5 * 60_000;
/** Newest turns kept verbatim when a session is compacted. */
export const KEEP_TOKENS = 15_000;
/** Turns a session replays at most, newest kept: summaries that keep failing can't grow it without end. */
const SESSION_TURNS_MAX = 200;
/** Bytes a session's replay reads at most (turns, replies, steps): a quarter of Convex's 16 MiB, so the rest of a turn fits. */
const REPLAY_BYTES = 4 * 1024 * 1024;

type Place = { agentId: Id<"agents">; chatId: Id<"chats">; threadId?: Id<"chatMessages"> };

/**
 * Queues a reply from `agentId` to `triggerId` (or to a wakeup), and starts it if nothing is running there.
 * A `person` turn (a person's own message asked) starts only after QUIET_WINDOW_MS (startQueued).
 */
export async function enqueueTurn(
	ctx: MutationCtx,
	chat: Doc<"chats">,
	turn: Place & { actorId: Id<"users">; person?: true; routed?: true; handoff?: true; dispatch?: Doc<"agentTurns">["dispatch"]; chain?: Doc<"agentTurns">["chain"]; ask?: Doc<"agentTurns">["ask"] } & (
			// After an approval, the original turn's trigger: none if it followed an old welcome turn.
			| { triggerId: Id<"chatMessages">; approvalId?: Id<"approvals"> }
			| { triggerId: Id<"chatMessages"> | undefined; approvalId: Id<"approvals">; wakeupId?: Id<"wakeups"> }
			// A wake (wakeups.ts): no message asked.
			| { wakeupId: Id<"wakeups">; wakeLogId: Id<"agentActivity"> }
		),
) {
	const turnId = await ctx.db.insert("agentTurns", { ...turn, ...(turn.person && { debouncing: true as const }), workspaceId: chat.workspaceId, status: "queued" });
	if (turn.person) await ctx.scheduler.runAfter(QUIET_WINDOW_MS, internal.turns.startQueued, { turnId });
	else await startNext(ctx, turn);
	return turnId;
}

/** A person turn's quiet window is over: it may start (or the newer one it's folded into), unless one is running. */
export const startQueued = internalMutation({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const turn = await ctx.db.get(turnId);
		if (turn?.status !== "queued") return;
		await ctx.db.patch(turnId, { debouncing: undefined });
		await startNext(ctx, turn);
	},
});

/**
 * Folds the same person's other queued person turns in `into`'s place into it: they get no turn or
 * reply of their own. Only `person` turns, and only that person's (another person's acts with their
 * permissions). The caller makes sure their messages reach `into` (startNext: all in its window).
 */
export async function mergeQueued(ctx: MutationCtx, into: Doc<"agentTurns">) {
	if (!into.person) return;
	for (const t of await turnsAt(ctx, into, "queued").collect())
		if (t._id !== into._id && t.person && t.actorId === into.actorId) await ctx.db.patch(t._id, { status: "done", mergedInto: into._id, debouncing: undefined });
}

/**
 * Whether a dispatcher pick still waits for the one before it (router.apply): until that one ends,
 * unless it's stale. Waiting holds its place's queue, a few seconds at most.
 */
async function waiting(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const before = turn.dispatch?.after && (await ctx.db.get(turn.dispatch.after));
	if (!before || (before.status !== "queued" && before.status !== "running")) return false;
	return Date.now() - (before.startedAt ?? before._creationTime) < STALE_TURN_MS;
}

/** A pick that waited for this turn may start now. */
async function startThen(ctx: MutationCtx, turn: Doc<"agentTurns">) {
	const then = turn.dispatch?.then && (await ctx.db.get(turn.dispatch.then));
	if (then?.status === "queued") await startNext(ctx, then);
}

/** Scheduled by router.apply: starts one message's picks still waiting, once the ones before them are stale. */
export const startWaiting = internalMutation({
	args: { triggerId: v.id("chatMessages") },
	handler: async (ctx, { triggerId }) => {
		const message = await ctx.db.get(triggerId);
		if (!message) return;
		const queued = await ctx.db
			.query("agentTurns")
			.withIndex("by_chat", (q) => q.eq("chatId", message.chatId).eq("threadId", message.threadId).eq("status", "queued"))
			.collect();
		for (const turn of queued.filter((t) => t.triggerId === triggerId && t.dispatch?.after)) await startNext(ctx, turn);
	},
});

const turnsAt = (ctx: QueryCtx, place: Place, status: Doc<"agentTurns">["status"]) =>
	ctx.db
		.query("agentTurns")
		.withIndex("by_place", (q) =>
			q.eq("agentId", place.agentId).eq("chatId", place.chatId).eq("threadId", place.threadId).eq("status", status),
		);

/** The agent's session in a place, if it has one. */
export const sessionAt = (ctx: QueryCtx, place: Place) =>
	ctx.db
		.query("agentSessions")
		.withIndex("by_place", (q) => q.eq("agentId", place.agentId).eq("chatId", place.chatId).eq("threadId", place.threadId))
		.first();

/**
 * When a turn ends, an approval it was meant to run can't stay approved or running: the
 * card would say "running…" forever and nobody could decide again.
 */
async function settleApproval(ctx: MutationCtx, turn: Doc<"agentTurns">) {
	const approval = turn.approvalId && (await ctx.db.get(turn.approvalId));
	if (approval?.status === "approved")
		await ctx.db.patch(approval._id, { status: "failed", error: "The reply stopped before running it. Ask again if you still want it." });
	// A built-in's effect commits with its receipt (approvals.withReceipt): still running means it never happened.
	// An outside service's call may have landed before the reply stopped: that's unknown until someone checks.
	if (approval?.status === "running")
		await ctx.db.patch(
			approval._id,
			approval.outside
				? { status: "failed", outcome: "unknown", error: "The reply stopped while it was running, so it may or may not have happened. Check before trying again." }
				: { status: "failed", error: "The reply stopped before it finished, so nothing changed. Ask again if you still want it." },
		);
}

/**
 * Whether the agent is answering somewhere else in this chat right now (another thread, or the main
 * chat). One agent runs one turn at a time in a chat: two at once, in two places, answer the same
 * conversation without knowing about each other and contradict. The other waits, then starts when
 * this one ends (startInChat), seeing what it said (turnContext `elsewhere`). A stale one doesn't count.
 */
async function busyElsewhere(ctx: QueryCtx, place: Place) {
	const running = await ctx.db
		.query("agentTurns")
		.withIndex("by_agent_chat", (q) => q.eq("agentId", place.agentId).eq("chatId", place.chatId).eq("status", "running"))
		.collect();
	return running.some((t) => t.threadId !== place.threadId && Date.now() - (t.startedAt ?? t._creationTime) < STALE_TURN_MS);
}

/** A turn ended: the agent's next waiting turn in this chat starts, its own place's first. */
async function startInChat(ctx: MutationCtx, place: Place) {
	await startNext(ctx, place);
	if (await turnsAt(ctx, place, "running").first()) return;
	const queued = await ctx.db
		.query("agentTurns")
		.withIndex("by_agent_chat", (q) => q.eq("agentId", place.agentId).eq("chatId", place.chatId).eq("status", "queued"))
		.take(20);
	const tried = new Set([String(place.threadId)]);
	for (const t of queued) {
		if (tried.has(String(t.threadId))) continue;
		tried.add(String(t.threadId));
		await startNext(ctx, t);
		if (await turnsAt(ctx, t, "running").first()) return;
	}
}

/**
 * Starts the oldest queued turn in a place, unless one is running (a stale one is failed first), or
 * the agent is answering elsewhere in the chat (busyElsewhere).
 * A person turn starts as that person's newest queued here, once its quiet window is over, with the
 * older ones folded into it: its context covers all their messages.
 */
async function startNext(ctx: MutationCtx, { agentId, chatId, threadId }: Place) {
	const place = { agentId, chatId, threadId };
	const running = await turnsAt(ctx, place, "running").first();
	if (running) {
		if (Date.now() - (running.startedAt ?? running._creationTime) < STALE_TURN_MS) return;
		await ctx.db.patch(running._id, { status: "error", step: undefined });
		await startThen(ctx, running);
		await setWakeOutcome(ctx, running, "failed");
		await settleApproval(ctx, running);
		await answerAsk(ctx, running, "it timed out");
		const reply = running.replyId && (await ctx.db.get(running.replyId));
		// Its finished model calls were saved as they finished (saveUsage), so it keeps their stats.
		if (reply?.status === "streaming") {
			await endStream(ctx, reply, { status: "error", error: "Reply timed out.", ...(running.usage && { stats: await statsOf(ctx, running, running.usage) }) });
			await show(ctx, reply);
		}
	}
	let next = await turnsAt(ctx, place, "queued").first();
	if (!next || (await waiting(ctx, next)) || (await busyElsewhere(ctx, place))) return;
	if (next.person) {
		const actorId = next.actorId;
		const theirs = (await turnsAt(ctx, place, "queued").collect()).filter((t) => t.person && t.actorId === actorId);
		const newest = theirs.at(-1)!;
		// Its timer (startQueued) starts it; past STALE_TURN_MS, whatever runs next does.
		if (newest.debouncing && Date.now() - newest._creationTime < STALE_TURN_MS) return;
		next = newest;
		// A follow-up to a pick is a pick too (queueFollowUps), unless one of the messages it covers asked the agent directly.
		if ((next.routed || next.handoff) && theirs.some((t) => !t.routed && !t.handoff)) {
			await ctx.db.patch(next._id, { routed: undefined, dispatch: undefined, handoff: undefined });
			next = { ...next, routed: undefined, dispatch: undefined, handoff: undefined };
		}
		await mergeQueued(ctx, next);
	}
	const chat = await ctx.db.get(next.chatId);
	// A workspace being deleted starts nothing: its cascade may already be past the rows this would add.
	// Nor does a reply its person can no longer post: a read-only channel, or one they lost (wakes, automations, asks).
	const problem =
		!chat || chat.archived || !(await liveWorkspace(ctx, chat.workspaceId))
			? "its chat was deleted"
			: !(await canReplyAs(ctx, chat, await memberOf(ctx, next.actorId, chat.workspaceId)))
				? "its person can no longer post there"
				: await autonomyProblem(ctx, next);
	if (!chat || problem) {
		await ctx.db.patch(next._id, { status: "error" });
		await startThen(ctx, next);
		await setWakeOutcome(ctx, next, "failed");
		await answerAsk(ctx, next, problem ?? undefined);
		await settleApproval(ctx, next);
		// A disallowed queued handoff must not strand a later human request in the same place.
		const following = await turnsAt(ctx, place, "queued").first();
		if (following) await ctx.scheduler.runAfter(following.debouncing ? Math.max(0, following._creationTime + QUIET_WINDOW_MS - Date.now()) : 0, internal.turns.startQueued, { turnId: following._id });
		return;
	}

	const session =
		(await sessionAt(ctx, place)) ??
		(await ctx.db.get(await ctx.db.insert("agentSessions", { workspaceId: chat.workspaceId, ...place })))!;
	const reply = {
		threadId: place.threadId,
		authorAgentId: place.agentId,
		repliedTo: next.actorId,
		text: "",
		parts: [],
		mentions: { userIds: [], agentIds: [] },
		status: "streaming" as const,
	};
	// Every reply starts hidden (quiet: not in the timeline, unread or the thread's replies) while the
	// typing line shows the agent working, and shows once its message starts (show).
	const replyId = await ctx.db.insert("chatMessages", { chatId: chat._id, workspaceId: chat.workspaceId, ...reply, searchPublic: publicSearchChat(chat), quiet: true });
	await ctx.db.patch(next._id, { status: "running", replyId, sessionId: session._id, startedAt: Date.now(), step: { label: THINKING_STEP, at: Date.now() }, debouncing: undefined });
	await ctx.scheduler.runAfter(0, internal.agent.respond, { turnId: next._id });
}

/**
 * What a past turn answered, as it replays: its decision as it wrote it. Without one (it failed, was
 * stopped, or made none), what its reply showed. Pictures by file id don't show in a message;
 * replaying them teaches the model to write more.
 */
function answerOf(turn: Doc<"agentTurns">, reply: Doc<"chatMessages"> | null) {
	if (turn.decision) return JSON.stringify({ ...turn.decision, message: withoutFileImages(turn.decision.message) });
	return withoutFileImages(reply?.text ?? "");
}

/**
 * A session's finished, unsummarized turns as they replay to the model, oldest first. `steps` is JSON
 * (core replay.ts): a call's input or result can have keys Convex values can't.
 */
async function sessionTurns(ctx: QueryCtx, session: Doc<"agentSessions">, member?: Member, sharedHere?: Shared) {
	const hiddenSummary = !!session.summary && (session.summaryPrivacy !== 1 || !!member && !(await summaryHere(ctx, member, session, sharedHere)));
	const query = ctx.db.query("agentTurns").withIndex("by_session", (q) => q.eq("sessionId", session._id).gt("_creationTime", hiddenSummary ? 0 : session.summarizedUpTo ?? 0));
	const replay = [];
	let tokens = 0;
	let bytes = 0;
	let scanned = 0;
	// Newest first, so a cap keeps the newest. Reads are bounded on both paths: summaries that keep
	// failing, or many hidden turns filling the tail, can't grow it without end.
	// A turn that doesn't fit whole ends the replay there: it and everything older are left out.
	for await (const turn of query.order("desc")) {
		bytes += getDocumentSize(turn);
		if (++scanned > SESSION_TURNS_MAX || bytes > REPLAY_BYTES) break;
		if ((turn.status !== "done" && turn.status !== "error") || turn.prompt === undefined) continue;
		const reply = turn.replyId ? await ctx.db.get(turn.replyId) : null;
		bytes += reply ? getDocumentSize(reply) : 0;
		if (bytes > REPLAY_BYTES) break;
		if (member && reply && !(await canReadReply(ctx, member, reply))) continue;
		// Where others see the reply, a private one stays out with its question: nothing it used carries over.
		if (sharedHere && reply && !reply.sharedBy && !(await sharedHere(reply.usedPlaces))) continue;
		const details = !member || await canReadReplyDetails(ctx, member, reply);
		// Read one step at a time against the budget: a turn's steps can be many near-1 MiB rows.
		const kept: Doc<"turnSteps">[] = [];
		for await (const step of ctx.db.query("turnSteps").withIndex("by_turn", (q) => q.eq("turnId", turn._id))) {
			bytes += getDocumentSize(step);
			if (bytes > REPLAY_BYTES) break;
			kept.push(step);
		}
		if (bytes > REPLAY_BYTES) break;
		const steps = kept.flatMap((s) => JSON.parse(s.messages) as ModelMessage[]);
		const shown = JSON.stringify(member ? stepsFor(steps, { details, results: turn.actorId === member.userId }) : steps);
		const answer = answerOf(turn, reply);
		const prompt = turn.promptPlaces !== undefined && (!member || await canReadSources(ctx, member, turn.promptPlaces)) && (!sharedHere || await sharedHere(turn.promptPlaces)) ? turn.prompt : "";
		const size = approxTokens(prompt + shown + answer);
		if (hiddenSummary && tokens + size > KEEP_TOKENS) break;
		if (member && reply) {
			if (details) await readReplyDetails(ctx, member, reply);
			else await readReply(ctx, member, reply);
		}
		if (member && prompt) await inheritPlaces(ctx, member, turn.promptPlaces);
		replay.push({ prompt, steps: shown, answer, ...(reply?.stoppedBy && { stopped: true as const }), calls: calledTools(steps), time: turn._creationTime, usedPlaces: [...new Set([...(prompt ? turn.promptPlaces ?? [] : []), ...(details ? reply?.usedPlaces ?? [] : [])])] });
		tokens += size;
	}
	return replay.reverse();
}

/** Checks whether sources fit everyone in the place; undefined in the asker's own 1:1 agent DM, where their private history replays. */
type Shared = ((sources?: UsedPlace[]) => Promise<boolean>) | undefined;

async function sharedCheck(ctx: QueryCtx, member: Member, chatId: Id<"chats">): Promise<Shared> {
	return member.ownWrites ? undefined : await placeAudience(ctx, member, chatId);
}

/** The session summary replays only if the person can read what it used and, in a shared place, everyone there could. */
async function summaryHere(ctx: QueryCtx, member: Member, session: Doc<"agentSessions">, sharedHere: Shared) {
	return await canReadSources(ctx, member, session.summaryPlaces) && (!sharedHere || await sharedHere(session.summaryPlaces));
}

/** The running turn, its person (read fresh), and the chat, if they can still see it. */
export async function runningTurn(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const turn = await ctx.db.get(turnId);
	if (!turn || turn.status !== "running" || !turn.replyId || !turn.sessionId) throw new Error("This reply was stopped.");
	const member = await memberOf(ctx, turn.actorId, turn.workspaceId);
	if (!member) throw new Error("This person is no longer in the workspace.");
	const chat = await ctx.db.get(turn.chatId);
	if (!chat || chat.archived || !(await canSee(ctx, chat, member))) throw new Error("This person can no longer see this chat.");
	// Its reply posts there as them: a read-only channel ends it (chatOps.canReplyAs).
	if (!canPost(member, chat)) throw new Error("This person can no longer post in this chat.");
	const policyProblem = await autonomyProblem(ctx, turn);
	if (policyProblem) throw new Error(policyProblem);
	const scope = await automationScope(ctx, turn);
	const seats = !scope.foreign && chat.kind === "dm" ? await chatMembersOf(ctx, chat._id) : [];
	member.ownWrites = seats.filter((seat) => seat.userId).length === 1 && seats.some((seat) => seat.userId === member.userId) && seats.some((seat) => seat.agentId);
	member.replyId = turn.replyId;
	await notePlace(ctx, member, chat._id, chatAccess(chat), chat.kind !== "channel" || !!chat.private);
	const who: Who = { member, agentId: turn.agentId };
	return { turn: turn as Doc<"agentTurns"> & { replyId: Id<"chatMessages">; sessionId: Id<"agentSessions"> }, member, chat, who, scope };
}

/** Whether agents use memories here: people with workspace.manage can turn it off for the workspace (Settings → General). */
export async function memoryOn(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	return (await ctx.db.get(workspaceId))?.memory !== false;
}

/** Personal memories are read only in a DM with exactly one person; anywhere else agents can only save new ones for the person who asked (wiki/chat.md). */
export async function personalMemoryHere(ctx: QueryCtx, chat: Doc<"chats">) {
	if (chat.kind !== "dm") return false;
	return (await chatMembersOf(ctx, chat._id)).filter((r) => r.userId).length === 1;
}

/**
 * Everything the runner needs for one turn: the agent (read fresh, so edits apply
 * from the next reply), the session to replay, and what's new in the place.
 */
export const turnContext = internalMutation({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const { turn, member, chat, scope: { trigger, foreign, wakeup } } = await runningTurn(ctx, turnId);
		const agent = await ctx.db.get(turn.agentId);
		if (!agent || agent.archived) throw new Error("This agent is in Archive.");
		const session = (await ctx.db.get(turn.sessionId))!;
		const reply = (await ctx.db.get(turn.replyId))!;
		const names = namer(ctx);
		const sharedHere = await sharedCheck(ctx, member, chat._id);
		const summary = !foreign && session.summaryPrivacy === 1 && await summaryHere(ctx, member, session, sharedHere) ? session.summary ?? null : null;
		if (summary) await inheritPlaces(ctx, member, session.summaryPlaces);
		if (wakeup) {
			if (!(await canReadSources(ctx, member, wakeup.usedPlaces))) throw new Error("This follow-up uses places you can no longer see.");
			await inheritPlaces(ctx, member, wakeup.usedPlaces);
		}

		// Finished turns only, so never this (running) one.
		const turns = (foreign ? [] : await sessionTurns(ctx, session, member, sharedHere)).map(({ prompt, steps, answer, stopped }) => ({ prompt, steps, answer, ...(stopped && { stopped }) }));

		// What's new: everything in the place after the last turn's reply started.
		const last = (
			await ctx.db
				.query("agentTurns")
				.withIndex("by_session", (q) => q.eq("sessionId", session._id))
				.order("desc")
				.take(20)
		).find((t) => t._id !== turnId && t.prompt !== undefined);
		const lastReply = last?.replyId && (await ctx.db.get(last.replyId));
		const since = foreign ? (trigger?._creationTime ?? 0) : (lastReply?._creationTime ?? last?.startedAt ?? 0);
		// Messages that steered the last turn (steer) came after its reply began, but it already took them in.
		const steered = new Set(foreign ? [] : (last?.steered ?? []));
		// Foreign runs get only their trigger, or replies in a thread rooted at that trigger.
		// Never replay the person's DM/channel history, including compacted session summaries.
		// A foreign wake has no trigger: it gets only its wakeup.
		const window = foreign && (!trigger || turn.threadId !== trigger._id) ? (trigger ? [trigger] : []) : (
			await ctx.db
				.query("chatMessages")
				// Not quiet: replies not shown (yet), and asks.
				.withIndex("by_chat_thread_quiet", (q) =>
					q.eq("chatId", chat._id).eq("threadId", turn.threadId).eq("quiet", undefined).gt("_creationTime", since).lt("_creationTime", reply._creationTime),
				)
				.order("desc")
				.filter((q) => q.neq(q.field("deleted"), true))
				// The prompt shows PROMPT_MESSAGE_CAP; one more says there are earlier ones, one more for the trigger.
				.take(PROMPT_MESSAGE_CAP + 2)
		).reverse();
		const recent = [];
		// Others' private replies stay out in a shared place too; the message this turn answers is its subject.
		const here = async (m: Doc<"chatMessages">) => !sharedHere || !!m.sharedBy || await sharedHere(m.usedPlaces);
		for (const m of window) if (!steered.has(m._id) && (m._id === turn.triggerId || await here(m)) && await readReply(ctx, member, m)) recent.push(m);
		// A turn after an approval answers the decision, not a message.
		const approval = turn.approvalId && (await ctx.db.get(turn.approvalId));
		if (approval && !(await readReplyDetails(ctx, member, await ctx.db.get(approval.replyId)))) throw new Error("This approval uses places you can no longer see.");
		if (!approval && turn.triggerId && !recent.some((m) => m._id === turn.triggerId)) {
			const trigger = await ctx.db.get(turn.triggerId);
			if (trigger && await readReply(ctx, member, trigger)) recent.push(trigger);
		}
		const skills = await installedSkills(ctx, chat.workspaceId, turn.actorId, member);
		const reacted = foreign || !last ? [] : await reactedSince(ctx, member, chat._id, turn.threadId, since, here);
		const tags = recordTags(ctx, member);
		const messages = (
			await Promise.all(
				recent
					.filter((m) => !m.deleted)
					// Another agent's reply still streaming keeps its text so far apart from the message. With nothing to
					// show yet (a reply that started over), it's left out: as `""` it read as a reply that said nothing.
					.map(async (m) => {
						const stream = m.status === "streaming" && (await streamOf(ctx, m._id));
						if (m.status === "streaming" && m._id !== turn.triggerId && !(stream && showable(stream.parts))) return null;
						return toPlaceMessage(ctx, stream ? { ...m, text: stream.text, parts: stream.parts } : m, names, tags, agent._id, skills);
					}),
			)
		).filter((m) => m !== null);

		// What it said meanwhile in this chat's other threads or main chat: a separate session, so without this it
		// can contradict itself (one game told two ways). Never for a foreign run.
		const elsewhere = foreign ? [] : await saidElsewhere(ctx, member, turn, since, here, names, tags);

		const threadParent = turn.threadId && (!foreign || turn.threadId === trigger?._id) && (await ctx.db.get(turn.threadId));
		const parent = threadParent && await readReply(ctx, member, threadParent) ? threadParent : null;
		// What the person wrote, the only links web.fetch opens before searching: this turn's messages,
		// the thread's parent, and after an approval the message that started it (it's before the window).
		const own = (m: Doc<"chatMessages"> | null | undefined | false): m is Doc<"chatMessages"> => !!m && !m.deleted && !m.external && m.authorUserId === member.userId;
		const origin = approval && turn.triggerId && (await ctx.db.get(turn.triggerId));
		const asked = [...recent, parent, origin].filter(own).map((m) => m.text);
		/** A thread's first turn starts with its parent. */
		const first = turns.length === 0 && (foreign || !summary);
		const { models } = await catalogModels(ctx);
		const vision = [models, fallbackModels].some((list) => list.find((m) => m.id === agent.model)?.vision);
		const user = await ctx.db.get(member.userId);
		// Deleted: null. Its database hidden from them since: recordOut refuses, and the turn ends with why.
		const about = wakeup?.recordId ? await ctx.db.get(wakeup.recordId) : undefined;
		return {
			replyId: turn.replyId,
			member,
			agent: { id: agent._id, name: agent.name, instructions: agent.instructions, model: agent.model, reasoning: agent.reasoning ?? defaultReasoning, tools: agent.tools },
			skills,
			session: { id: session._id, summary, turns },
			/** Off when it's turned off for the workspace; personal only in a DM with exactly one person. memory.ts checks again on every call. */
			memory: !(await memoryOn(ctx, chat.workspaceId)) ? ("off" as const) : (await personalMemoryHere(ctx, chat)) ? ("personal" as const) : ("team" as const),
			actor: {
				id: member.userId,
				name: (await names.user(member.userId)).name,
				email: user?.email ?? "",
				roles: member.workspaceRoles.filter((r) => member.roles.includes(r.id as Id<"roles">)).map((r) => r.name),
				timeZone: await timeZoneOf(ctx, member.userId),
			},
			place: {
				kind: chat.kind,
				name: chat.name ?? null,
				private: chat.private,
				topic: chat.topic ?? null,
				thread: parent
					? { parent: await toPlaceMessage(ctx, parent, names, tags, agent._id), first }
					: null,
				...(await placeMembers(ctx, chat, [member.userId, ...[parent, ...recent].flatMap((m) => (m ? [m.authorUserId, m.actingFor] : []))], names)),
			},
			messages,
			reacted: await Promise.all(reacted.map((m) => toPlaceMessage(ctx, m, names, tags, agent._id))),
			elsewhere,
			asked,
			triggerId: turn.triggerId ?? null,
			/** Nobody @mentioned it: how sure the dispatcher was, or which agent named it. */
			routed: turn.routed
				? {
						band: turn.dispatch?.band ?? ("probably" as const),
						...(turn.dispatch?.by && { by: turn.dispatch.by }),
						...(turn.dispatch?.after && { before: await picksBefore(ctx, turn, names) }),
					}
				: undefined,
			/** Set when another agent handed it the trigger message (chains.ts). */
			handoff: await handoffOf(ctx, turn),
			/** Set on a wake turn: what woke it, in place of a message (wakeups.ts). */
			wake: wakeup
				? {
						id: wakeup._id,
						...(wakeup.note !== undefined && { note: wakeup.note }),
						setAt: wakeup._creationTime,
						// Counted before the turn runs: `wakes` already includes this one.
						...(wakeup.repeat && { repeats: { left: wakeup.times === undefined ? null : Math.max(wakeup.times - (wakeup.wakes ?? 0), 0) } }),
						...(about !== undefined && { record: about && (await recordOut(ctx, member, about._id)) }),
						...(wakeup.result !== undefined && { result: wakeup.result }),
						...(wakeup.answer && { answer: { from: (await names.agent(wakeup.answer.agentId)).name } }),
					}
				: undefined,
			vision,
			/** Pictures for the model, newest kept: the runner loads and sends them when it sees pictures. */
			images: vision ? turnImages([...(parent && first ? [parent] : []), ...recent.filter((m) => !m.deleted)]) : [],
			/** The approval this turn follows: the runner runs it if approved, then tells the agent. */
			approval: approval
				? {
						id: approval._id,
						tool: approval.tool,
						status: approval.status,
						by: (await names.user(approval.actorId)).name,
						actorId: approval.actorId,
						decidedAt: approval.decidedAt,
						always: approval.always ?? false,
					}
				: null,
		};
	},
});

/** How many of its replies elsewhere a turn sees, newest kept, and how far back. */
const ELSEWHERE_MAX = 3;
const ELSEWHERE_MS = 24 * 60 * 60_000;

/**
 * The agent's own replies in this chat outside this turn's place (the main chat, or another thread) since
 * its last reply here, oldest first: what it already said in the same conversation. The same privacy as the
 * rest of its context: only replies this turn's person may read, that fit a shared place.
 */
async function saidElsewhere(ctx: QueryCtx, member: Member, turn: Doc<"agentTurns">, since: number, here: (m: Doc<"chatMessages">) => Promise<boolean>, names: Namer, tags: RecordTags) {
	const after = Math.max(since, Date.now() - ELSEWHERE_MS);
	const done = await ctx.db
		.query("agentTurns")
		.withIndex("by_agent_chat", (q) => q.eq("agentId", turn.agentId).eq("chatId", turn.chatId).eq("status", "done"))
		.order("desc")
		.take(20);
	const said: Doc<"chatMessages">[] = [];
	for (const t of done) {
		if (t.threadId === turn.threadId || !t.replyId) continue;
		const reply = await ctx.db.get(t.replyId);
		// The thread's own parent shows as the parent already.
		if (!reply || reply._id === turn.threadId || reply.quiet || reply.deleted || reply.status !== "done" || !reply.text.trim() || reply._creationTime <= after) continue;
		if (!(await here(reply)) || !(await readReply(ctx, member, reply))) continue;
		said.push(reply);
		if (said.length === ELSEWHERE_MAX) break;
	}
	return Promise.all(said.reverse().map(async (m) => ({ thread: !!m.threadId, message: await toPlaceMessage(ctx, m, names, tags, turn.agentId) })));
}

/** The agents one message went to before this pick, first first (router.apply runs them in turn). */
async function picksBefore(ctx: QueryCtx, turn: Doc<"agentTurns">, names: Namer) {
	const before: string[] = [];
	for (let t = turn; t.dispatch?.after && before.length < 10; ) {
		const prev = await ctx.db.get(t.dispatch.after);
		if (!prev) break;
		before.unshift((await names.agent(prev.agentId)).name);
		t = prev;
	}
	return before;
}

/** Who handed a chain turn its message: the agent that wrote it, privately or by @mention. */
async function handoffOf(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const trigger = turn.chain && turn.triggerId && !turn.approvalId && (await ctx.db.get(turn.triggerId));
	const from = trigger && trigger.authorAgentId && (await ctx.db.get(trigger.authorAgentId));
	return from ? { from: from.name, ask: !!turn.ask } : undefined;
}

/** Messages reacted to most recently. */
const REACTED_MAX = 10;

/** Messages in a place from `since` or before, reacted to after it, oldest first. */
async function reactedSince(ctx: QueryCtx, member: Member, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined, since: number, here: (m: Doc<"chatMessages">) => Promise<boolean>) {
	const rows = await ctx.db
		.query("reactions")
		.withIndex("by_chat", (q) => q.eq("chatId", chatId).gt("_creationTime", since))
		.order("desc")
		.take(100);
	const found: Doc<"chatMessages">[] = [];
	for (const id of new Set(rows.map((r) => r.messageId))) {
		const m = await ctx.db.get(id);
		if (m && !m.deleted && !m.quiet && m.threadId === threadId && m._creationTime <= since && await here(m) && await readReply(ctx, member, m)) found.push(m);
		if (found.length === REACTED_MAX) break;
	}
	return found.sort((a, b) => a._creationTime - b._creationTime);
}

async function toPlaceMessage(ctx: QueryCtx, m: Doc<"chatMessages">, names: Namer, tags: RecordTags, self: Id<"agents">, skills: Skill[] = []): Promise<PlaceMessage> {
	const { for: person, ...who } = await names.of(m);
	const author = { ...who, name: label({ ...who, for: person }) };
	const reactions = await reactionGroups(ctx, m._id, names);
	// Skills named with /, still installed. Gone ones are left out: the text still shows what was typed.
	const named = (m.mentions.skillIds ?? []).flatMap((id) => {
		const skill = skills.find((s) => s.id === id);
		return skill ? [{ id, name: skill.name }] : [];
	});
	return {
		id: m._id,
		author,
		// Tagged records as the agent writes them, by name if its person can see them (a source of the turn, then).
		text: textForModel({ ...m, text: await tags.forModel(m.text) }, m.authorAgentId === self ? "You" : author.name),
		time: m._creationTime,
		...(m.editedAt && { edited: true }),
		...(!m.threadId && m.replyCount && { replyCount: m.replyCount }),
		...(named.length > 0 && { skills: named }),
		...(m.attachments?.length && { files: filesForModel(m) }),
		...(reactions.length > 0 && { reactions }),
	};
}

/** Stored before the model call, so later turns replay it exactly. */
export const savePrompt = internalMutation({
	args: { turnId: v.id("agentTurns"), prompt: v.string() },
	handler: async (ctx, { turnId, prompt }) => {
		const { member } = await runningTurn(ctx, turnId);
		await ctx.db.patch(turnId, { prompt, promptPlaces: await turnSources(ctx, member) });
	},
});

/** One finished step of a running turn (agent.ts), kept for later turns to replay (core replay.ts keptStep). */
export const keepStep = internalMutation({
	args: { turnId: v.id("agentTurns"), messages: v.string() },
	handler: async (ctx, { turnId, messages }) => {
		const turn = await ctx.db.get(turnId);
		// Not into a workspace being deleted: its cascade may be past this table.
		if (!turn || turn.status !== "running" || !(await liveWorkspace(ctx, turn.workspaceId))) return;
		await ctx.db.insert("turnSteps", { workspaceId: turn.workspaceId, turnId, actorId: turn.actorId, messages });
	},
});

/**
 * What a running turn is doing now (agent.ts), shown under the composer (typing.ts); no label while
 * it writes. On the turn, not its reply, so a run that posts nothing still shows. Ignored once it ended.
 */
export const setStep = internalMutation({
	args: { turnId: v.id("agentTurns"), label: v.optional(v.string()) },
	handler: async (ctx, { turnId, label }) => {
		if ((await ctx.db.get(turnId))?.status !== "running") return;
		await ctx.db.patch(turnId, { step: label ? { label, at: Date.now() } : undefined });
	},
});

/** A streaming reply's content so far, kept apart from the message (schema `replyStreams`). */
export const streamOf = (ctx: QueryCtx, messageId: Id<"chatMessages">) =>
	ctx.db
		.query("replyStreams")
		.withIndex("by_message", (q) => q.eq("messageId", messageId))
		.first();

/**
 * Writes a streaming reply's content so far (~5×/s), and shows it once there's something to show.
 * `stopped`: someone pressed Stop on its turn (turns.stop), so the runner ends it; `steer`: its person
 * wrote meanwhile (steering).
 */
export const updateReply = internalMutation({
	args: { turnId: v.id("agentTurns"), text: v.string(), parts: v.array(messagePart) },
	handler: async (ctx, { turnId, text, parts }) => {
		const { lost, ...heard } = await turnState(ctx, turnId);
		const replyId = (await ctx.db.get(turnId))?.replyId;
		const reply = replyId && (await ctx.db.get(replyId));
		// Nothing more goes out as a person who can no longer post there; finishReply ends it.
		if (lost || !reply || reply.status !== "streaming") return heard;
		const { member } = await runningTurn(ctx, turnId);
		await inheritPlaces(ctx, member, await writeSources(ctx, member, { filtered: true, preserveOwn: true }));
		const stream = await streamOf(ctx, reply._id);
		if (stream) await ctx.db.patch(stream._id, { text, parts });
		else await ctx.db.insert("replyStreams", { messageId: reply._id, text, parts });
		if (showable(parts)) await show(ctx, reply);
		return heard;
	},
});

/** Whether a reply has something to show: its message, or a card the person must decide on. Its tool lines alone don't: the typing line shows the work. */
const showable = (parts: Doc<"chatMessages">["parts"]) => parts.some((p) => (p.type === "text" && !!p.text.trim()) || p.type === "approval");

/**
 * The one way an agent's reply appears: once it has something to show (updateReply), or when its turn
 * ends with an error. Placed where it's shown (`publishedAt`, so it sorts below what came in while it
 * worked) and counted then (unread, thread replies). Already shown: nothing changes.
 */
async function show(ctx: MutationCtx, reply: Doc<"chatMessages">) {
	if (!reply.quiet) return;
	await ctx.db.patch(reply._id, { quiet: undefined, publishedAt: Date.now() });
	await countMessage(ctx, (await ctx.db.get(reply.chatId))!, reply);
}

/**
 * Whether a turn's person lost what its reply needs since it began: to see the chat and post in it
 * (chatOps.canReplyAs). Its reply posts as them, so it stops where they'd be refused.
 */
async function lostReply(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const chat = await ctx.db.get(turn.chatId);
	if (!chat || !(await canReplyAs(ctx, chat, await memberOf(ctx, turn.actorId, turn.workspaceId)))) return "This person can no longer post in this chat.";
	return autonomyProblem(ctx, turn);
}

/**
 * What the runner should do now (agent.ts `turnStop`). `stopped`: end now (someone pressed Stop, it
 * isn't running anymore, failed as stale, or its person can no longer post there: `lost`). `steer`: its
 * person sent a message here meanwhile (steer).
 */
async function turnState(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const turn = await ctx.db.get(turnId);
	const lost = !!turn && turn.status === "running" && (await lostReply(ctx, turn));
	const stopped = !turn || turn.status !== "running" || !!turn.stopping || !!lost;
	return { stopped, steer: !stopped && (await steering(ctx, turn)).length > 0, lost };
}

/** For the runner between flushes and at each step (agent.ts `turnStop`). */
export const isStopping = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const { stopped, steer } = await turnState(ctx, turnId);
		return { stopped, steer };
	},
});

/**
 * A reply cut off to take in its person's messages waits for them to pause (agent.ts `turnStop`), so a
 * burst is taken in at once: `waitMs` until their newest one here is QUIET_WINDOW_MS old, 0 to go on.
 * `stopped`: end the turn instead.
 */
export const steerWait = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn || turn.status !== "running" || turn.stopping || (await lostReply(ctx, turn))) return { stopped: true, waitMs: 0 };
		// A person turn is queued with its message, in the same mutation (messages.send).
		const newest = Math.max(0, ...(await steering(ctx, turn)).map((t) => t._creationTime));
		return { stopped: false, waitMs: Math.max(0, newest + QUIET_WINDOW_MS - Date.now()) };
	},
});

/**
 * Whether a running turn takes in its person's new messages here (steering): one acting for someone who
 * is waiting on it, asked or picked for them (their DM, an @mention, a dispatcher pick, a hop or handoff,
 * an approval's follow-up). Not a wake (nobody asked; an ask's answer goes to an agent), not an automation
 * run's, not one being stopped, not one failing as stale.
 */
async function steerable(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	if (turn.status !== "running" || turn.stopping || turn.wakeupId || !turn.replyId) return false;
	if (Date.now() - (turn.startedAt ?? turn._creationTime) >= STALE_TURN_MS) return false;
	const trigger = turn.triggerId && (await ctx.db.get(turn.triggerId));
	return !trigger?.automation && !trigger?.external;
}

/**
 * Steering (#189): the queued person turns of the running turn's own person here (same actor, same chat
 * and thread) sent since it began. A message from you takes priority over the work, so it reaches this
 * turn (steer) instead of waiting for a follow-up. Every message you send where an agent is replying to
 * you queues one: your DM, an @mention, or an un-mentioned message (queueFollowUps). Only the turn's own
 * person: another person's message acts with their access, so it keeps its own turn.
 */
async function steering(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	if (!(await steerable(ctx, turn))) return [];
	const queued = (await turnsAt(ctx, turn, "queued").collect()).filter((t) => t.person && t.actorId === turn.actorId && t.triggerId);
	const reply = queued.length > 0 && (await ctx.db.get(turn.replyId!));
	if (!reply) return [];
	// Sent after its reply began: earlier ones were in its window (turnContext) and keep their own turn.
	const sent = await Promise.all(queued.map((t) => ctx.db.get(t.triggerId!)));
	return queued.filter((_, i) => (sent[i]?._creationTime ?? 0) > reply._creationTime);
}

/**
 * From messages.send: a person's message reaches every agent replying to them in its place, @mention or
 * not. For each running turn of theirs here (steerable) whose agent the message didn't already queue
 * (`queued`: their DM's agent, the ones @mentioned), this queues a person turn on it, which the running
 * turn takes in (steer). If it misses every chance (the reply ends first, or it restarted too often), it
 * runs as the follow-up, like the turn it was for: told it was a pick, after a pick or a hop. It isn't a
 * dispatcher pick (no cost, not counted in mightThisHour, no `after`/`then`).
 * Returns the agents it queued for.
 */
export async function queueFollowUps(ctx: MutationCtx, chat: Doc<"chats">, message: Doc<"chatMessages">, queued: Id<"agents">[]) {
	const actorId = message.authorUserId;
	if (!actorId) return [];
	const running = await ctx.db
		.query("agentTurns")
		.withIndex("by_chat", (q) => q.eq("chatId", chat._id).eq("threadId", message.threadId).eq("status", "running"))
		.take(20);
	const agents: Id<"agents">[] = [];
	for (const turn of running) {
		if (turn.actorId !== actorId || queued.includes(turn.agentId) || agents.includes(turn.agentId) || !(await steerable(ctx, turn))) continue;
		const dispatch = turn.routed && turn.dispatch && followUpDispatch(turn.dispatch);
		await enqueueTurn(ctx, chat, {
			agentId: turn.agentId,
			chatId: chat._id,
			threadId: message.threadId,
			triggerId: message._id,
			actorId,
			person: true,
			...(isHandoff(turn) && { handoff: true as const }),
			...(turn.routed && { routed: true as const, ...(dispatch && { dispatch }) }),
		});
		agents.push(turn.agentId);
	}
	return agents;
}

/** How sure the pick was, for a follow-up's prompt; not the pick itself (its call's cost, its place in line). */
const followUpDispatch = ({ after: _, then: __, costUsd: ___, ...rest }: NonNullable<Doc<"agentTurns">["dispatch"]>) => ({ ...rest, costUsd: 0 });

/**
 * Takes the person's new messages into the running turn (agent.ts, at a step boundary or a restart):
 * their queued turns are folded into it (`mergedInto`, no reply of their own), their messages appended
 * to its stored prompt (so later turns replay them) and listed on it (`steered`, so the next turn's
 * window leaves them out). Returns the note to append to the model's messages (core steerNote), or null.
 */
export const steer = internalMutation({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const turn = await ctx.db.get(turnId);
		const absorbed = turn ? await steering(ctx, turn) : [];
		if (!turn || absorbed.length === 0) return null;
		const { member } = await runningTurn(ctx, turnId);
		for (const t of absorbed) await ctx.db.patch(t._id, { status: "done", mergedInto: turnId, debouncing: undefined });
		const ids = [...new Set(absorbed.map((t) => t.triggerId!))];
		const candidates = (await Promise.all(ids.map((id) => ctx.db.get(id))))
			.filter((m): m is Doc<"chatMessages"> => !!m && !m.deleted)
			.sort((a, b) => a._creationTime - b._creationTime);
		const messages = [];
		for (const m of candidates) if (await readReply(ctx, member, m)) messages.push(m);
		if (messages.length === 0) return null;
		const names = namer(ctx);
		const skills = await installedSkills(ctx, turn.workspaceId, turn.actorId, member);
		const actor = { id: turn.actorId, name: (await names.user(turn.actorId)).name, timeZone: await timeZoneOf(ctx, turn.actorId) };
		const tags = recordTags(ctx, member);
		const note = steerNote(await Promise.all(messages.map((m) => toPlaceMessage(ctx, m, names, tags, turn.agentId, skills))), actor);
		await ctx.db.patch(turnId, {
			steered: [...(turn.steered ?? []), ...messages.map((m) => m._id)],
			...(turn.prompt !== undefined && { prompt: `${turn.prompt}\n\n${note}`, ...(turn.promptPlaces !== undefined && { promptPlaces: [...new Set([...turn.promptPlaces, ...await turnSources(ctx, member)])] }) }),
		});
		// It answers them now, so it shows below them. One not shown yet is placed when it's shown (show).
		const reply = await ctx.db.get(turn.replyId!);
		if (reply && !reply.quiet) await moveBelow(ctx, (await ctx.db.get(turn.chatId))!, reply);
		return { note, asked: messages.map((m) => m.text) };
	},
});

/** Who may stop a running turn: the person it runs for, or someone allowed to stop anyone's (`turns.stopAny`). */
export const canStopTurn = (member: Member, turn: Doc<"agentTurns">) => turn.actorId === member.userId || can(member, "turns.stopAny");

/**
 * Stop: ends a running turn early. Convex can't kill a running action, so this only marks it; the
 * runner sees it on its next flush or step and ends (agent.ts `turnStop`): a tool call already running
 * finishes, nothing after it runs, nothing done is undone. finishReply keeps the partial reply, marked
 * stopped, and starts the next queued turn. A UI control only: a message saying "stop" is just a message.
 */
export const stop = mutation({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const member = await requireMember(ctx);
		const turn = await ctx.db.get(turnId);
		if (!turn || turn.workspaceId !== member.workspaceId) throw new ConvexError("Reply not found.");
		await requireChat(ctx, member, turn.chatId);
		if (!canStopTurn(member, turn)) throw new ConvexError(`The agent is working for ${await nameOf(ctx, turn.actorId)}. ${deniedMessage("turns.stopAny", member.workspaceRoles)}`);
		// Already over (or already stopping): nothing to do.
		if (turn.status !== "running" || turn.stopping) return;
		await ctx.db.patch(turnId, { stopping: { by: member.userId, at: Date.now() } });
	},
});

/** A reply stops streaming: what it streamed moves onto the message, in one write. */
async function endStream(ctx: MutationCtx, reply: Doc<"chatMessages">, end: Partial<Doc<"chatMessages">>) {
	const stream = await streamOf(ctx, reply._id);
	await ctx.db.patch(reply._id, { ...(stream && { text: stream.text, parts: stream.parts }), ...end });
	if (stream) await ctx.db.delete(stream._id);
}

/**
 * The records a finished reply tags (`[@Name](record:id)`, the agent's choice: nothing here looks for names),
 * kept as ids when its person can see them, like a person's message (messages.sendMessage); the rest stay as
 * the names it wrote. So "I added [@Summit Homes](record:…) to Clients" links the record, and the record lists the reply.
 */
async function tagReply(ctx: MutationCtx, turn: Doc<"agentTurns">, replyId: Id<"chatMessages">) {
	const reply = await ctx.db.get(replyId);
	const member = await memberOf(ctx, turn.actorId, turn.workspaceId);
	if (!reply || !member || ![reply.text, ...reply.parts.map((p) => (p.type === "text" ? p.text : ""))].some((t) => t.includes("record:"))) return;
	const { text, recordIds } = await storeTags(ctx, member, reply.text);
	const ids = new Set(recordIds);
	const parts = await Promise.all(
		reply.parts.map(async (p) => {
			if (p.type !== "text") return p;
			const stored = await storeTags(ctx, member, p.text);
			for (const id of stored.recordIds) ids.add(id);
			return { ...p, text: stored.text };
		}),
	);
	await ctx.db.patch(reply._id, { text, parts, mentions: { ...reply.mentions, ...(ids.size > 0 && { recordIds: [...ids] }) } });
	await syncRecordMentions(ctx, reply, [...ids]);
}

/** The running cost on a place: the thread parent, or the chat's activity. */
async function addPlaceCost(ctx: MutationCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined, cost: number) {
	if (!threadId) {
		const chat = await ctx.db.get(chatId);
		if (!chat) return cost;
		const costUsd = (await activityOf(ctx, chat)).costUsd + cost;
		await setActivity(ctx, chat, { costUsd });
		return costUsd;
	}
	const place = await ctx.db.get(threadId);
	const costUsd = (place?.costUsd ?? 0) + cost;
	if (place) await ctx.db.patch(place._id, { costUsd });
	return costUsd;
}

/**
 * A paid call a turn made besides its model calls (pictures in imageGen.ts, searches in
 * addSearchCost): on its place's running cost now, and on its reply's stats when it finishes.
 */
export async function addTurnCost(ctx: MutationCtx, turn: Doc<"agentTurns">, field: "imageCostUsd" | "searchCostUsd", cost: number) {
	await addPlaceCost(ctx, turn.chatId, turn.threadId, cost);
	await ctx.db.patch(turn._id, { [field]: (turn[field] ?? 0) + cost });
}

/** One web search finished (agent.ts webClient): its cost, for the turn's person and agent, as kind "search". */
export const addSearchCost = internalMutation({
	args: { turnId: v.id("agentTurns"), model: v.string(), costUsd: v.number() },
	handler: async (ctx, { turnId, model, costUsd }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn) return;
		const counted = await recordUsage(ctx, { workspaceId: turn.workspaceId, userId: turn.actorId, agentId: turn.agentId, kind: "search", model, costUsd });
		if (counted) await addTurnCost(ctx, turn, "searchCostUsd", costUsd);
	},
});

type SavedUsage = NonNullable<Doc<"agentTurns">["usage"]>;

/**
 * Saves what a turn's model calls used so far and records only what's new since the last save, on
 * the place's, session's and month's (`usage`, kind "chat") cost. Totals only grow, so saving the
 * same calls again, or an older total late, records nothing twice.
 */
async function saveTurnUsage(ctx: MutationCtx, turn: Doc<"agentTurns">, usage: Infer<typeof replyUsage>): Promise<SavedUsage> {
	const before = turn.usage;
	if (before && usage.steps < before.steps) return before;
	const cost = usage.costUsd - (before?.costUsd ?? 0);
	if (cost > 0) {
		await addPlaceCost(ctx, turn.chatId, turn.threadId, cost);
		const session = turn.sessionId && (await ctx.db.get(turn.sessionId));
		if (session) await ctx.db.patch(session._id, { costUsd: (session.costUsd ?? 0) + cost });
	}
	// The reply ran for the person whose turn it was: who wrote the message, or an automation's person.
	const counted = (await recordUsage(ctx, { workspaceId: turn.workspaceId, userId: turn.actorId, agentId: turn.agentId, kind: "chat", model: usage.model, costUsd: cost })) || !!before?.counted;
	const saved = { ...usage, ...(counted && { counted }) };
	await ctx.db.patch(turn._id, { usage: saved });
	return saved;
}

/** A reply's stats: its model calls, its pictures and searches apart (already in `usage` as their own kinds), and its place's total. */
async function statsOf(ctx: QueryCtx, turn: Doc<"agentTurns">, usage: SavedUsage): Promise<Infer<typeof replyStats>> {
	const chat = turn.threadId ? null : await ctx.db.get(turn.chatId);
	const place = turn.threadId ? (await ctx.db.get(turn.threadId))?.costUsd : chat ? (await activityOf(ctx, chat)).costUsd : 0;
	return {
		...usage,
		conversationCostUsd: place ?? 0,
		...(turn.imageCostUsd && { imageCostUsd: turn.imageCostUsd }),
		...(turn.searchCostUsd && { searchCostUsd: turn.searchCostUsd }),
		...(turn.dispatch && { dispatch: pickOf(turn.dispatch) }),
	};
}

const pickOf = ({ after: _, then: __, ...dispatch }: NonNullable<Doc<"agentTurns">["dispatch"]>) => dispatch;

/** After each finished model call (agent.ts), so its cost is recorded even if the action dies before finishReply. */
export const saveUsage = internalMutation({
	args: { turnId: v.id("agentTurns"), usage: replyUsage },
	handler: async (ctx, { turnId, usage }) => {
		const turn = await ctx.db.get(turnId);
		if (turn) await saveTurnUsage(ctx, turn, usage);
	},
});

/** Ends a turn, records what it cost that wasn't saved yet, and starts the next queued turn in the place. */
export const finishReply = internalMutation({
	args: {
		turnId: v.id("agentTurns"),
		error: v.optional(v.string()),
		/** Left out when no model call finished. */
		usage: v.optional(replyUsage),
		/** What it posts and reacts (core postDecision); left out when it made none (it failed, was stopped, or stopped for an approval). */
		decision: v.optional(postDecision),
	},
	handler: async (ctx, { turnId, error: failed, usage, decision }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn) return;
		const saved = usage ? await saveTurnUsage(ctx, turn, usage) : turn.usage;
		const stats = saved && (await statsOf(ctx, turn, saved));
		const reply = turn.replyId && (await ctx.db.get(turn.replyId));
		// A turn already failed as stale only gets its stats; the queue moved on without it.
		if (turn.status !== "running") {
			if (reply && stats) await ctx.db.patch(reply._id, { stats });
			return;
		}
		// Stopped (turns.stop): what it wrote and did stays, marked stopped, and it ends like a failure, minus the
		// error: no handoff, no answer, no reaction, and an ask's asker hears it was stopped.
		// Aborting can surface as an error; the stop is what happened.
		const stopped = turn.stopping;
		// Its person may have lost the chat, or Post in it, while it ran: then it fails, nothing it wrote since
		// (updateReply) goes out, and it makes no decision: no reaction, no handoff.
		const lost = await lostReply(ctx, turn);
		let decided = stopped || lost ? undefined : decision;
		let error = lost ?? (stopped ? undefined : failed);
		// The decision can follow restricted tool reads. Its reaction must fit the trigger's audience.
		if (!error && responseOf(decided).emoji && turn.triggerId) {
			const trigger = await ctx.db.get(turn.triggerId);
			if (trigger) try {
				const { member } = await runningTurn(ctx, turnId);
				await requireReactionAudience(ctx, member, trigger);
			} catch (e) {
				if (!(e instanceof ConvexError)) throw e;
				error = String(e.data);
				decided = undefined;
			}
		}
		const { emoji } = responseOf(decided);
		const parts = reply ? ((await streamOf(ctx, reply._id))?.parts ?? reply.parts) : [];
		// Shown if it has something to show (its message, a card, a stopped reply's message so far) or failed;
		// with nothing, it stays hidden (or goes again: a restart dropped its draft and it ended with no message).
		// A lost one stays as it was: shown only if it already was.
		const shown = !!reply && (lost ? !reply.quiet : !!error || showable(parts));
		if (reply) {
			const end = error ? { status: "error" as const, error } : { status: "done" as const, ...(stopped && { stoppedBy: stopped.by }) };
			await endStream(ctx, reply, { ...end, stats, ...(!shown && { quiet: true as const }) });
			if (shown && !lost) await tagReply(ctx, turn, reply._id);
			if (shown) { await show(ctx, reply); await integrationEvent(ctx, turn.workspaceId, "message.updated", reply._id); }
			if (shown && !error) await previewMessage(ctx, (await ctx.db.get(reply._id))!);
			if (shown && !error) await ctx.scheduler.runAfter(1000, internal.mobileNotifications.enqueue, { messageId: reply._id });
		}
		await ctx.db.patch(turnId, { status: error ? "error" : "done", step: undefined, decision: decided });
		// Its reaction: on the message it answers (a wake has none), as the agent.
		const trigger = !error && emoji && turn.triggerId && (await ctx.db.get(turn.triggerId));
		const agent = trigger && (await ctx.db.get(turn.agentId));
		if (emoji && trigger && agent) await reactOnce(ctx, trigger, agent, emoji);
		await setWakeOutcome(ctx, turn, error || stopped ? "failed" : shown ? "notified" : "ran");
		await settleApproval(ctx, turn);
		// A pick that waited for this one goes first: it's older than any handoff this turn makes, and an agent
		// runs one turn at a time in a chat (startNext), so a handoff to it waits behind it.
		await startThen(ctx, turn);
		// Agents it @mentioned or named take the work on (chains.ts); an asked agent's answer goes back to the asker.
		if (!error && !stopped) await handOff(ctx, (await ctx.db.get(turnId))!, decided?.to);
		await answerAsk(ctx, turn, error ?? (stopped ? "it was stopped" : undefined));
		await startInChat(ctx, turn);
	},
});

/**
 * Marks the session as compacting and returns the turns to fold into its summary,
 * oldest first, keeping the newest ~KEEP_TOKENS (at least one turn) verbatim.
 * Null if there's nothing to fold.
 */
export const startCompaction = internalMutation({
	args: { sessionId: v.id("agentSessions"), keepTokens: v.optional(v.number()) },
	handler: async (ctx, { sessionId, keepTokens = KEEP_TOKENS }) => {
		const session = await ctx.db.get(sessionId);
		if (!session || session.compacting) return null;
		const turns = await sessionTurns(ctx, session);
		let keep = 0;
		let tokens = 0;
		for (const t of turns.toReversed()) {
			tokens += approxTokens(t.prompt + t.steps + t.answer);
			if (keep > 0 && tokens > keepTokens) break;
			keep++;
		}
		const old = turns.slice(0, turns.length - keep);
		if (old.length === 0) return null;
		await ctx.db.patch(sessionId, { compacting: true, compactingPrivacy: 1, compactingPlaces: [...new Set([...(session.summaryPlaces ?? []), ...old.flatMap((t) => t.usedPlaces)])] });
		return { summary: session.summaryPrivacy === 1 ? session.summary ?? null : null, turns: old.map(({ prompt, calls, answer }) => ({ prompt, calls, answer })), upTo: old.at(-1)!.time };
	},
});

/** Ends compaction. Without `result` (the summary call failed) nothing else changes. */
export const finishCompaction = internalMutation({
	args: {
		sessionId: v.id("agentSessions"),
		/** The turn that triggered it: the summary is counted as that person's. */
		turnId: v.optional(v.id("agentTurns")),
		result: v.optional(v.object({ summary: v.string(), upTo: v.number(), costUsd: v.number(), model: v.optional(v.string()) })),
	},
	handler: async (ctx, { sessionId, turnId, result }) => {
		const session = await ctx.db.get(sessionId);
		if (!session) return;
		if (!result) return await ctx.db.patch(sessionId, { compacting: false, compactingPlaces: undefined, compactingPrivacy: undefined });
		await ctx.db.patch(sessionId, {
			compacting: false,
			// A pre-deploy model call did not snapshot private prompt sources; discard its text.
			...(session.compactingPrivacy === 1 && { summary: result.summary, summaryPlaces: session.compactingPlaces, summaryPrivacy: 1 as const, summarizedUpTo: result.upTo }),
			compactingPlaces: undefined,
			compactingPrivacy: undefined,
			costUsd: (session.costUsd ?? 0) + result.costUsd,
		});
		await addPlaceCost(ctx, session.chatId, session.threadId, result.costUsd);
		const turn = turnId && (await ctx.db.get(turnId));
		await recordUsage(ctx, { workspaceId: session.workspaceId, userId: turn ? turn.actorId : undefined, agentId: session.agentId, kind: "summary", model: result.model, costUsd: result.costUsd });
	},
});

/**
 * Who a turn's prompt names in its chat: its live agents, and `people` still in it (the asker, the
 * authors in view), with the rest counted. A few indexed reads, however big the channel is.
 */
async function placeMembers(ctx: QueryCtx, chat: Doc<"chats">, people: (Id<"users"> | undefined)[], names: Namer) {
	const members: (Participant & { role?: string })[] = [];
	for (const id of new Set(people)) if (id && (await membership(ctx, chat._id, id))) members.push(await names.user(id));
	let seated = members.length;
	// Archived agents keep their seats: counted, not named.
	for (const agent of await ctx.db.query("agents").withIndex("by_workspace", (q) => q.eq("workspaceId", chat.workspaceId)).collect()) {
		if (!(await ctx.db.query("chatMembers").withIndex("by_agent", (q) => q.eq("agentId", agent._id).eq("chatId", chat._id)).first())) continue;
		seated++;
		if (!agent.archived) members.push({ ...(await names.agent(agent._id)), role: agent.description });
	}
	// COMPAT(0.1.0-alpha.10): an uncounted chat (before migrations.chatMemberCounts) counts none; drop `?? 0` with it.
	return { members, others: Math.max((chat.memberCount ?? 0) - seated, 0) };
}
