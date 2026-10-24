import type { ChatLine, ChatResult, PlaceMessage } from "@companybot/core";
import { approxTokens } from "@companybot/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import {
	type Namer,
	canSee,
	chatLabel,
	chatMembersOf,
	insertMessage,
	namer,
	normalizeChannelName,
	reactionsOf,
	replyForModel,
	textForModel,
	toggleReaction,
} from "./chatOps";
import { type Member, installedSkills, memberOf, timeZoneOf } from "./lib";
import { messagePart, replyUsage } from "./schema";

// The agent turn queue and everything the runner (agent.ts) reads and writes.
// One `running` turn per agent per place (chat + thread); the rest wait in order.

/** A running turn this old (e.g. the action crashed) is failed so the queue moves on. */
const STALE_TURN_MS = 5 * 60_000;
/** Newest turns kept verbatim when a session is compacted. */
const KEEP_TOKENS = 15_000;

type Place = { agentId: Id<"agents">; chatId: Id<"chats">; threadId?: Id<"chatMessages"> };

/** Queues a reply from `agentId` to `triggerId`, and starts it if nothing is running there. */
export async function enqueueTurn(
	ctx: MutationCtx,
	chat: Doc<"chats">,
	turn: Place & { triggerId: Id<"chatMessages">; actorId: Id<"users"> },
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

/** Starts the oldest queued turn in a place, unless one is running (a stale one is failed first). */
async function startNext(ctx: MutationCtx, { agentId, chatId, threadId }: Place) {
	const place = { agentId, chatId, threadId };
	const running = await turnsAt(ctx, place, "running").first();
	if (running) {
		if (Date.now() - (running.startedAt ?? running._creationTime) < STALE_TURN_MS) return;
		await ctx.db.patch(running._id, { status: "error" });
		const reply = running.replyId && (await ctx.db.get(running.replyId));
		if (reply?.status === "streaming") await ctx.db.patch(reply._id, { status: "error", error: "Reply timed out." });
	}
	const next = await turnsAt(ctx, place, "queued").first();
	if (!next) return;
	const chat = await ctx.db.get(next.chatId);
	if (!chat) return await ctx.db.patch(next._id, { status: "error" });

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
async function runningTurn(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const turn = await ctx.db.get(turnId);
	if (!turn || turn.status !== "running" || !turn.replyId || !turn.sessionId) throw new Error("This reply was stopped.");
	const member = await memberOf(ctx, turn.actorId);
	if (member?.workspaceId !== turn.workspaceId) throw new Error("This person is no longer in the workspace.");
	const chat = await ctx.db.get(turn.chatId);
	if (!chat || !(await canSee(ctx, chat, member))) throw new Error("This person can no longer see this chat.");
	return { turn: turn as Doc<"agentTurns"> & { replyId: Id<"chatMessages">; sessionId: Id<"agentSessions"> }, member, chat };
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
		if (!agent || agent.archived) throw new Error("This agent is archived.");
		const session = (await ctx.db.get(turn.sessionId))!;
		const reply = (await ctx.db.get(turn.replyId))!;
		const names = namer(ctx);

		// Finished turns only, so never this (running) one.
		const turns = (await sessionTurns(ctx, session)).map(({ prompt, reply }) => ({ prompt, reply }));

		// What's new: everything in the place after the last turn's reply started.
		const last = (
			await ctx.db
				.query("agentTurns")
				.withIndex("by_session", (q) => q.eq("sessionId", session._id))
				.order("desc")
				.take(20)
		).find((t) => t._id !== turnId && t.prompt !== undefined);
		const lastReply = last?.replyId && (await ctx.db.get(last.replyId));
		const since = lastReply?._creationTime ?? last?.startedAt ?? 0;
		const recent = (
			await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_thread", (q) =>
					q.eq("chatId", chat._id).eq("threadId", turn.threadId).gt("_creationTime", since).lt("_creationTime", reply._creationTime),
				)
				.order("desc")
				.take(200)
		).reverse();
		if (!recent.some((m) => m._id === turn.triggerId)) {
			const trigger = await ctx.db.get(turn.triggerId);
			if (trigger) recent.push(trigger);
		}
		const messages = await Promise.all(
			recent.filter((m) => !m.deleted && (m.status !== "streaming" || m.text)).map((m) => toPlaceMessage(m, names, agent._id)),
		);

		const parent = turn.threadId && (await ctx.db.get(turn.threadId));
		const rows = await chatMembersOf(ctx, chat._id);
		const people = rows.filter((r) => r.userId).length;
		const user = await ctx.db.get(member.userId);
		return {
			replyId: turn.replyId,
			member,
			agent: { id: agent._id, name: agent.name, instructions: agent.instructions, model: agent.model, tools: agent.tools },
			skills: await installedSkills(ctx, chat.workspaceId),
			session: { id: session._id, summary: session.summary ?? null, turns },
			/** Personal memories only in a DM with exactly one person. */
			memory: chat.kind === "dm" && people === 1 ? ("personal" as const) : ("team" as const),
			actor: {
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
					? { parent: await toPlaceMessage(parent, names, agent._id), first: turns.length === 0 && !session.summary }
					: null,
				members: await Promise.all(rows.map(names.of)),
			},
			messages,
			triggerId: turn.triggerId as string,
		};
	},
});

async function toPlaceMessage(m: Doc<"chatMessages">, names: Namer, self: Id<"agents">): Promise<PlaceMessage> {
	const author = await names.of(m);
	return {
		id: m._id,
		author,
		text: textForModel(m, m.authorAgentId === self ? "You" : author.name),
		time: m._creationTime,
		...(m.editedAt && { edited: true }),
		...(!m.threadId && m.replyCount && { replyCount: m.replyCount }),
	};
}

/** Stored before the model call, so later turns replay it exactly. */
export const savePrompt = internalMutation({
	args: { turnId: v.id("agentTurns"), prompt: v.string() },
	handler: async (ctx, { turnId, prompt }) => {
		await ctx.db.patch(turnId, { prompt });
	},
});

export const updateReply = internalMutation({
	args: { replyId: v.id("chatMessages"), text: v.string(), parts: v.array(messagePart) },
	handler: async (ctx, { replyId, text, parts }) => {
		const reply = await ctx.db.get(replyId);
		if (reply?.status === "streaming") await ctx.db.patch(replyId, { text, parts });
	},
});

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
		const stats = usage && { ...usage, conversationCostUsd: placeCost };
		const reply = turn.replyId && (await ctx.db.get(turn.replyId));
		// A turn already failed as stale only gets its stats; the queue moved on without it.
		if (turn.status !== "running") {
			if (reply && stats) await ctx.db.patch(reply._id, { stats });
			return;
		}
		if (reply) await ctx.db.patch(reply._id, error ? { status: "error", error, stats } : { status: "done", stats });
		await ctx.db.patch(turnId, { status: error ? "error" : "done" });
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
		result: v.optional(v.object({ summary: v.string(), upTo: v.number(), costUsd: v.number() })),
	},
	handler: async (ctx, { sessionId, result }) => {
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
	},
});

// ---- Chat tools (core's ChatStore), acting as the turn's person ----

export const reactFor = internalMutation({
	args: { turnId: v.id("agentTurns"), emoji: v.string() },
	handler: async (ctx, { turnId, emoji }): Promise<{ reacted: boolean } | { error: string }> => {
		const { turn } = await runningTurn(ctx, turnId);
		const trigger = await ctx.db.get(turn.triggerId);
		if (!trigger || trigger.deleted) return { error: "That message was deleted." };
		const clean = emoji.trim();
		if (!clean) return { error: "Pick an emoji." };
		return { reacted: await toggleReaction(ctx, trigger, clean, { agentId: turn.agentId }) };
	},
});

/** A channel by name ("#sales"), if the person can see it. */
async function channelNamed(ctx: QueryCtx, member: Member, name: string) {
	const chat = await ctx.db
		.query("chats")
		.withIndex("by_name", (q) => q.eq("workspaceId", member.workspaceId).eq("name", normalizeChannelName(name)))
		.first();
	return chat && !chat.archived && (await canSee(ctx, chat, member)) ? chat : null;
}

async function toLine(ctx: QueryCtx, m: Doc<"chatMessages">, names: Namer, label: string): Promise<ChatLine> {
	const author = (await names.of(m)).name;
	const reactions = new Map<string, string[]>();
	for (const r of await reactionsOf(ctx, m._id)) {
		reactions.set(r.emoji, [...(reactions.get(r.emoji) ?? []), (await names.of(r)).name]);
	}
	return {
		id: m._id,
		chat: label,
		...(m.threadId && { threadOf: m.threadId }),
		author,
		time: new Date(m._creationTime).toISOString(),
		text: textForModel(m, author),
		...(!m.threadId && m.replyCount && { replies: m.replyCount }),
		...(reactions.size > 0 && { reactions: [...reactions].map(([emoji, by]) => ({ emoji, by })) }),
	};
}

export const readFor = internalQuery({
	args: {
		turnId: v.id("agentTurns"),
		chat: v.optional(v.string()),
		threadOf: v.optional(v.string()),
		before: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member, chat: here } = await runningTurn(ctx, args.turnId);
		let chat: Doc<"chats"> | null = here;
		let threadId: Id<"chatMessages"> | undefined = args.chat ? undefined : turn.threadId;
		if (args.threadOf) {
			const id = ctx.db.normalizeId("chatMessages", args.threadOf);
			const message = id && (await ctx.db.get(id));
			chat = message ? await ctx.db.get(message.chatId) : null;
			if (!message || !chat || !(await canSee(ctx, chat, member))) return { error: `No message "${args.threadOf}" you can see.` };
			threadId = message.threadId ?? message._id;
		} else if (args.chat) {
			chat = await channelNamed(ctx, member, args.chat);
			if (!chat) return { error: `No channel "${args.chat}" you can see.` };
		}
		const before = args.before ? Date.parse(args.before) : Number.POSITIVE_INFINITY;
		if (Number.isNaN(before)) return { error: "`before` must be an ISO time." };
		const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
		const docs = (
			await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id).eq("threadId", threadId).lt("_creationTime", before))
				.order("desc")
				// Replies still being written (this one included) aren't history yet.
				.filter((q) => q.and(q.neq(q.field("deleted"), true), q.neq(q.field("status"), "streaming")))
				.take(limit)
		).reverse();
		const parent = threadId && (await ctx.db.get(threadId));
		const names = namer(ctx);
		const label = await chatLabel(ctx, chat, names, turn.agentId);
		const all = parent && !parent.deleted && parent._creationTime < before ? [parent, ...docs] : docs;
		return { messages: await Promise.all(all.map((m) => toLine(ctx, m, names, label))) };
	},
});

export const searchFor = internalQuery({
	args: { turnId: v.id("agentTurns"), query: v.string(), chat: v.optional(v.string()) },
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member } = await runningTurn(ctx, args.turnId);
		let chatId: Id<"chats"> | undefined;
		if (args.chat) {
			const chat = await channelNamed(ctx, member, args.chat);
			if (!chat) return { error: `No channel "${args.chat}" you can see.` };
			chatId = chat._id;
		}
		const found = await ctx.db
			.query("chatMessages")
			.withSearchIndex("search_text", (q) => {
				const s = q.search("text", args.query).eq("workspaceId", member.workspaceId);
				return chatId ? s.eq("chatId", chatId) : s;
			})
			.take(60);
		const names = namer(ctx);
		/** Each chat's label, or null if the person can't see it. */
		const labels = new Map<Id<"chats">, string | null>();
		const lines: ChatLine[] = [];
		for (const m of found) {
			if (m.deleted || lines.length >= 20) continue;
			if (!labels.has(m.chatId)) {
				const chat = await ctx.db.get(m.chatId);
				const ok = chat && !chat.archived && (await canSee(ctx, chat, member));
				labels.set(m.chatId, ok ? await chatLabel(ctx, chat, names, turn.agentId) : null);
			}
			const label = labels.get(m.chatId);
			if (label) lines.push(await toLine(ctx, m, names, label));
		}
		return { messages: lines };
	},
});
