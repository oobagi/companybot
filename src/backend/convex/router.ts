import {
	ROUTER_CONTEXT_MESSAGES,
	ROUTER_DEBOUNCE_MS,
	ROUTER_EMOJI,
	ROUTER_MAX_AGENTS,
	ROUTER_MODEL,
	NEXT_MIN_PROBABILITY,
	type NextInput,
	type RouterInput,
	type RouterMessage,
	gatewayCost,
	isGranted,
	isDecisionModel,
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
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { type Namer, canSee, chatMembersOf, namer, textForModel } from "./chatOps";
import { dispatchTo } from "./chains";
import { liveWorkspace, memberOf } from "./lib";
import { enqueueTurn } from "./turns";
import { recordUsage } from "./usage";

// Agents that answer without an @mention, in channels set to "When relevant" (wiki/chat.md, When
// agents reply). A person's un-mentioned message schedules a decision; it waits ROUTER_DEBOUNCE_MS
// and gives up if a newer person's message came in the place meanwhile (that one decides), so a
// burst makes one call. The answer queues replies (enqueueTurn) and adds reactions.

/** From messages.send, for a person's message that @mentions no agent. */
export async function routeLater(ctx: MutationCtx, chat: Doc<"chats">, message: Doc<"chatMessages">) {
	if (chat.kind !== "channel" || chat.replyMode !== "relevant" || !message.authorUserId) return;
	await ctx.scheduler.runAfter(ROUTER_DEBOUNCE_MS, internal.router.decide, { messageId: message._id });
}

/** The message and its place, if it should still be decided on: null once anything changed. */
async function routable(ctx: QueryCtx, messageId: Id<"chatMessages">) {
	const message = await ctx.db.get(messageId);
	if (!message || message.deleted || !message.authorUserId || message.mentions.agentIds.length > 0) return null;
	const chat = await ctx.db.get(message.chatId);
	if (!chat || chat.archived || chat.replyMode !== "relevant" || !(await liveWorkspace(ctx, chat.workspaceId))) return null;
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
			.withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id).eq("threadId", message.threadId).gt("_creationTime", message._creationTime))
			.filter((q) => q.and(q.neq(q.field("authorUserId"), undefined), q.neq(q.field("deleted"), true)))
			.first();
		if (newer) return null;
		const agents = await agentsIn(ctx, chat);
		if (agents.length === 0) return null;

		const keys = new Map(agents.map((a, i) => [a._id, `a${i + 1}`]));
		const names = namer(ctx);
		const toRouter = routerMessage(names, keys);
		const { before, parent } = await around(ctx, message);
		const people = (await chatMembersOf(ctx, chat._id)).filter((r) => r.userId && r.userId !== message.authorUserId);
		const input: RouterInput = {
			place: { name: chat.name ?? "", topic: chat.topic ?? null },
			agents: agents.map((a) => ({ key: keys.get(a._id)!, name: a.name, description: a.description, canReact: isGranted(a.tools, "chat.react") })),
			people: await Promise.all(people.slice(0, 30).map(async (r) => (await names.of(r)).name)),
			parent: parent && !parent.deleted ? await toRouter(parent) : null,
			before: await Promise.all(before.map(toRouter)),
			message: await toRouter(message),
		};
		const model = (await ctx.db.get(chat.workspaceId))?.routerModel ?? ROUTER_MODEL;
		return { input, agentIds: agents.map((a) => a._id), workspaceId: chat.workspaceId, model };
	},
});

/** A message as the router reads it: its author (an agent by key), text, and files by name. */
const routerMessage = (names: Namer, keys: Map<Id<"agents">, string>) => async (m: Doc<"chatMessages">): Promise<RouterMessage> => {
	const files = m.attachments?.length ? `(${m.attachments.length === 1 ? "a file" : `${m.attachments.length} files`}: ${m.attachments.map((f) => f.name).join(", ")})` : "";
	const author = (await names.of(m)).name;
	return {
		author,
		...(m.authorAgentId && { agent: keys.get(m.authorAgentId) ?? "agent" }),
		text: [textForModel(m, author), files].filter(Boolean).join("\n"),
	};
};

/** The few finished messages before one in its place, and its thread's parent. */
async function around(ctx: QueryCtx, message: Doc<"chatMessages">) {
	const before = (
		await ctx.db
			.query("chatMessages")
			.withIndex("by_chat_thread", (q) => q.eq("chatId", message.chatId).eq("threadId", message.threadId).lt("_creationTime", message._creationTime))
			.order("desc")
			.filter((q) => q.and(q.neq(q.field("deleted"), true), q.eq(q.field("status"), "done"), q.neq(q.field("quiet"), true)))
			.take(ROUTER_CONTEXT_MESSAGES)
	).reverse();
	const parent = message.threadId && (await ctx.db.get(message.threadId));
	return { before, parent };
}

/** Asks the model, then acts on its answer. Scheduled by routeLater. */
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
					picked: routerAnswers(r.answers as Record<string, { choice?: string }>, input.agents),
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
		const decisions = input.agents.flatMap((a, i) => {
			const d = picked.get(a.key)!;
			return d.action === "quiet" ? [] : [{ agentId: agentIds[i]!, action: d.action, ...(d.action === "react" && { emoji: d.emoji }) }];
		});
		await ctx.runMutation(internal.router.apply, { messageId, decisions, model, costUsd: gatewayCost(providerMetadata) });
	},
});

/** Records the call's cost, then queues replies and adds reactions for agents still here. */
export const apply = internalMutation({
	args: {
		messageId: v.id("chatMessages"),
		decisions: v.array(v.object({ agentId: v.id("agents"), action: v.union(v.literal("reply"), v.literal("react")), emoji: v.optional(v.string()) })),
		model: v.string(),
		costUsd: v.number(),
	},
	handler: async (ctx, { messageId, decisions, model, costUsd }) => {
		const message = await ctx.db.get(messageId);
		if (!message?.authorUserId) return;
		// The person whose message it decided on, like a reply counts for its asker.
		await recordUsage(ctx, { workspaceId: message.workspaceId, userId: message.authorUserId, kind: "router", model, costUsd });
		const found = await routable(ctx, messageId);
		if (!found) return;
		const { chat } = found;
		const here = new Set((await agentsIn(ctx, chat)).map((a) => a._id));
		for (const d of decisions) {
			const agent = await ctx.db.get(d.agentId);
			if (!agent || !here.has(agent._id)) continue;
			if (d.action === "reply") {
				await enqueueTurn(ctx, chat, { agentId: agent._id, chatId: chat._id, threadId: message.threadId, triggerId: messageId, actorId: message.authorUserId, routed: true });
			} else if (d.emoji && (ROUTER_EMOJI as readonly string[]).includes(d.emoji) && isGranted(agent.tools, "chat.react")) {
				const existing = await ctx.db
					.query("reactions")
					.withIndex("by_message", (q) => q.eq("messageId", messageId).eq("emoji", d.emoji!).eq("userId", undefined).eq("agentId", agent._id))
					.first();
				if (!existing) await ctx.db.insert("reactions", { messageId, chatId: chat._id, emoji: d.emoji, agentId: agent._id });
			}
		}
	},
});

// ---- Who goes next, after an agent's message in a chain (chains.ts handOff) ----

/** What "who goes next" sees: the agent's message, a few before it, and the other agents here. Null once it's moot. */
export const nextContext = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const turn = await ctx.db.get(turnId);
		const chain = turn?.chain && (await ctx.db.get(turn.chain.id));
		const reply = turn?.replyId && (await ctx.db.get(turn.replyId));
		if (!turn || !chain || chain.status !== "running" || !reply || reply.deleted || reply.status !== "done") return null;
		const chat = await ctx.db.get(reply.chatId);
		if (!chat || chat.archived || chat.replyMode !== "relevant" || !(await liveWorkspace(ctx, chat.workspaceId))) return null;
		const agents = (await agentsIn(ctx, chat)).filter((a) => a._id !== turn.agentId);
		if (agents.length === 0) return null;
		const keys = new Map(agents.map((a, i) => [a._id, `a${i + 1}`]));
		const names = namer(ctx);
		const toRouter = routerMessage(names, keys);
		const { before, parent } = await around(ctx, reply);
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
		const { key, providerMetadata } = isDecisionModel(model)
			? await decideWith({ model, state: `${instructions}\n\n${prompt}`, questions: nextQuestions(input), maxRetries: 1 }).then((r) => ({
					key: nextAnswer(r.answers as Record<string, { choice?: string; probability?: number; probabilities?: Record<string, number> }>, input, NEXT_MIN_PROBABILITY),
					providerMetadata: r.providerMetadata,
				}))
			: await generateText({
					model,
					instructions,
					prompt,
					output: Output.object({ schema: nextSchema(input), name: "next" }),
					providerOptions: { gateway: { caching: "auto" } },
					maxRetries: 1,
				}).then((r) => ({ key: nextDecision(r.output, input, NEXT_MIN_PROBABILITY), providerMetadata: r.providerMetadata }));
		const agentId = key ? agentIds[input.agents.findIndex((a) => a.key === key)] : undefined;
		await ctx.runMutation(internal.router.applyNext, { turnId, model, costUsd: gatewayCost(providerMetadata), ...(agentId && { agentId }) });
	},
});

/** Records the call's cost for the chain's person, then hands to the agent it picked, if any. */
export const applyNext = internalMutation({
	args: { turnId: v.id("agentTurns"), agentId: v.optional(v.id("agents")), model: v.string(), costUsd: v.number() },
	handler: async (ctx, { turnId, agentId, model, costUsd }) => {
		const turn = await ctx.db.get(turnId);
		const chain = turn?.chain && (await ctx.db.get(turn.chain.id));
		if (!turn || !chain) return;
		await recordUsage(ctx, { workspaceId: chain.workspaceId, userId: chain.actorId, kind: "router", model, costUsd });
		if (agentId) await dispatchTo(ctx, turn, agentId);
	},
});
