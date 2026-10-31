import {
	type ChainBudget,
	FOLLOWUP_NOTE_MAX,
	type Handoff,
	type PauseReason,
	askRefusal,
	freshBudget,
	handoffLimit,
	isGranted,
	mentionedAgents,
	pauseText,
	replyModeOf,
	spend,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation } from "./functions";
import { addToChat, addUserMentions, chatMembersOf, insertMessage, requireChat } from "./chatOps";
import { asToolResult, nameOf, requireMember } from "./lib";
import { automationScope } from "./automationOps";
import { enqueueTurn, runningTurn } from "./turns";
import { createWakeup, wake } from "./wakeups";

// Agents handing work to each other, for one person (wiki/chat.md, Agents working together). An
// agent's @mention of another queues that agent's turn: in the thread it wrote in, or a new thread
// under its message, so the top level stays the people's. The dispatcher (router.next) can pick who
// goes next when nobody was @mentioned, and chat.ask_agent asks privately, out of the chat. Every
// handoff spends the chain's budget (core handoffs.ts); one that would go past a limit pauses the
// chain with a line in the chat, "Agents paused after 10 turns · Continue · Stop". A person writing
// in a chain's place resets its budget. Only a person's message starts a chain: wakes, automations
// and answers to asks never hand off.

const budgetOf = (chain: Doc<"agentChains">): ChainBudget<Id<"agents">> => ({ turns: chain.turns, hops: chain.hops, pairs: chain.pairs });

/** The agents from the chain's start to this turn's: none of an older epoch (a reset or Continue since). */
const pathOf = (turn: Doc<"agentTurns">, chain: Doc<"agentChains">) => (turn.chain && turn.chain.epoch === chain.epoch ? turn.chain.path : [turn.agentId]);

/** The turn's chain, made at its first handoff: a person's turn starts one, with its own turn counted. */
async function chainOf(ctx: MutationCtx, turn: Doc<"agentTurns">) {
	const existing = turn.chain && (await ctx.db.get(turn.chain.id));
	if (existing) return existing;
	const id = await ctx.db.insert("agentChains", { workspaceId: turn.workspaceId, actorId: turn.actorId, chatId: turn.chatId, ...freshBudget(1), epoch: 0, status: "running" });
	await ctx.db.patch(turn._id, { chain: { id, depth: 0, path: [turn.agentId], epoch: 0 } });
	turn.chain = { id, depth: 0, path: [turn.agentId], epoch: 0 };
	return (await ctx.db.get(id))!;
}

/**
 * Whether a person asked for this turn, now or up its chain: only then may it hand work on. Answers
 * to asks may ask further (chat.ask_agent, up to CHAIN_MAX_DEPTH) but their @mentions hand nothing.
 */
async function personAsked(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	// Wakes (follow-ups, check-ins, asks' answers): nobody is asking right now.
	if (turn.wakeupId) return false;
	const { trigger } = await automationScope(ctx, turn);
	// Automation runs post as their person, but nobody wrote those words just now.
	if (trigger?.automation) return false;
	return !!turn.chain || !!trigger?.authorUserId;
}

/** Agents a reply here can hand to: in a channel any active agent (it joins, like a person's mention), in a DM its own. */
async function reachable(ctx: QueryCtx, chat: Doc<"chats">, self: Id<"agents">) {
	const agents =
		chat.kind === "channel"
			? await ctx.db
					.query("agents")
					.withIndex("by_workspace_active", (q) => q.eq("workspaceId", chat.workspaceId).eq("archived", false))
					.collect()
			: (await Promise.all((await chatMembersOf(ctx, chat._id)).map((r) => (r.agentId ? ctx.db.get(r.agentId) : null)))).filter((a) => !!a && !a.archived);
	return (agents as Doc<"agents">[]).filter((a) => a._id !== self);
}

/** Agents' messages in a place since a person last wrote there (pause lines and quiet replies aside), up to the limit's worth. */
async function agentPostsIn(ctx: QueryCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined) {
	const recent = await ctx.db
		.query("chatMessages")
		.withIndex("by_chat_thread", (q) => q.eq("chatId", chatId).eq("threadId", threadId))
		.order("desc")
		.filter((q) => q.and(q.neq(q.field("quiet"), true), q.eq(q.field("pause"), undefined), q.neq(q.field("deleted"), true)))
		.take(20);
	const posts = recent.findIndex((m) => !!m.authorUserId);
	return posts === -1 ? recent.length : posts;
}

/**
 * After a turn's reply is done (turns.finishReply): its @mentions of other agents hand them the
 * work, in a chain. One that mentions nobody, in a chain in a "When relevant" channel, asks the
 * dispatcher who goes next (router.next).
 */
export async function handOff(ctx: MutationCtx, turn: Doc<"agentTurns">) {
	const reply = await shownReply(ctx, turn);
	if (!reply || reply.status !== "done" || reply.deleted || turn.ask || !(await personAsked(ctx, turn))) return;
	const chat = await ctx.db.get(turn.chatId);
	if (!chat || chat.archived) return;
	const mentioned = mentionedAgents(reply.text, (await reachable(ctx, chat, turn.agentId)).map((a) => ({ id: a._id, name: a.name })));
	if (mentioned.length > 0) {
		await ctx.db.patch(reply._id, { mentions: { ...reply.mentions, agentIds: mentioned.map((a) => a.id) } });
		const chain = await chainOf(ctx, turn);
		for (const to of mentioned) await passTo(ctx, { turn, chain: (await ctx.db.get(chain._id))!, chat, reply, to: to.id });
		return;
	}
	if (turn.chain && replyModeOf(chat) === "relevant") await ctx.scheduler.runAfter(0, internal.router.next, { turnId: turn._id });
}

/**
 * What a turn said where people see it: its reply, or for a quiet turn (its reply is never shown) the
 * last message it posted with chat.notify, if any. Handoffs and "who goes next" read this.
 */
export async function shownReply(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const reply = turn.replyId && (await ctx.db.get(turn.replyId));
	if (!reply?.quiet) return reply || null;
	return (turn.notifiedId && (await ctx.db.get(turn.notifiedId))) || null;
}

/** The dispatcher picked `agentId` to go next after `turn` (router.applyNext): the same as an @mention, counted as a hop. */
export async function dispatchTo(ctx: MutationCtx, turn: Doc<"agentTurns">, agentId: Id<"agents">, dispatch: Held["dispatch"]) {
	const reply = await shownReply(ctx, turn);
	const chat = await ctx.db.get(turn.chatId);
	const chain = turn.chain && (await ctx.db.get(turn.chain.id));
	if (!reply || reply.deleted || !chat || chat.archived || replyModeOf(chat) !== "relevant" || !chain || agentId === turn.agentId) return;
	const here = (await chatMembersOf(ctx, chat._id)).some((r) => r.agentId === agentId);
	const agent = await ctx.db.get(agentId);
	if (!here || !agent || agent.archived) return;
	await passTo(ctx, { turn, chain, chat, reply, to: agentId, dispatched: true, dispatch });
}

type Held = NonNullable<Doc<"agentChains">["held"]>[number];

/** One handoff: within the budget it queues the agent's turn, else the chain pauses holding it. */
async function passTo(
	ctx: MutationCtx,
	{ turn, chain, chat, reply, to, dispatched, dispatch }: { turn: Doc<"agentTurns">; chain: Doc<"agentChains">; chat: Doc<"chats">; reply: Doc<"chatMessages">; to: Id<"agents">; dispatched?: true; dispatch?: Held["dispatch"] },
) {
	if (chain.status === "stopped") return;
	const threadId = reply.threadId ?? reply._id;
	const held: Held = { agentId: to, chatId: chat._id, threadId, triggerId: reply._id, depth: turn.chain?.depth ?? 0, ...(dispatched && { dispatched }), ...(dispatch && { dispatch }) };
	if (chain.status === "paused") return ctx.db.patch(chain._id, { held: [...(chain.held ?? []), held] });
	const handoff: Handoff<Id<"agents">> = { from: turn.agentId, to, path: pathOf(turn, chain), dispatched, agentPosts: await agentPostsIn(ctx, chat._id, threadId) };
	const limit = handoffLimit(budgetOf(chain), handoff);
	if (limit) return pause(ctx, chain, { chat, threadId, from: turn.agentId, reason: limit, held });
	await ctx.db.patch(chain._id, spend(budgetOf(chain), handoff));
	await startHanded(ctx, chain, held, [...handoff.path, to]);
}

/** Queues a handed-off turn, as the chain's person. */
async function startHanded(ctx: MutationCtx, chain: Doc<"agentChains">, h: Held, path: Id<"agents">[]) {
	const agent = await ctx.db.get(h.agentId);
	const chat = await ctx.db.get(h.chatId);
	if (!agent || agent.archived || !chat || chat.archived) return;
	if (chat.kind === "channel") await addToChat(ctx, chat, { agentId: agent._id });
	await enqueueTurn(ctx, chat, {
		agentId: agent._id,
		chatId: chat._id,
		threadId: h.threadId,
		triggerId: h.triggerId,
		actorId: chain.actorId,
		chain: { id: chain._id, depth: h.depth, path, epoch: chain.epoch },
		...(h.dispatched && { routed: true as const }),
		// Not asked directly, so quiet like a pick for a person's message: it posts with chat.notify only if it adds something.
		...(h.dispatch && { dispatch: { ...h.dispatch, ...(isGranted(agent.tools, "chat.notify") && { quiet: true as const }) } }),
	});
}

/** Pauses a chain with its line in the chat, as the agent whose handoff it held, @mentioning its person so they see it. */
async function pause(
	ctx: MutationCtx,
	chain: Doc<"agentChains">,
	{ chat, threadId, from, reason, held }: { chat: Doc<"chats">; threadId: Id<"chatMessages">; from: Id<"agents">; reason: PauseReason; held: Held },
) {
	const text = pauseText(reason, await agentNames(ctx, reason));
	const pauseId = await insertMessage(ctx, chat, {
		threadId,
		authorAgentId: from,
		text,
		parts: [{ type: "text", text }],
		mentions: { userIds: [chain.actorId], agentIds: [] },
		status: "done",
		pause: { chainId: chain._id, status: "paused" },
	});
	await addUserMentions(ctx, (await ctx.db.get(pauseId))!);
	await ctx.db.patch(chain._id, { status: "paused", pauseId, held: [held] });
}

/** Names for a reason's agents, read up front: the core words are sync. */
async function agentNames(ctx: QueryCtx, reason: PauseReason) {
	const ids = reason.kind === "pair" ? [reason.a, reason.b] : [];
	const names = new Map<string, string>();
	for (const id of ids) names.set(id, (await ctx.db.get(id as Id<"agents">))?.name ?? "An agent");
	return (id: string) => names.get(id) ?? "An agent";
}

/** A person wrote in a place (messages.send): every running chain with turns there starts its budget over. */
export async function resetChains(ctx: MutationCtx, chatId: Id<"chats">, threadId: Id<"chatMessages"> | undefined) {
	const turns = await ctx.db
		.query("agentTurns")
		.withIndex("by_chat", (q) => q.eq("chatId", chatId).eq("threadId", threadId))
		.order("desc")
		.take(20);
	const seen = new Set<Id<"agentChains">>();
	for (const turn of turns) {
		if (!turn.chain || seen.has(turn.chain.id)) continue;
		seen.add(turn.chain.id);
		const chain = await ctx.db.get(turn.chain.id);
		if (chain?.status === "running") await ctx.db.patch(chain._id, { ...freshBudget(), epoch: chain.epoch + 1 });
	}
}

/** Continue (a fresh budget, and the held handoffs go ahead) or Stop, on a paused line. Only the chain's person: the agents act for them. */
export const decide = mutation({
	args: { messageId: v.id("chatMessages"), action: v.union(v.literal("continue"), v.literal("stop")) },
	handler: async (ctx, { messageId, action }) => {
		const member = await requireMember(ctx);
		const message = await ctx.db.get(messageId);
		if (!message?.pause) throw new ConvexError("That's not a paused line.");
		await requireChat(ctx, member, message.chatId);
		const chain = await ctx.db.get(message.pause.chainId);
		if (!chain || chain.status !== "paused" || chain.pauseId !== messageId) throw new ConvexError("Someone already decided this.");
		if (chain.actorId !== member.userId) throw new ConvexError(`Only ${await nameOf(ctx, chain.actorId)} can: the agents are working for them.`);
		await ctx.db.patch(messageId, { pause: { ...message.pause, status: action === "stop" ? "stopped" : "continued", by: member.userId } });
		if (action === "stop") return await ctx.db.patch(chain._id, { status: "stopped", held: undefined, pauseId: undefined });
		const held = chain.held ?? [];
		const epoch = chain.epoch + 1;
		await ctx.db.patch(chain._id, { ...freshBudget(held.length), epoch, status: "running", held: undefined, pauseId: undefined });
		const fresh = { ...chain, epoch };
		for (const h of held) await startHanded(ctx, fresh, h, [h.agentId]);
	},
});

// ---- Asking privately (chat.ask_agent) ----

/**
 * chat.ask_agent: stores the ask as a quiet message in the asker's chat (kept, never in the
 * timeline) and queues the asked agent's answer in its thread, so the exchange is out of the chat
 * but its tool line opens it, read-only. A `{ jobId }` wakeup takes the answer back to the asker
 * (`answerAsk`), whose wake turn finishes the original reply where it was.
 */
export const askFor = internalMutation({
	args: { turnId: v.id("agentTurns"), agent: v.string(), message: v.string() },
	handler: async (ctx, { turnId, agent: name, message }) => {
		const { turn, chat } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			if (!(await personAsked(ctx, turn)))
				return { error: "Nobody asked you just now (a follow-up, check-in or automation), so don't ask other agents. Do what you can yourself." };
			const text = message.trim();
			if (!text) return { error: "Say what you need." };
			const agents = await ctx.db
				.query("agents")
				.withIndex("by_workspace_active", (q) => q.eq("workspaceId", turn.workspaceId).eq("archived", false))
				.collect();
			const wanted = name.trim().replace(/^@/, "").toLowerCase();
			const to = agents.find((a) => a.name.trim().toLowerCase() === wanted);
			if (!to) return { error: `No agent named ${JSON.stringify(name)}. Agents here: ${agents.filter((a) => a._id !== turn.agentId).map((a) => a.name).join(", ") || "none"}.` };
			if (to._id === turn.agentId) return { error: "That's you." };
			const chain = await chainOf(ctx, turn);
			if (chain.status !== "running") return { error: "Agents are paused on this until the person continues. Answer with what you have." };
			const depth = (turn.chain?.depth ?? 0) + 1;
			const handoff: Handoff<Id<"agents">> = { from: turn.agentId, to: to._id, path: pathOf(turn, chain), ask: { depth } };
			const limit = handoffLimit(budgetOf(chain), handoff);
			if (limit) return { error: askRefusal(limit, await agentNames(ctx, limit)) };
			await ctx.db.patch(chain._id, spend(budgetOf(chain), handoff));

			const ask = `@${to.name} ${text}`;
			const askId = await ctx.db.insert("chatMessages", {
				chatId: chat._id,
				workspaceId: chat.workspaceId,
				authorAgentId: turn.agentId,
				actingFor: turn.actorId,
				text: ask,
				parts: [{ type: "text", text: ask }],
				mentions: { userIds: [], agentIds: [to._id] },
				status: "done",
				quiet: true,
			});
			const note = `You asked ${to.name}: ${text}`;
			const wakeupId = await createWakeup(ctx, {
				workspaceId: turn.workspaceId,
				agentId: turn.agentId,
				chatId: turn.chatId,
				threadId: turn.threadId,
				actorId: turn.actorId,
				createdBy: turn.actorId,
				note: note.length > FOLLOWUP_NOTE_MAX ? `${note.slice(0, FOLLOWUP_NOTE_MAX - 1)}…` : note,
				foreign: false,
				jobId: askId,
				answer: { agentId: to._id },
			});
			await enqueueTurn(ctx, chat, {
				agentId: to._id,
				chatId: chat._id,
				threadId: askId,
				triggerId: askId,
				actorId: turn.actorId,
				chain: { id: chain._id, depth, path: [...handoff.path, to._id], epoch: chain.epoch },
				ask: { wakeupId },
			});
			return {
				asked: to.name,
				thread: { chatId: chat._id, messageId: askId },
				note: `${to.name} is answering, out of the chat. Its answer comes back to you in a new message here: say you asked, and stop until then.`,
			};
		});
	},
});

/** An asked agent's turn ended (turns.ts): its answer, or why there's none, goes back to the asker. */
export async function answerAsk(ctx: MutationCtx, turn: Doc<"agentTurns">, error?: string) {
	if (!turn.ask) return;
	const reply = turn.replyId && (await ctx.db.get(turn.replyId));
	const name = (await ctx.db.get(turn.agentId))?.name ?? "The agent";
	const answer = error || !reply ? `${name} couldn't answer${error ? `: ${error}` : "."}` : reply.text || `${name} answered with no text.`;
	await wake(ctx, turn.ask.wakeupId, { result: JSON.stringify(answer) });
}
