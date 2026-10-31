import { ROUTER_MIGHT_PER_HOUR, ROUTER_MODEL, defaultModel } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { STALE_TURN_MS } from "../convex/turns";
import { agentsOf, noMentions, ownerAndMember, turnsOf, workspaceOf } from "./helpers";

// No network: the AI SDK's decide (Jev) is stubbed, so nothing is billed. Fake timers hold the
// scheduled decision (and any reply it queues) back; tests run `router.decide` themselves.
const decideWith = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), experimental_decide: decideWith, generateText }));

/** Jev's answer: per agent its action, and for a reaction which one, by choice name. */
type Decision = { agent: string; action: "reply" | "react" | "quiet"; emoji: string | null };
const EMOJI_NAMES: Record<string, string> = { "👍": "thumbs_up", "❤️": "heart", "🎉": "party", "😂": "laugh", "👀": "eyes", "🙏": "pray", "✅": "check", "🔥": "fire" };
const answer = (...decisions: Decision[]) =>
	decideWith.mockResolvedValue({
		answers: Object.fromEntries(
			decisions.flatMap((d) => [[d.agent, { type: "choice", choice: d.action }], ...(d.emoji ? [[`${d.agent}_emoji`, { type: "choice", choice: EMOJI_NAMES[d.emoji] ?? d.emoji }]] : [])]),
		),
		providerMetadata: { gateway: { cost: "0.0002" } },
	});

beforeEach(() => {
	vi.useFakeTimers();
	decideWith.mockReset();
	generateText.mockReset();
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
		answer({ agent: "a1", action: "reply", emoji: null }, { agent: "a2", action: "quiet", emoji: null });
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
		expect(context.routed).toEqual({ band: "probably", quiet: true });
	});

	it("reacts for the agent it picks, and a second decision doesn't take the reaction back", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		const messageId = await send(member, "thanks Scribe!");
		answer({ agent: "a2", action: "react", emoji: "🙏" });
		await decide(messageId);
		await decide(messageId);
		const reactions = await t.run((ctx) => ctx.db.query("reactions").collect());
		expect(reactions).toEqual([expect.objectContaining({ messageId, emoji: "🙏", agentId: scribe._id })]);
		expect(await turnsOf(t)).toEqual([]);
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
		answer({ agent: "a1", action: "reply", emoji: null });
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

	it("doesn't let an agent without chat.react react", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		await t.run((ctx) => ctx.db.patch(scribe._id, { tools: ["memory.search"] }));
		const messageId = await send(member, "thanks Scribe!");
		answer({ agent: "a2", action: "react", emoji: "🙏" });
		await decide(messageId);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
		expect(decideWith.mock.calls[0]![0].state).toContain("Can't react.");
	});

	it("uses the workspace's pick: a language model answers the same rules as JSON", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings.routerModel).toBe(ROUTER_MODEL);
		expect(settings.routerModels.map((m) => m.id)).toEqual(expect.arrayContaining([ROUTER_MODEL, defaultModel]));
		await expect(owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: "made/up", expectedVersion: settings.version })).rejects.toThrow("reply decision models");
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: defaultModel, expectedVersion: settings.version });

		const messageId = await send(member, "What's on the calendar for Friday?");
		generateText.mockResolvedValue({ output: { decisions: [{ agent: "a1", action: "reply", emoji: null }] }, providerMetadata: {} });
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
		expect(generateText.mock.calls[0]![0].model).toBe(defaultModel);
		expect((await turnsOf(t)).map((turn) => turn.agentId)).toEqual([companybot._id]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect()))[0]?.model ?? defaultModel).toBe(defaultModel);
	});

	it("runs a pick quietly: the agent posts only with chat.notify, and that message shows the dispatcher", async () => {
		const { t, member, chatId, send, decide } = await setUp();
		const messageId = await send(member, "anyone know a good CRM tip?");
		withProbabilities({ a1: ["reply", 0.84] });
		await decide(messageId);
		const [turn] = await turnsOf(t);
		expect(turn!.dispatch).toEqual({ model: ROUTER_MODEL, band: "probably", probability: 0.84, probabilities: { reply: 0.84, react: 0, quiet: 1 - 0.84 }, costUsd: 0.0002, quiet: true });
		const reply = await t.run((ctx) => ctx.db.get(turn!.replyId as Id<"chatMessages">));
		expect(reply!.quiet).toBe(true);
		// Nobody sees it working: it may well say nothing.
		expect((await member.query(api.typing.list, { chatId })).agents).toEqual([]);
		const prompt = (await t.query(internal.turns.turnContext, { turnId: turn!._id })).routed;
		expect(prompt).toEqual({ band: "probably", quiet: true });

		expect(await t.mutation(internal.wakeups.notifyFor, { turnId: turn!._id, text: "Log every call the same day." })).toEqual({ posted: true });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id, usage: usageOf(0.0003) });
		const shown = await member.query(api.messages.list, { chatId });
		const posted = shown.find((m) => m.text === "Log every call the same day.");
		expect(posted!.stats).toMatchObject({ costUsd: 0.0003, dispatch: { model: ROUTER_MODEL, band: "probably", probability: 0.84, probabilities: { reply: 0.84 }, costUsd: 0.0002 } });
		expect(posted!.stats!.dispatch).not.toHaveProperty("quiet");
		expect(shown.some((m) => m._id === reply!._id)).toBe(false);
		// Usage: the decision once under Reply decisions, the turn under the agent.
		const usage = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(usage.map((u) => [u.kind, u.costUsd])).toEqual(expect.arrayContaining([["router", 0.0002], ["chat", 0.0003]]));
	});

	it("posts as before for an agent that can't use chat.notify", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		await t.run((ctx) => ctx.db.patch(scribe._id, { tools: ["memory.search"] }));
		const messageId = await send(member, "Scribe, take notes please");
		withProbabilities({ a2: ["reply", 0.95] });
		await decide(messageId);
		const [turn] = await turnsOf(t);
		expect(turn!.dispatch).toMatchObject({ model: ROUTER_MODEL, band: "clearly", probability: 0.95, costUsd: 0.0002 });
		expect(turn!.dispatch!.quiet).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(turn!.replyId as Id<"chatMessages">)))!.quiet).toBeUndefined();
	});

	it("wakes an agent on a near miss (\"might be for you\"), up to the hourly cap per channel", async () => {
		const { t, member, companybot, send, decide } = await setUp();
		withProbabilities({ a1: ["quiet", 0.45], a2: ["quiet", 0.2] });
		for (let i = 0; i < ROUTER_MIGHT_PER_HOUR + 2; i++) await decide(await send(member, `hmm ${i}`));
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
		expect(await t.mutation(internal.wakeups.notifyFor, { turnId: first._id, text: "Log every call. @Scribe can you add it to the tips page?" })).toEqual({ posted: true });
		await t.mutation(internal.turns.finishReply, { turnId: first._id });
		expect((await turnOf(scribe._id)).status).toBe("running");
		expect((await t.query(internal.turns.turnContext, { turnId: second._id })).routed).toMatchObject({ band: "might", before: ["Companybot"] });
		const handed = (await turnsOf(t)).filter((x) => x.agentId === scribe._id && x.triggerId !== messageId);
		expect(handed).toEqual([expect.objectContaining({ triggerId: (await turnOf(companybot._id)).notifiedId, chain: expect.anything() })]);
	});

	it("lets the first un-asked agent to post claim it: another one posting here meanwhile hears so, once", async () => {
		const { t, member, companybot, scribe, chatId, send, decide } = await setUp();
		await t.run((ctx) => ctx.db.patch(scribe._id, { tools: ["chat.*"] }));
		// Two messages, two decisions: each picks a different agent, both running at once.
		withProbabilities({ a1: ["reply", 0.9] });
		await decide(await send(member, "anyone know a good CRM tip?"));
		withProbabilities({ a2: ["reply", 0.7] });
		await decide(await send(member, "?"));
		const [mine, theirs] = [companybot._id, scribe._id].map((id) => async () => (await turnsOf(t)).find((x) => x.agentId === id)!);
		const scribeTurn = await theirs!();
		expect((await t.query(internal.turns.turnContext, { turnId: scribeTurn._id })).routed).toMatchObject({ answering: ["Companybot"] });

		expect(await t.mutation(internal.wakeups.notifyFor, { turnId: (await mine!())._id, text: "Log every call the same day." })).toEqual({ posted: true });
		const refused = await t.mutation(internal.wakeups.notifyFor, { turnId: scribeTurn._id, text: "Log every call." });
		expect(refused).toEqual({ error: expect.stringContaining('Not posted: Companybot just posted here: "Log every call the same day."') });
		// It read that; a second try means it adds something.
		expect(await t.mutation(internal.wakeups.notifyFor, { turnId: scribeTurn._id, text: "Also: tag each call by outcome." })).toEqual({ posted: true });
		expect((await member.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent").map((m) => m.text)).toEqual(["Log every call the same day.", "Also: tag each call by outcome."]);
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

/** Jev's answer with how sure it was: per agent its choice and the chance of "reply". */
const withProbabilities = (picks: Record<string, ["reply" | "react" | "quiet", number]>) =>
	decideWith.mockResolvedValue({
		answers: Object.fromEntries(Object.entries(picks).map(([key, [choice, reply]]) => [key, { type: "choice", choice, probabilities: { reply, react: 0, quiet: 1 - reply } }])),
		providerMetadata: { gateway: { cost: "0.0002" } },
	});

const usageOf = (costUsd: number) => ({ model: defaultModel, steps: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, contextTokens: 100, costUsd, durationMs: 900 });
