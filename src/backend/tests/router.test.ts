import { ROUTER_MIGHT_PER_HOUR, ROUTER_MODEL, defaultModel } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { STALE_TURN_MS } from "../convex/turns";
import { agentsOf, finishTurn, generalOf, noMentions, ownerAndMember, turnsOf, workspaceOf } from "./helpers";

// No network: the AI SDK's decide (Jev) and the agents' calls are stubbed, so nothing is billed. Fake timers
// hold the scheduled decision (and any reply it queues) back; tests run `router.decide` themselves.
const decideWith = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), experimental_decide: decideWith, generateText, streamText }));

/** Jev's answer: per agent its action. */
type Decision = { agent: string; action: "reply" | "quiet" };
const answer = (...decisions: Decision[]) =>
	decideWith.mockResolvedValue({
		answers: Object.fromEntries(decisions.map((d) => [d.agent, { type: "choice", choice: d.action }])),
		providerMetadata: { gateway: { cost: "0.0002" } },
	});

beforeEach(() => {
	vi.useFakeTimers();
	decideWith.mockReset();
	generateText.mockReset();
	streamText.mockReset();
	answer();
});
afterEach(() => void vi.useRealTimers());

/** #ops with Companybot (a1) then Scribe (a2), set to `replyMode`. */
async function setUp(replyMode: "mentions" | "relevant" = "relevant") {
	const { t, owner, member } = await ownerAndMember();
	const { companybot, scribe } = await agentsOf(owner);
	const chatId = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
	await owner.mutation(api.chats.addMembers, { chatId, userIds: [member.userId], agentIds: [companybot._id, scribe._id] });
	await owner.mutation(api.chats.updateChannel, { chatId, replyMode });
	const send = (as: typeof owner, text: string, threadId?: Id<"chatMessages">) => as.mutation(api.messages.send, { chatId, threadId, text, mentions: noMentions });
	const decide = (messageId: Id<"chatMessages">) => t.action(internal.router.decide, { messageId });
	const scheduled = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.startsWith("router")));
	return { t, owner, member, companybot, scribe, chatId, send, decide, scheduled };
}

describe("reply router", () => {
	it("leaves Mentions only channels exactly as before: no decision, no turns", async () => {
		const { t, owner, chatId, send, scheduled } = await setUp("mentions");
		await send(owner, "Can someone pull last month's revenue?");
		expect(await scheduled()).toEqual([]);
		expect(await turnsOf(t)).toEqual([]);
		const chat = await t.run((ctx) => ctx.db.get(chatId));
		expect(chat!.replyMode).toBe("mentions");
		expect((await owner.query(api.chats.get, { chatId }))!.replyMode).toBe("mentions");
	});

	it("is When relevant by default: a new channel goes to the router", async () => {
		const { owner } = await ownerAndMember();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "fresh", private: false });
		expect((await owner.query(api.chats.get, { chatId }))!.replyMode).toBe("relevant");
	});

	it("only lets the channel's managers change it", async () => {
		const { member, chatId } = await setUp();
		await expect(member.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" })).rejects.toThrow("Only the channel's creator or an owner");
	});

	it("queues a reply for the agent it picks, as the person who wrote, and records its cost", async () => {
		const { t, member, companybot, chatId, send, decide, scheduled } = await setUp();
		const messageId = await send(member, "What's on the calendar for Friday?");
		expect((await scheduled()).map((f) => f.args[0])).toEqual([{ messageId }]);
		answer({ agent: "a1", action: "reply" }, { agent: "a2", action: "quiet" });
		await decide(messageId);

		const call = decideWith.mock.calls[0]![0];
		expect(call.model).toBe(ROUTER_MODEL);
		expect(call.state).toContain('"What\'s on the calendar for Friday?"');
		expect(call.state).toContain("a1: Companybot");
		expect(call.state).toContain("a2: Scribe");
		expect(Object.keys(call.questions)).toEqual(expect.arrayContaining(["a1", "a2"]));
		const turns = await turnsOf(t);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ agentId: companybot._id, chatId, triggerId: messageId, actorId: member.userId, routed: true, status: "running" });
		const usage = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(usage).toEqual([expect.objectContaining({ userId: member.userId, kind: "router", model: ROUTER_MODEL, costUsd: 0.0002 })]);
		expect(usage[0]!.agentId).toBeUndefined();
		// The reply's prompt says nobody mentioned it; Jev gave no probability, so "probably".
		const context = await t.query(internal.turns.turnContext, { turnId: turns[0]!._id });
		expect(context.routed).toEqual({ band: "probably" });
	});

	it("wakes the agent a thanks is for, and its answer reacts on the message: no message, no separate call", async () => {
		const { t, member, scribe, chatId, send, decide } = await setUp();
		const messageId = await send(member, "thanks Scribe!");
		answer({ agent: "a2", action: "reply" });
		await decide(messageId);
		const [turn] = await turnsOf(t);
		expect(turn).toMatchObject({ agentId: scribe._id, routed: true, status: "running" });
		expect(generateText).not.toHaveBeenCalled();
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id, decision: { emoji: "🙏", new_point: "", to: "room", message: "" } });
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([expect.objectContaining({ messageId, emoji: "🙏", agentId: scribe._id })]);
		expect((await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent")).toEqual([]);
	});

	it("only wakes or leaves quiet: an answer of react from the model wakes nobody and reacts nothing", async () => {
		const { t, member, send, decide } = await setUp();
		decideWith.mockResolvedValue({ answers: { a1: { type: "choice", choice: "react" }, a2: { type: "choice", choice: "quiet" } }, providerMetadata: {} });
		await decide(await send(member, "thanks!"));
		expect(await turnsOf(t)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
		expect(generateText).not.toHaveBeenCalled();
	});

	it("does nothing when it picks quiet for everyone, but still records the call", async () => {
		const { t, owner, member, send, decide } = await setUp();
		await send(owner, "lunch at noon?");
		const messageId = await send(member, "sure, tacos");
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect())).map((u) => u.kind)).toEqual(["router"]);
	});

	it("makes one decision for a burst: the newest message's, which sees the ones before it", async () => {
		const { owner, member, send, decide } = await setUp();
		const first = await send(owner, "hey team");
		const second = await send(member, "hi!");
		const last = await send(owner, "Companybot can you summarize yesterday's leads");
		await decide(first);
		await decide(second);
		expect(decideWith).not.toHaveBeenCalled();
		await decide(last);
		expect(decideWith).toHaveBeenCalledTimes(1);
		const { state: prompt } = decideWith.mock.calls[0]![0];
		expect(prompt).toContain('"hey team"');
		expect(prompt).toContain('"hi!"');
		expect(prompt.indexOf("Newest message")).toBeLessThan(prompt.indexOf("summarize yesterday"));
	});

	it("skips messages that @mention an agent: they answer as today", async () => {
		const { t, owner, companybot, chatId, decide, scheduled } = await setUp();
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "status?", mentions: { userIds: [], agentIds: [companybot._id] } });
		expect(await scheduled()).toEqual([]);
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
		expect((await turnsOf(t)).map((x) => x.agentId)).toEqual([companybot._id]);
	});

	it("never decides on an agent's message", async () => {
		const { t, owner, companybot, chatId, decide, scheduled } = await setUp();
		const workspaceId = await workspaceOf(owner);
		const messageId = await t.run((ctx) =>
			ctx.db.insert("chatMessages", {
				workspaceId: workspaceId,
				chatId,
				authorAgentId: companybot._id,
				text: "Here's the summary.",
				parts: [],
				mentions: noMentions,
				status: "done",
			}),
		);
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
		expect(await scheduled()).toEqual([]);
	});

	it("routes thread replies into the thread, with its parent in the prompt", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const parent = await send(owner, "Q3 plan draft is up");
		const reply = await send(member, "can you list the open tasks for it?", parent);
		answer({ agent: "a1", action: "reply" });
		await decide(reply);
		expect(decideWith.mock.calls[0]![0].state).toMatch(/In a thread under this message:\n\[[^\]]+\] "Q3 plan draft is up"/);
		expect(await turnsOf(t)).toEqual([expect.objectContaining({ agentId: companybot._id, threadId: parent, triggerId: reply })]);
	});

	it("drops agents that left (or the setting going back) between the call and its answer", async () => {
		const { t, owner, member, scribe, chatId, send, decide } = await setUp();
		const messageId = await send(member, "Scribe, take notes please");
		decideWith.mockImplementation(async () => {
			await owner.mutation(api.chats.removeMember, { chatId, agentId: scribe._id });
			return { answers: { a2: { type: "choice", choice: "reply" } }, providerMetadata: {} };
		});
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);

		await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [scribe._id] });
		decideWith.mockImplementation(async () => {
			await owner.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" });
			return { answers: { a1: { type: "choice", choice: "reply" } }, providerMetadata: {} };
		});
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);
	});

	it("uses the workspace's pick: a language model answers the same rules as JSON", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings.routerModel).toBe(ROUTER_MODEL);
		expect(settings.routerModels.map((m) => m.id)).toEqual(expect.arrayContaining([ROUTER_MODEL, defaultModel]));
		await expect(owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: "made/up", expectedVersion: settings.version })).rejects.toThrow("reply decision models");
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: defaultModel, expectedVersion: settings.version });

		const messageId = await send(member, "What's on the calendar for Friday?");
		generateText.mockResolvedValue({ output: { decisions: [{ agent: "a1", action: "reply" }] }, providerMetadata: {} });
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
		expect(generateText.mock.calls[0]![0].model).toBe(defaultModel);
		expect((await turnsOf(t)).map((turn) => turn.agentId)).toEqual([companybot._id]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect()))[0]?.model ?? defaultModel).toBe(defaultModel);
	});

	it("runs a pick like any turn: hidden while it works, shown with the dispatcher's stats once it writes", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		const messageId = await send(member, "anyone know a good CRM tip?");
		withProbabilities({ a1: ["reply", 0.84] });
		await decide(messageId);
		const [turn] = await turnsOf(t);
		expect(turn!.dispatch).toEqual({ model: ROUTER_MODEL, band: "probably", probability: 0.84, probabilities: { reply: 0.84, quiet: 1 - 0.84 }, costUsd: 0.0002 });
		const reply = await t.run((ctx) => ctx.db.get(turn!.replyId as Id<"chatMessages">));
		expect(reply!.quiet).toBe(true);
		// It shows working, like any turn, until its message starts: it may well say nothing.
		expect((await member.query(api.typing.list, { chatId })).agents).toMatchObject([{ step: "Thinking…" }]);
		const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.routed).toEqual({ band: "probably" });
		const lastBefore = (await t.run((ctx) => ctx.db.get(chatId)))!.lastMessageAt;

		vi.advanceTimersByTime(1_000);
		await finishTurn(t, turn!._id, "Log every call the same day.", { usage: usageOf(0.0003) });
		const shown = await member.query(api.messages.list, { chatId });
		// One message: the reply itself, with its stats.
		const posted = shown.filter((m) => m.author.type === "agent");
		expect(posted).toEqual([expect.objectContaining({ _id: reply!._id, text: "Log every call the same day." })]);
		expect(posted[0]!.stats).toMatchObject({ costUsd: 0.0003, dispatch: { model: ROUTER_MODEL, band: "probably", probability: 0.84, probabilities: { reply: 0.84 }, costUsd: 0.0002 } });
		// Shown now: it counts as new in the chat.
		expect((await t.run((ctx) => ctx.db.get(chatId)))!.lastMessageAt).toBeGreaterThan(lastBefore);
		// Usage: the decision once under Reply decisions, the turn under the agent.
		const usage = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(usage.map((u) => [u.kind, u.costUsd])).toEqual(expect.arrayContaining([["router", 0.0002], ["chat", 0.0003]]));
	});

	it("shows a pick's widgets with its message, and nothing at all when it writes none", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		const widget = { type: "widget" as const, id: "w1", widget: { type: "stats", props: { title: "Widget test", items: [{ label: "Rendering check", value: "Live" }] } } };
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(await send(member, "can someone show me a stats widget?"));
		const [first] = await turnsOf(t);
		await finishTurn(t, first!._id, "Here it is.", { parts: [widget] });
		expect((await member.query(api.messages.list, { chatId })).find((m) => m.text === "Here it is.")!.parts).toEqual([widget, { type: "text", text: "Here it is." }]);

		withProbabilities({ a1: ["reply", 0.9] });
		await decide(await send(member, "and again?"));
		const second = (await turnsOf(t)).find((turn) => turn._id !== first!._id)!;
		await finishTurn(t, second._id, "", { parts: [widget] });
		expect((await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent")).toHaveLength(1);
	});

	it("shows no reply when its answer has no message, tool lines or not, and still records what it cost", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(await send(member, "Everyone pick their favorite emoji"));
		const [turn] = await turnsOf(t);
		const replyId = turn!.replyId as Id<"chatMessages">;
		const tool = { type: "tool" as const, id: "c1", name: "memory.search", label: "Searched memory", status: "done" as const };
		await finishTurn(t, turn!._id, "  \n ", { parts: [tool], usage: usageOf(0.0003) });
		const reply = (await t.run((ctx) => ctx.db.get(replyId)))!;
		expect(reply).toMatchObject({ status: "done", quiet: true, stats: { costUsd: 0.0003 } });
		expect((await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent")).toEqual([]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect())).map((u) => u.kind)).toContain("chat");
	});

	it("lets a woken agent respond with a reaction instead: added, no message", async () => {
		const { t, member, companybot, chatId, send, decide } = await setUp();
		const messageId = await send(member, "Can everyone vote yes or no via reaction");
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(messageId);
		const [turn] = await turnsOf(t);
		vi.useRealTimers();
		streamText.mockReturnValue({
			stream: (async function* () {
				yield { type: "start-step" };
				yield { type: "text-delta", text: '{"emoji":"👍","new_point":"","to":"room","message":""}' };
			})(),
			output: Promise.resolve({ emoji: "👍", new_point: "", to: "room", message: "" }),
		});
		await t.action(internal.agent.respond, { turnId: turn!._id });
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([expect.objectContaining({ messageId, emoji: "👍", agentId: companybot._id })]);
		expect((await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent")).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(turn!.replyId as Id<"chatMessages">)))!.quiet).toBe(true);
	});

	it("reacts and replies only through its answer; a chat_manage send here is a post for its person", async () => {
		const { t, owner, member, companybot, chatId, send, decide } = await setUp();
		const ask = await send(member, "Post 'Demo at 3pm' here for me and give me a reaction");
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(ask);
		const [turn] = await turnsOf(t);
		vi.useRealTimers();
		const general = (await generalOf(owner))._id;
		const tried = await runWith(t, turn!._id, { emoji: "👀", new_point: "", to: "room", message: "Posted it." }, [
			{ action: "send", chat: chatId, text: "Demo at 3pm" },
			{ action: "send", chat: "#general", text: "Heads up: #ops wants reactions." },
		]);
		expect(tried).toMatchObject([{ messageId: expect.any(String), note: expect.stringContaining("Don't repeat") }, { messageId: expect.any(String) }]);
		expect(tried[1]).not.toHaveProperty("note");
		// The reaction comes from its answer, on the message it answered.
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([expect.objectContaining({ messageId: ask, emoji: "👀", agentId: companybot._id })]);
		// Here: the post for its person, then its own reply.
		const here = (await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent");
		expect(here.map((m) => [m.text, "for" in m.author])).toEqual([["Demo at 3pm", true], ["Posted it.", false]]);
		expect((await member.query(api.messages.list, { chatId: general })).map((m) => m.text)).toContain("Heads up: #ops wants reactions.");
		// The answer is kept on the turn, to debug what it chose.
		expect((await turnsOf(t))[0]!.decision).toEqual({ emoji: "👀", new_point: "", to: "room", message: "Posted it." });
	});

	it("shows one emoji as one reaction, however it was written", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		const messageId = await send(member, "Everyone give me a heart");
		await member.mutation(api.messages.react, { messageId, emoji: "❤️" });
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(messageId);
		const turn = (await turnsOf(t)).find((x) => x.status === "running")!;
		// Without U+FE0F: the same heart, so the same row.
		await t.mutation(internal.turns.finishReply, { turnId: turn._id, decision: { emoji: "❤", new_point: "", to: "room", message: "" } });
		const message = (await member.query(api.messages.list, { chatId })).find((m) => m._id === messageId)!;
		expect(message.reactions).toMatchObject([{ emoji: "❤️", count: 2, mine: true, people: expect.arrayContaining([expect.objectContaining({ type: "agent", name: "Companybot" })]) }]);
	});

	it("reacts with any one emoji the decision picks, and never with text or two", async () => {
		const { t, member, companybot, send, decide } = await setUp();
		const react = async (text: string, emoji: string) => {
			const messageId = await send(member, text);
			withProbabilities({ a1: ["reply", 0.9] });
			await decide(messageId);
			const turn = (await turnsOf(t)).find((x) => x.status === "running")!;
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, decision: { emoji, new_point: "", to: "room", message: "" } });
			return messageId;
		};
		const unicorn = await react("Everyone give me a reaction", "🦄");
		for (const [text, emoji] of [["again!", "unicorn"], ["and again!", "🦄🦄"], ["once more", ""]] as const) await react(text, emoji);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([expect.objectContaining({ messageId: unicorn, emoji: "🦄", agentId: companybot._id })]);
	});

	it("shows a reply that held a call for approval as soon as the card is placed, so the person can decide", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(await send(member, "can someone add a task to call Chen?"));
		const [turn] = await turnsOf(t);
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: turn!._id, callId: "c1", tool: "records.save", input: "{}", risk: "inside" });
		const card = { type: "approval" as const, id: "c1", approvalId, tool: "records.save" };
		await t.mutation(internal.turns.updateReply, { turnId: turn!._id, text: "", parts: [card] });
		expect((await member.query(api.messages.list, { chatId })).find((m) => m._id === turn!.replyId)).toMatchObject({ status: "streaming" });
		// The run stopped at the call, so it made no answer: not a failure.
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect((await member.query(api.messages.list, { chatId })).find((m) => m._id === turn!.replyId)!.parts).toEqual([card]);
	});

	it("names the next agent: a decision to Scribe wakes it as a hop on the post, unless its pick is still to run", async () => {
		const { t, member, companybot, scribe, send, decide } = await setUp();
		const messageId = await send(member, "let's write a song together");
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(messageId);
		const first = (await turnsOf(t)).find((x) => x.agentId === companybot._id)!;
		await finishTurn(t, first._id, "I'm in! Scribe, want to take the verse?", { to: "Scribe" });
		const hop = (await turnsOf(t)).find((x) => x.agentId === scribe._id)!;
		expect(hop).toMatchObject({ routed: true, triggerId: first.replyId, chain: expect.anything(), dispatch: { band: "clearly", by: "Companybot", costUsd: 0 } });
		const context = await t.query(internal.turns.turnContext, { turnId: hop._id });
		expect(context).toMatchObject({ routed: { band: "clearly", by: "Companybot" }, handoff: { from: "Companybot" } });
		// Talking to a person: nobody else is asked who goes next.
		await finishTurn(t, hop._id, "Here's a verse idea. j, which mood?", { to: "Ada" });
		expect((await turnsOf(t)).filter((x) => x.agentId === companybot._id)).toHaveLength(1);

		// Scribe's pick waits on the same message: it runs next anyway, so no hop.
		const again = await send(member, "and a chorus?");
		withProbabilities({ a1: ["reply", 0.9], a2: ["reply", 0.6] });
		await decide(again);
		const lead = (await turnsOf(t)).find((x) => x.agentId === companybot._id && x.triggerId === again)!;
		await finishTurn(t, lead._id, "Scribe, your turn.", { to: "Scribe" });
		expect((await turnsOf(t)).filter((x) => x.agentId === scribe._id && x.triggerId === lead.replyId)).toEqual([]);
	});

	it("wakes an agent on a near miss (\"might be for you\"), up to the hourly cap per channel", async () => {
		const { t, member, companybot, send, decide } = await setUp();
		withProbabilities({ a1: ["quiet", 0.45], a2: ["quiet", 0.2] });
		// Each pick ends before the next message, so the message goes to the router (not to a reply running for them).
		for (let i = 0; i < ROUTER_MIGHT_PER_HOUR + 2; i++) {
			await decide(await send(member, `hmm ${i}`));
			for (const x of (await turnsOf(t)).filter((x) => x.status === "running")) await finishTurn(t, x._id, "");
		}
		const turns = await turnsOf(t);
		expect(turns).toHaveLength(ROUTER_MIGHT_PER_HOUR);
		expect(turns.every((x) => x.agentId === companybot._id && x.dispatch?.band === "might")).toBe(true);
		// Every call is still counted.
		const router = (await t.run((ctx) => ctx.db.query("usage").collect())).filter((u) => u.kind === "router");
		expect(router.reduce((sum, u) => sum + u.costUsd, 0)).toBeCloseTo(0.0002 * (ROUTER_MIGHT_PER_HOUR + 2));
		// An hour later there's room again.
		vi.advanceTimersByTime(61 * 60_000);
		await decide(await send(member, "hmm again"));
		expect(await turnsOf(t)).toHaveLength(ROUTER_MIGHT_PER_HOUR + 1);
	});

	it("runs one message's picks one after another, best fit first; a pick's @mention in what it posts hands off", async () => {
		const { t, member, companybot, scribe, send, decide } = await setUp();
		const messageId = await send(member, "anyone know a good CRM tip?");
		withProbabilities({ a1: ["reply", 0.9], a2: ["quiet", 0.45] });
		await decide(messageId);
		const turnOf = async (agentId: Id<"agents">) => (await turnsOf(t)).find((x) => x.agentId === agentId && x.triggerId === messageId)!;
		const first = await turnOf(companybot._id);
		const second = await turnOf(scribe._id);
		expect([first.status, second.status]).toEqual(["running", "queued"]);
		expect(first.dispatch).toMatchObject({ band: "clearly", then: second._id });
		expect(second.dispatch).toMatchObject({ band: "might", after: first._id });

		// Companybot answers and hands to Scribe by @mention; Scribe's waiting pick starts, told who went first.
		await finishTurn(t, first._id, "Log every call. @Scribe can you add it to the tips page?");
		expect((await turnOf(scribe._id)).status).toBe("running");
		expect((await t.query(internal.turns.turnContext, { turnId: second._id })).routed).toMatchObject({ band: "might", before: ["Companybot"] });
		const handed = (await turnsOf(t)).filter((x) => x.agentId === scribe._id && x.triggerId !== messageId);
		expect(handed).toEqual([expect.objectContaining({ triggerId: first.replyId, chain: expect.anything() })]);
	});

	it("starts a waiting pick anyway once the one before it is stale", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		const messageId = await send(member, "anyone know a good CRM tip?");
		withProbabilities({ a1: ["reply", 0.9], a2: ["quiet", 0.45] });
		await decide(messageId);
		vi.advanceTimersByTime(STALE_TURN_MS + 1_000);
		await t.mutation(internal.turns.startWaiting, { triggerId: messageId });
		expect((await turnsOf(t)).find((x) => x.agentId === scribe._id)!.status).toBe("running");
	});
});

/**
 * Runs a turn (agent.respond) on a stubbed model that first calls chat_manage with each request,
 * one step each, then ends with `decision`. Returns what each call got back.
 */
async function runWith(t: Awaited<ReturnType<typeof setUp>>["t"], turnId: Id<"agentTurns">, decision: Record<string, unknown>, requests: Record<string, unknown>[]) {
	const results: unknown[] = [];
	streamText.mockImplementation(({ tools }) => ({
		stream: (async function* () {
			for (const [i, request] of requests.entries()) {
				yield { type: "start-step" };
				yield { type: "tool-call", toolCallId: `c${i}`, toolName: "chat_manage", input: { request } };
				const output = await tools.chat_manage.execute({ request }, { toolCallId: `c${i}`, messages: [] });
				results.push(output);
				yield { type: "tool-result", toolCallId: `c${i}`, toolName: "chat_manage", output };
			}
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(decision) };
		})(),
		output: Promise.resolve(decision),
	}));
	await t.action(internal.agent.respond, { turnId });
	return results;
}

/** Jev's answer with how sure it was: per agent its choice and the chance of "reply". */
const withProbabilities = (picks: Record<string, ["reply" | "quiet", number]>) =>
	decideWith.mockResolvedValue({
		answers: Object.fromEntries(Object.entries(picks).map(([key, [choice, reply]]) => [key, { type: "choice", choice, probabilities: { reply, quiet: 1 - reply } }])),
		providerMetadata: { gateway: { cost: "0.0002" } },
	});

const usageOf = (costUsd: number) => ({ model: defaultModel, steps: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, contextTokens: 100, costUsd, durationMs: 900 });
