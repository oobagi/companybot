import {
	ROUTER_CONTEXT_MESSAGES,
	QUIET_WINDOW_MS,
	ROUTER_MAX_AGENTS,
	ROUTER_MODEL,
	NEXT_MIN_PROBABILITY,
	ROUTER_MIGHT_PER_HOUR,
	confidenceBand,
	type NextInput,
	type RouterInput,
	type RouterMessage,
	gatewayCost,
	replyModeOf,
	isDecisionModel,
	justAnsweredKey,
	nextAnswer,
	nextDecision,
	nextQuestions,
	nextRequest,
	nextSchema,
	routerAnswers,
	routerDecisions,
	routerQuestions,
	routerRequest,
	routerSchema,
} from "@companybot/core";
import { Output, experimental_decide as decideWith, generateText } from "ai";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { dispatchTo, shownReply } from "./chains";
import { type Namer, canSee, chatMembersOf, label, namer, textForModel } from "./chatOps";
import { type RecordTags, recordTags } from "./recordTags";
import { type Member, liveWorkspace, memberOf } from "./lib";
import { canReadReply } from "./replyPrivacy";
import type { dispatchInfo } from "./schema";
import { STALE_TURN_MS, enqueueTurn } from "./turns";
import { recordUsage } from "./usage";

// Agents that answer without an @mention, in channels set to "When relevant" (wiki/chat.md, When
// agents reply). A person's un-mentioned message schedules a decision; it waits QUIET_WINDOW_MS
// and gives up if a newer person's message came in the place meanwhile (that one decides), so a
// burst makes one call. The answer wakes agents (enqueueTurn). It's a wide net: each is a turn like any
// other, where the agent reads the conversation and answers with a post, a reaction, both or nothing
// (core postDecision), told how sure the dispatcher was in words (core confidenceBand).

/** From messages.send, for a person's message that @mentions no agent. */
export async function routeLater(ctx: MutationCtx, chat: Doc<"chats">, message: Doc<"chatMessages">) {
	if (replyModeOf(chat) !== "relevant" || !message.authorUserId) return;
	await ctx.scheduler.runAfter(QUIET_WINDOW_MS, internal.router.decide, { messageId: message._id });
}

/** The message and its place, if it should still be decided on: null once anything changed. */
async function routable(ctx: QueryCtx, messageId: Id<"chatMessages">) {
	const message = await ctx.db.get(messageId);
	if (!message || message.deleted || !message.authorUserId || message.mentions.agentIds.length > 0) return null;
	const chat = await ctx.db.get(message.chatId);
	if (!chat || chat.archived || replyModeOf(chat) !== "relevant" || !(await liveWorkspace(ctx, chat.workspaceId))) return null;
	const member = await memberOf(ctx, message.authorUserId, chat.workspaceId);
	if (!member || !(await canSee(ctx, chat, member))) return null;
	return { message, chat, member };
}

/** The channel's active agents, oldest members first. */
async function agentsIn(ctx: QueryCtx, chat: Doc<"chats">) {
	const agents: Doc<"agents">[] = [];
	for (const row of await chatMembersOf(ctx, chat._id)) {
		const agent = row.agentId && (await ctx.db.get(row.agentId));
		if (agent && !agent.archived && agents.length < ROUTER_MAX_AGENTS) agents.push(agent);
	}
	return agents;
}

/** What the router sees: the message, a few before it, the thread's parent, and each agent here. */
export const context = internalQuery({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const found = await routable(ctx, messageId);
		if (!found) return null;
		const { message, chat } = found;
		// Debounce: a newer person's message here makes its own decision, which sees this one.
		const newer = await ctx.db
			.query("chatMessages")
			.withIndex("by_chat_thread_quiet", (q) => q.eq("chatId", chat._id).eq("threadId", message.threadId).eq("quiet", undefined).gt("_creationTime", message._creationTime))
			.filter((q) => q.and(q.neq(q.field("authorUserId"), undefined), q.neq(q.field("deleted"), true)))
			.first();
		if (newer) return null;
		const agents = await agentsIn(ctx, chat);
		if (agents.length === 0) return null;

		const keys = new Map(agents.map((a, i) => [a._id, `a${i + 1}`]));
		const names = namer(ctx);
		const viewer = await memberOf(ctx, message.authorUserId!, chat.workspaceId);
		if (!viewer || !(await canReadReply(ctx, viewer, message))) return null;
		const toRouter = routerMessage(names, keys, recordTags(ctx, viewer));
		const { before, parent } = await around(ctx, message, viewer);
		const people = (await chatMembersOf(ctx, chat._id)).filter((r) => r.userId && r.userId !== message.authorUserId);
		const input: RouterInput = {
			place: { name: chat.name ?? "", topic: chat.topic ?? null },
			agents: agents.map((a) => ({ key: keys.get(a._id)!, name: a.name, description: a.description })),
			people: await Promise.all(people.slice(0, 30).map(async (r) => (await names.of(r)).name)),
			parent: parent && !parent.deleted ? await toRouter(parent) : null,
			before: await Promise.all(before.map(toRouter)),
			message: await toRouter(message),
		};
		const model = (await ctx.db.get(chat.workspaceId))?.routerModel ?? ROUTER_MODEL;
		return { input, agentIds: agents.map((a) => a._id), model };
	},
});

/** A message as the router reads it: its author (an agent by key), text, and files by name. */
const routerMessage = (names: Namer, keys: Map<Id<"agents">, string>, tags: RecordTags) => async (m: Doc<"chatMessages">): Promise<RouterMessage> => {
	const files = m.attachments?.length ? `(${m.attachments.length === 1 ? "a file" : `${m.attachments.length} files`}: ${m.attachments.map((f) => f.name).join(", ")})` : "";
	const author = label(await names.of(m));
	return {
		author,
		...(m.authorAgentId && { agent: keys.get(m.authorAgentId) ?? "agent" }),
		text: [textForModel({ ...m, text: await tags.forModel(m.text) }, author), files].filter(Boolean).join("\n"),
	};
};

/** The few finished messages before one in its place, and its thread's parent. */
async function around(ctx: QueryCtx, message: Doc<"chatMessages">, member: Member) {
	const before = (
		await ctx.db
			.query("chatMessages")
			.withIndex("by_chat_thread_quiet", (q) => q.eq("chatId", message.chatId).eq("threadId", message.threadId).eq("quiet", undefined).lt("_creationTime", message._creationTime))
			.order("desc")
			.filter((q) => q.and(q.neq(q.field("deleted"), true), q.eq(q.field("status"), "done")))
			.take(ROUTER_CONTEXT_MESSAGES)
	).reverse();
	const parent = message.threadId && (await ctx.db.get(message.threadId));
	const visible = [];
	for (const m of before) if (await canReadReply(ctx, member, m)) visible.push(m);
	return { before: visible, parent: parent && await canReadReply(ctx, member, parent) ? parent : null };
}

/** Asks the model, then wakes the agents it picked. Scheduled by routeLater. */
export const decide = internalAction({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const found = await ctx.runQuery(internal.router.context, { messageId });
		if (!found) return;
		const { input, agentIds, model } = found;
		const { instructions, prompt } = routerRequest(input);
		// A decision model (Jev) answers choice questions; a language model, the same rules as JSON.
		const { picked, providerMetadata } = isDecisionModel(model)
			? await decideWith({ model, state: `${instructions}\n\n${prompt}`, questions: routerQuestions(input), maxRetries: 1 }).then((r) => ({
					picked: routerAnswers(r.answers as Parameters<typeof routerAnswers>[0], input.agents, justAnsweredKey(input)),
					providerMetadata: r.providerMetadata,
				}))
			: await generateText({
					model,
					instructions,
					prompt,
					output: Output.object({ schema: routerSchema(input.agents), name: "decisions" }),
					providerOptions: { gateway: { caching: "auto" } },
					maxRetries: 1,
				}).then((r) => ({ picked: routerDecisions(r.output, input.agents), providerMetadata: r.providerMetadata }));
		const replies = input.agents.flatMap((a, i) => {
			const d = picked.get(a.key)!;
			return d.action === "reply" ? [{ agentId: agentIds[i]!, ...(d.probability !== undefined && { probability: d.probability }), ...(d.probabilities && { probabilities: d.probabilities }) }] : [];
		});
		await ctx.runMutation(internal.router.apply, { messageId, replies, model, costUsd: gatewayCost(providerMetadata) });
	},
});

/** Records the call's cost, then queues replies for agents still here. */
export const apply = internalMutation({
	args: {
		messageId: v.id("chatMessages"),
		replies: v.array(v.object({ agentId: v.id("agents"), probability: v.optional(v.number()), probabilities: v.optional(v.record(v.string(), v.number())) })),
		model: v.string(),
		costUsd: v.number(),
	},
	handler: async (ctx, { messageId, replies: picks, model, costUsd }) => {
		const message = await ctx.db.get(messageId);
		if (!message?.authorUserId) return;
		// The person whose message it decided on, like a reply counts for its asker.
		await recordUsage(ctx, { workspaceId: message.workspaceId, userId: message.authorUserId, kind: "router", model, costUsd });
		const found = await routable(ctx, messageId);
		if (!found) return;
		const { chat } = found;
		const here = new Set((await agentsIn(ctx, chat)).map((a) => a._id));
		// One after another, best fit first, so each sees what the ones before posted. A "might" past the hour's cap is dropped.
		const replies: { agent: Doc<"agents">; dispatch: Infer<typeof dispatchInfo> }[] = [];
		let might = await mightThisHour(ctx, chat._id);
		for (const d of [...picks].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))) {
			const agent = await ctx.db.get(d.agentId);
			if (!agent || !here.has(agent._id) || (await hasTurnFor(ctx, agent._id, message))) continue;
			const dispatch = { ...dispatchOf(model, d.probability, costUsd), ...(d.probabilities && { probabilities: d.probabilities }) };
			if (dispatch.band === "might" && might++ >= ROUTER_MIGHT_PER_HOUR) continue;
			replies.push({ agent, dispatch });
		}
		let after: Doc<"agentTurns"> | null = null;
		for (const { agent, dispatch } of replies) {
			const turnId: Id<"agentTurns"> = await enqueueTurn(ctx, chat, {
				agentId: agent._id,
				chatId: chat._id,
				threadId: message.threadId,
				triggerId: messageId,
				actorId: message.authorUserId,
				routed: true,
				dispatch: { ...dispatch, ...(after && { after: after._id }) },
			});
			if (after) await ctx.db.patch(after._id, { dispatch: { ...after.dispatch!, then: turnId } });
			after = (await ctx.db.get(turnId))!;
		}
		// In case one before it never finishes: a waiting pick starts anyway once that one is stale.
		if (replies.length > 1) await ctx.scheduler.runAfter(STALE_TURN_MS + 1_000, internal.turns.startWaiting, { triggerId: messageId });
	},
});

/** A pick as stored on its turn: what the agent is told, and what its reply's stats show. */
export const dispatchOf = (model: string, probability: number | undefined, costUsd: number): Infer<typeof dispatchInfo> => ({
	model,
	band: confidenceBand(probability),
	...(probability !== undefined && { probability }),
	costUsd,
});

/**
 * Whether the message already went to this agent: it reached a reply the agent was writing for its
 * person (turns.queueFollowUps), so a pick would answer it twice.
 */
async function hasTurnFor(ctx: QueryCtx, agentId: Id<"agents">, message: Doc<"chatMessages">) {
	for (const status of ["queued", "running", "done", "error"] as const) {
		const found = await ctx.db
			.query("agentTurns")
			.withIndex("by_place", (q) =>
				q.eq("agentId", agentId).eq("chatId", message.chatId).eq("threadId", message.threadId).eq("status", status).gte("_creationTime", message._creationTime),
			)
			.filter((q) => q.eq(q.field("triggerId"), message._id))
			.first();
		if (found) return true;
	}
	return false;
}

/** "Might be for you" picks queued in the channel in the last hour, up to the cap. A person's follow-up to one (turns.queueFollowUps) isn't a pick. */
async function mightThisHour(ctx: QueryCtx, chatId: Id<"chats">) {
	const since = Date.now() - 60 * 60_000;
	const turns = await ctx.db
		.query("agentTurns")
		.withIndex("by_chat_dispatch", (q) => q.eq("chatId", chatId).eq("dispatch.band", "might").gt("_creationTime", since))
		.filter((q) => q.neq(q.field("person"), true))
		.take(ROUTER_MIGHT_PER_HOUR);
	return turns.length;
}

// ---- Who goes next, after an agent's message in a chain (chains.ts handOff) ----

/** What "who goes next" sees: the agent's message, a few before it, and the other agents here. Null once it's moot. */
export const nextContext = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const turn = await ctx.db.get(turnId);
		const chain = turn?.chain && (await ctx.db.get(turn.chain.id));
		const reply = turn && (await shownReply(ctx, turn));
		if (!turn || !chain || chain.status !== "running" || !reply || reply.deleted || reply.status !== "done") return null;
		const chat = await ctx.db.get(reply.chatId);
		if (!chat || chat.archived || replyModeOf(chat) !== "relevant" || !(await liveWorkspace(ctx, chat.workspaceId))) return null;
		const agents = (await agentsIn(ctx, chat)).filter((a) => a._id !== turn.agentId);
		if (agents.length === 0) return null;
		const keys = new Map(agents.map((a, i) => [a._id, `a${i + 1}`]));
		const names = namer(ctx);
		const viewer = await memberOf(ctx, chain.actorId, chat.workspaceId);
		if (!viewer || !(await canReadReply(ctx, viewer, reply))) return null;
		const toRouter = routerMessage(names, keys, recordTags(ctx, viewer));
		const { before, parent } = await around(ctx, reply, viewer);
		const input: NextInput = {
			place: { name: chat.name ?? "", topic: chat.topic ?? null },
			from: (await names.agent(turn.agentId)).name,
			agents: agents.map((a) => ({ key: keys.get(a._id)!, name: a.name, description: a.description })),
			person: (await names.user(chain.actorId)).name,
			parent: parent && !parent.deleted ? await toRouter(parent) : null,
			before: await Promise.all(before.map(toRouter)),
			message: await toRouter(reply),
		};
		const model = (await ctx.db.get(chat.workspaceId))?.routerModel ?? ROUTER_MODEL;
		return { input, agentIds: agents.map((a) => a._id), model };
	},
});

/** Asks who goes next (same model and split as `decide`), then hands off if it's sure. */
export const next = internalAction({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const found = await ctx.runQuery(internal.router.nextContext, { turnId });
		if (!found) return;
		const { input, agentIds, model } = found;
		const { instructions, prompt } = nextRequest(input);
		const { pick, providerMetadata } = isDecisionModel(model)
			? await decideWith({ model, state: `${instructions}\n\n${prompt}`, questions: nextQuestions(input), maxRetries: 1 }).then((r) => ({
					pick: nextAnswer(r.answers as Record<string, { choice?: string; probability?: number; probabilities?: Record<string, number> }>, input, NEXT_MIN_PROBABILITY),
					providerMetadata: r.providerMetadata,
				}))
			: await generateText({
					model,
					instructions,
					prompt,
					output: Output.object({ schema: nextSchema(input), name: "next" }),
					providerOptions: { gateway: { caching: "auto" } },
					maxRetries: 1,
				}).then((r) => ({ pick: nextDecision(r.output, input, NEXT_MIN_PROBABILITY), providerMetadata: r.providerMetadata }));
		const agentId = pick ? agentIds[input.agents.findIndex((a) => a.key === pick.key)] : undefined;
		await ctx.runMutation(internal.router.applyNext, {
			turnId,
			model,
			costUsd: gatewayCost(providerMetadata),
			...(agentId && { agentId }),
			...(pick?.probability !== undefined && { probability: pick.probability }),
		});
	},
});

/** Records the call's cost for the chain's person, then hands to the agent it picked, if any. */
export const applyNext = internalMutation({
	args: { turnId: v.id("agentTurns"), agentId: v.optional(v.id("agents")), probability: v.optional(v.number()), model: v.string(), costUsd: v.number() },
	handler: async (ctx, { turnId, agentId, probability, model, costUsd }) => {
		const turn = await ctx.db.get(turnId);
		const chain = turn?.chain && (await ctx.db.get(turn.chain.id));
		if (!turn || !chain) return;
		await recordUsage(ctx, { workspaceId: chain.workspaceId, userId: chain.actorId, kind: "router", model, costUsd });
		if (agentId) await dispatchTo(ctx, turn, agentId, dispatchOf(model, probability, costUsd));
	},
});
