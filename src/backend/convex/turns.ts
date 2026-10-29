import type { PlaceMessage, Skill } from "@companybot/core";
import { PROMPT_MESSAGE_CAP, approxTokens, fallbackModels } from "@companybot/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import {
	type Namer,
	canSee,
	chatMembersOf,
	insertMessage,
	namer,
	replyForModel,
	textForModel,
} from "./chatOps";
import { previewMessage } from "./linkPreviews";
import { type Who, installedSkills, liveWorkspace, memberOf, timeZoneOf } from "./lib";
import { automationScope } from "./automationOps";
import { messagePart, replyUsage } from "./schema";
import { filesForModel, turnImages } from "./files";
import { catalogModels } from "./modelCatalog";
import { recordUsage } from "./usage";

// The agent turn queue and everything the runner (agent.ts) reads and writes.
// One `running` turn per agent per place (chat + thread); the rest wait in order.

/** A running turn this old (e.g. the action crashed) is failed so the queue moves on. */
export const STALE_TURN_MS = 5 * 60_000;
/** Newest turns kept verbatim when a session is compacted. */
const KEEP_TOKENS = 15_000;

type Place = { agentId: Id<"agents">; chatId: Id<"chats">; threadId?: Id<"chatMessages"> };

/** Queues a reply from `agentId` to `triggerId`, and starts it if nothing is running there. */
export async function enqueueTurn(
	ctx: MutationCtx,
	chat: Doc<"chats">,
	turn: Place & { actorId: Id<"users"> } & (
			// After an approval, the original turn's trigger: none if it followed an old welcome turn.
			| { triggerId: Id<"chatMessages">; approvalId?: Id<"approvals"> }
			| { triggerId: Id<"chatMessages"> | undefined; approvalId: Id<"approvals"> }
		),
) {
	await ctx.db.insert("agentTurns", { ...turn, workspaceId: chat.workspaceId, status: "queued" });
	await startNext(ctx, turn);
}

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
	if (approval?.status === "running")
		await ctx.db.patch(approval._id, {
			status: "failed",
			error: "The reply stopped while it was running, so it may or may not have happened. Check before trying again.",
		});
}

/** Starts the oldest queued turn in a place, unless one is running (a stale one is failed first). */
async function startNext(ctx: MutationCtx, { agentId, chatId, threadId }: Place) {
	const place = { agentId, chatId, threadId };
	const running = await turnsAt(ctx, place, "running").first();
	if (running) {
		if (Date.now() - (running.startedAt ?? running._creationTime) < STALE_TURN_MS) return;
		await ctx.db.patch(running._id, { status: "error" });
		await settleApproval(ctx, running);
		const reply = running.replyId && (await ctx.db.get(running.replyId));
		if (reply?.status === "streaming") await endStream(ctx, reply, { status: "error", error: "Reply timed out." });
	}
	const next = await turnsAt(ctx, place, "queued").first();
	if (!next) return;
	const chat = await ctx.db.get(next.chatId);
	// A workspace being deleted starts nothing: its cascade may already be past the rows this would add.
	if (!chat || chat.archived || !(await liveWorkspace(ctx, chat.workspaceId))) {
		await ctx.db.patch(next._id, { status: "error" });
		return await settleApproval(ctx, next);
	}

	const session =
		(await sessionAt(ctx, place)) ??
		(await ctx.db.get(await ctx.db.insert("agentSessions", { workspaceId: chat.workspaceId, ...place })))!;
	const replyId = await insertMessage(ctx, chat, {
		threadId: place.threadId,
		authorAgentId: place.agentId,
		text: "",
		parts: [],
		mentions: { userIds: [], agentIds: [] },
		status: "streaming",
	});
	await ctx.db.patch(next._id, { status: "running", replyId, sessionId: session._id, startedAt: Date.now() });
	await ctx.scheduler.runAfter(0, internal.agent.respond, { turnId: next._id });
}

/** A session's finished, unsummarized turns as they replay to the model, oldest first. */
async function sessionTurns(ctx: QueryCtx, session: Doc<"agentSessions">) {
	const turns = await ctx.db
		.query("agentTurns")
		.withIndex("by_session", (q) => q.eq("sessionId", session._id).gt("_creationTime", session.summarizedUpTo ?? 0))
		.collect();
	const finished = turns.filter((t) => (t.status === "done" || t.status === "error") && t.prompt !== undefined);
	return Promise.all(
		finished.map(async (t) => {
			const reply = t.replyId && (await ctx.db.get(t.replyId));
			return { prompt: t.prompt!, reply: reply ? replyForModel(reply) : "", time: t._creationTime };
		}),
	);
}

/** The running turn, its person (read fresh), and the chat, if they can still see it. */
export async function runningTurn(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const turn = await ctx.db.get(turnId);
	if (!turn || turn.status !== "running" || !turn.replyId || !turn.sessionId) throw new Error("This reply was stopped.");
	const member = await memberOf(ctx, turn.actorId, turn.workspaceId);
	if (!member) throw new Error("This person is no longer in the workspace.");
	const chat = await ctx.db.get(turn.chatId);
	if (!chat || chat.archived || !(await canSee(ctx, chat, member))) throw new Error("This person can no longer see this chat.");
	const who: Who = { member, agentId: turn.agentId };
	return { turn: turn as Doc<"agentTurns"> & { replyId: Id<"chatMessages">; sessionId: Id<"agentSessions"> }, member, chat, who };
}

/** Whether agents use memories here: owners can turn it off for the workspace (Settings → General). */
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
export const turnContext = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const { turn, member, chat } = await runningTurn(ctx, turnId);
		const agent = await ctx.db.get(turn.agentId);
		if (!agent || agent.archived) throw new Error("This agent is in Trash.");
		const session = (await ctx.db.get(turn.sessionId))!;
		const reply = (await ctx.db.get(turn.replyId))!;
		const names = namer(ctx);
		const { trigger, foreign } = await automationScope(ctx, turn);

		// Finished turns only, so never this (running) one.
		const turns = (foreign ? [] : await sessionTurns(ctx, session)).map(({ prompt, reply }) => ({ prompt, reply }));

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
		// Foreign runs get only their trigger, or replies in a thread rooted at that trigger.
		// Never replay the person's DM/channel history, including compacted session summaries.
		const recent = foreign && turn.threadId !== trigger?._id ? (trigger ? [trigger] : []) : (
			await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_thread", (q) =>
					q.eq("chatId", chat._id).eq("threadId", turn.threadId).gt("_creationTime", since).lt("_creationTime", reply._creationTime),
				)
				.order("desc")
				.filter((q) => q.neq(q.field("deleted"), true))
				// The prompt shows PROMPT_MESSAGE_CAP; one more says there are earlier ones, one more for the trigger.
				.take(PROMPT_MESSAGE_CAP + 2)
		).reverse();
		// A turn after an approval answers the decision, not a message.
		const approval = turn.approvalId && (await ctx.db.get(turn.approvalId));
		if (!approval && turn.triggerId && !recent.some((m) => m._id === turn.triggerId)) {
			const trigger = await ctx.db.get(turn.triggerId);
			if (trigger) recent.push(trigger);
		}
		const skills = await installedSkills(ctx, chat.workspaceId);
		const messages = await Promise.all(
			recent
				.filter((m) => !m.deleted)
				// Another agent's reply still streaming keeps its text so far apart from the message.
				.map(async (m) => {
					const stream = m.status === "streaming" && (await streamOf(ctx, m._id));
					return toPlaceMessage(stream ? { ...m, text: stream.text, parts: stream.parts } : m, names, agent._id, skills);
				}),
		);

		const parent = turn.threadId && (!foreign || turn.threadId === trigger?._id) && (await ctx.db.get(turn.threadId));
		// What the person wrote, the only links web.fetch opens before searching: this turn's messages,
		// the thread's parent, and after an approval the message that started it (it's before the window).
		const own = (m: Doc<"chatMessages"> | null | undefined | false): m is Doc<"chatMessages"> => !!m && !m.deleted && m.authorUserId === member.userId;
		const origin = approval && turn.triggerId && (await ctx.db.get(turn.triggerId));
		const asked = [...recent, parent, origin].filter(own).map((m) => m.text);
		/** A thread's first turn starts with its parent. */
		const first = turns.length === 0 && (foreign || !session.summary);
		const rows = await chatMembersOf(ctx, chat._id);
		const { models } = await catalogModels(ctx);
		const vision = [models, fallbackModels].some((list) => list.find((m) => m.id === agent.model)?.vision);
		const user = await ctx.db.get(member.userId);
		return {
			replyId: turn.replyId,
			member,
			agent: { id: agent._id, name: agent.name, instructions: agent.instructions, model: agent.model, tools: agent.tools },
			skills,
			session: { id: session._id, summary: foreign ? null : (session.summary ?? null), turns },
			/** Off when an owner turned it off; personal only in a DM with exactly one person. memory.ts checks again on every call. */
			memory: !(await memoryOn(ctx, chat.workspaceId)) ? ("off" as const) : (await personalMemoryHere(ctx, chat)) ? ("personal" as const) : ("team" as const),
			actor: {
				id: member.userId,
				name: (await names.user(member.userId)).name,
				email: user?.email ?? "",
				role: member.role,
				timeZone: await timeZoneOf(ctx, member.userId),
			},
			place: {
				kind: chat.kind,
				name: chat.name ?? null,
				private: chat.private,
				topic: chat.topic ?? null,
				thread: parent
					? { parent: await toPlaceMessage(parent, names, agent._id), first }
					: null,
				members: await Promise.all(rows.map(names.of)),
			},
			messages,
			asked,
			triggerId: turn.triggerId ?? null,
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

async function toPlaceMessage(m: Doc<"chatMessages">, names: Namer, self: Id<"agents">, skills: Skill[] = []): Promise<PlaceMessage> {
	const author = await names.of(m);
	// Skills named with /, still installed. Gone ones are left out: the text still shows what was typed.
	const named = (m.mentions.skillIds ?? []).flatMap((id) => {
		const skill = skills.find((s) => s.id === id);
		return skill ? [{ id, name: skill.name }] : [];
	});
	return {
		id: m._id,
		author,
		text: textForModel(m, m.authorAgentId === self ? "You" : author.name),
		time: m._creationTime,
		...(m.editedAt && { edited: true }),
		...(!m.threadId && m.replyCount && { replyCount: m.replyCount }),
		...(named.length > 0 && { skills: named }),
		...(m.attachments?.length && { files: filesForModel(m) }),
	};
}

/** Stored before the model call, so later turns replay it exactly. */
export const savePrompt = internalMutation({
	args: { turnId: v.id("agentTurns"), prompt: v.string() },
	handler: async (ctx, { turnId, prompt }) => ctx.db.patch(turnId, { prompt }),
});

/** A streaming reply's content so far, kept apart from the message (schema `replyStreams`). */
export const streamOf = (ctx: QueryCtx, messageId: Id<"chatMessages">) =>
	ctx.db
		.query("replyStreams")
		.withIndex("by_message", (q) => q.eq("messageId", messageId))
		.first();

export const updateReply = internalMutation({
	args: { replyId: v.id("chatMessages"), text: v.string(), parts: v.array(messagePart) },
	handler: async (ctx, { replyId, text, parts }) => {
		if ((await ctx.db.get(replyId))?.status !== "streaming") return;
		const stream = await streamOf(ctx, replyId);
		if (stream) await ctx.db.patch(stream._id, { text, parts });
		else await ctx.db.insert("replyStreams", { messageId: replyId, text, parts });
	},
});

/** A reply stops streaming: what it streamed moves onto the message, in one write. */
async function endStream(ctx: MutationCtx, reply: Doc<"chatMessages">, end: Partial<Doc<"chatMessages">>) {
	const stream = await streamOf(ctx, reply._id);
	await ctx.db.patch(reply._id, { ...(stream && { text: stream.text, parts: stream.parts }), ...end });
	if (stream) await ctx.db.delete(stream._id);
}

/** The running cost on a place: the thread parent, or the chat. */
async function addPlaceCost(ctx: MutationCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined, cost: number) {
	const place = threadId ? await ctx.db.get(threadId) : await ctx.db.get(chatId);
	const costUsd = (place?.costUsd ?? 0) + cost;
	if (place) await ctx.db.patch(place._id, { costUsd });
	return costUsd;
}

/** Ends a turn, records what it cost, and starts the next queued turn in the place. */
export const finishReply = internalMutation({
	args: {
		turnId: v.id("agentTurns"),
		error: v.optional(v.string()),
		/** Left out when no model call finished. */
		usage: v.optional(replyUsage),
	},
	handler: async (ctx, { turnId, error, usage }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn) return;
		const cost = usage?.costUsd ?? 0;
		const placeCost = await addPlaceCost(ctx, turn.chatId, turn.threadId, cost);
		const session = turn.sessionId && (await ctx.db.get(turn.sessionId));
		if (session) await ctx.db.patch(session._id, { costUsd: (session.costUsd ?? 0) + cost });
		// The reply ran for the person whose turn it was: who wrote the message, or an automation's person.
		const counted = !!usage && (await recordUsage(ctx, { workspaceId: turn.workspaceId, userId: turn.actorId, agentId: turn.agentId, kind: "chat", model: usage.model, costUsd: cost }));
		const stats = usage && { ...usage, conversationCostUsd: placeCost, ...(counted && { counted }) };
		const reply = turn.replyId && (await ctx.db.get(turn.replyId));
		// A turn already failed as stale only gets its stats; the queue moved on without it.
		if (turn.status !== "running") {
			if (reply && stats) await ctx.db.patch(reply._id, { stats });
			return;
		}
		if (reply) {
			await endStream(ctx, reply, error ? { status: "error", error, stats } : { status: "done", stats });
			if (!error) await previewMessage(ctx, (await ctx.db.get(reply._id))!);
		}
		await ctx.db.patch(turnId, { status: error ? "error" : "done" });
		await settleApproval(ctx, turn);
		await startNext(ctx, turn);
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
			tokens += approxTokens(t.prompt + t.reply);
			if (keep > 0 && tokens > keepTokens) break;
			keep++;
		}
		const old = turns.slice(0, turns.length - keep);
		if (old.length === 0) return null;
		await ctx.db.patch(sessionId, { compacting: true });
		return { summary: session.summary ?? null, turns: old.map(({ prompt, reply }) => ({ prompt, reply })), upTo: old.at(-1)!.time };
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
		if (!result) return await ctx.db.patch(sessionId, { compacting: false });
		await ctx.db.patch(sessionId, {
			compacting: false,
			summary: result.summary,
			summarizedUpTo: result.upTo,
			costUsd: (session.costUsd ?? 0) + result.costUsd,
		});
		await addPlaceCost(ctx, session.chatId, session.threadId, result.costUsd);
		const turn = turnId && (await ctx.db.get(turnId));
		await recordUsage(ctx, { workspaceId: session.workspaceId, userId: turn ? turn.actorId : undefined, agentId: session.agentId, kind: "summary", model: result.model, costUsd: result.costUsd });
	},
});
