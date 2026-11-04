import { AGENT_DEBOUNCE_MS } from "@companybot/core";
import type { convexTest } from "convex-test";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { STEER_WINDOW_MS } from "../convex/agent";
import { type As, agentTurn, agentsOf, finishTurn, generalOf, noMentions, ownerAndMember, turnsOf } from "./helpers";

// Your message steers the running turn (#189, wiki/chat.md "Steering"). No network: the runner's model
// call is a scripted stream that honors the abort signal, and calls the run's prepareStep and stop
// conditions at step boundaries, as the AI SDK's loop does. Timers are fake: a script moves the clock to
// let the runner flush (and hear a new message) while it writes.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

type Options = {
	abortSignal: AbortSignal;
	messages: ModelMessage[];
	stopWhen: ((o: { steps: unknown[] }) => boolean | PromiseLike<boolean>)[];
	prepareStep: (o: { stepNumber: number; messages: ModelMessage[] }) => Promise<{ messages?: ModelMessage[] }>;
};
/**
 * Scripts one run: `script` yields stream parts; the stub ends the stream on abort, like the SDK. Its
 * `output` (the decision) is the last step's text as JSON, as the SDK parses it, unless given.
 */
function scripted(script: (o: Options) => AsyncGenerator<object>, output?: object) {
	streamText.mockImplementationOnce((o: Options) => {
		let stepText = "";
		return {
			get output() {
				return output ? Promise.resolve(output) : Promise.resolve().then(() => JSON.parse(stepText));
			},
			stream: (async function* (): AsyncGenerator<object> {
				for await (const part of script(o)) {
					if (o.abortSignal.aborted) {
						yield { type: "abort" };
						return;
					}
					const p = part as { type: string; text?: string };
					if (p.type === "start-step") stepText = "";
					if (p.type === "text-delta") stepText += p.text;
					yield part;
				}
			})(),
		};
	});
}
/** A reply's answer as the model streams it: its JSON, the message in pieces (`words`) between. */
const opens = { type: "text-delta", text: '{"emoji":null,"new_point":"An answer","to":"Ada","message":"' };
const words = (text: string) => ({ type: "text-delta", text: JSON.stringify(text).slice(1, -1) });
const closes = { type: "text-delta", text: '"}' };
function* answer(message: string) {
	yield opens;
	yield words(message);
	yield closes;
}
/** The boundary after a step that called tools: the stop conditions, then the next step's prepareStep. */
async function nextStep(o: Options, step: number, messages: ModelMessage[]) {
	const stops = (await Promise.all(o.stopWhen.map((c) => c({ steps: Array(step).fill({}) })))).some(Boolean);
	if (stops) return null;
	return (await o.prepareStep({ stepNumber: step, messages })).messages ?? messages;
}
const finishStep = { type: "finish-step", usage: { inputTokens: 100, outputTokens: 20 }, providerMetadata: { gateway: { cost: "0.001" } } };
const toolCall = (id: string) => ({ type: "tool-call", toolCallId: id, toolName: "memory_search", input: { query: "Acme" } });
const toolResult = (id: string) => ({ type: "tool-result", toolCallId: id, toolName: "memory_search", input: { query: "Acme" }, output: [] });
/**
 * Moves the clock past FLUSH_MS, so the runner's next part flushes (and hears what's new), and past the
 * person's quiet window, so a reply cut off then starts over at once. Timers don't fire: the scheduled runs stay put.
 */
const later = async () => vi.setSystemTime(Date.now() + AGENT_DEBOUNCE_MS + 100);
/** Real time, for a reply that waits for the person to pause (the fake clock doesn't move by itself). */
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	streamText.mockReset();
});

type T = ReturnType<typeof convexTest>;
const say = (as: As, chatId: Id<"chats">, text: string, agentIds: Id<"agents">[] = []) =>
	as.mutation(api.messages.send, { chatId, text, mentions: { userIds: [], agentIds } });
const turnOf = (t: T, id: Id<"agentTurns">) => t.run((ctx) => ctx.db.get(id));
const replyOf = async (t: T, id: Id<"agentTurns">) => t.run(async (ctx) => ctx.db.get((await ctx.db.get(id))!.replyId!));
const agentMessages = (t: T, chatId: Id<"chats">) =>
	t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).filter((m) => m.chatId === chatId && m.authorAgentId));
const lastContent = (messages: ModelMessage[]) => {
	const last = messages.at(-1)!;
	return { role: last.role, text: typeof last.content === "string" ? last.content : JSON.stringify(last.content) };
};
const turnFor = async (t: T, messageId: Id<"chatMessages">) => (await turnsOf(t)).find((x) => x.triggerId === messageId)!;

/** The owner's agent DM with a turn running on "do X". */
async function dm() {
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const first = await say(owner, chatId, "do X");
	const turnId = (await turnFor(t, first))._id;
	expect((await turnOf(t, turnId))!.status).toBe("running");
	return { t, owner, member, companybot, chatId, turnId };
}

describe("steering a running turn", () => {
	it("mid-tool-loop: the person's new message is in the next step's messages, and gets no reply of its own", async () => {
		const { t, owner, chatId, turnId } = await dm();
		let steered: ModelMessage[] | null = null;
		let sent!: Id<"chatMessages">;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			// Sent while the tool runs, waiting out its quiet window like any message in the app.
			sent = await say(owner.debounced(), chatId, "actually do Y");
			expect(await turnFor(t, sent)).toMatchObject({ status: "queued", debouncing: true, person: true });
			yield toolResult("c1");
			yield finishStep;
			steered = await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			yield* answer("Switching to Y. Done.");
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });

		expect(lastContent(steered!)).toMatchObject({ role: "user", text: expect.stringMatching(/while you were replying\. It comes first[\s\S]*\(asker\)[^\n]*"actually do Y"/) });
		// Plain words only: nothing internal ("steer", "turn") reaches the model.
		expect(lastContent(steered!).text).not.toMatch(/steer|\bturn\b/i);
		const turn = (await turnOf(t, turnId))!;
		expect(turn).toMatchObject({ status: "done", steered: [sent] });
		// Its stored prompt (replayed to later turns) has the message, after what was there.
		expect(turn.prompt).toMatch(/do X[\s\S]*"actually do Y"$/);
		expect(await turnFor(t, sent)).toMatchObject({ status: "done", mergedInto: turnId });
		// Its quiet window ending later starts nothing.
		await t.mutation(internal.turns.startQueued, { turnId: (await turnFor(t, sent))._id });
		expect((await turnsOf(t)).filter((x) => x.status === "queued" || x.status === "running")).toHaveLength(0);
		expect((await agentMessages(t, chatId)).map((m) => m.text)).toEqual(["Switching to Y. Done."]);

		// Nothing answered twice: the next turn's window starts after what this one took in.
		const next = await turnFor(t, await say(owner, chatId, "and Z"));
		expect((await t.query(internal.turns.turnContext, { turnId: next._id })).messages.map((m) => m.text)).toEqual(["and Z"]);
	});

	it("a message saying stop is taken in like any other, and the model ends the task", async () => {
		const { t, owner, chatId, turnId } = await dm();
		let secondTool = false;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			await say(owner, chatId, "stop, never mind");
			yield toolResult("c1");
			yield finishStep;
			const messages = await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			// The model reads it and decides: no more tools, a short acknowledgement.
			if (lastContent(messages!).text.includes("stop, never mind")) {
				yield* answer("Okay, stopped.");
				yield finishStep;
				return;
			}
			secondTool = true;
			yield toolCall("c2");
		});
		await t.action(internal.agent.respond, { turnId });
		expect(secondTool).toBe(false);
		// Not a Stop: nothing matched the word; the turn ended on its own, normally.
		const turn = (await turnOf(t, turnId))!;
		expect(turn.stopping).toBeUndefined();
		expect(turn.status).toBe("done");
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: "Okay, stopped." });
		expect((await replyOf(t, turnId))!.stoppedBy).toBeUndefined();
		expect(await agentMessages(t, chatId)).toHaveLength(1);
	});

	it("while it writes its answer: starts over with every message, without the text it had", async () => {
		const { t, owner, chatId, turnId } = await dm();
		let sent!: Id<"chatMessages">;
		let cutOff = true;
		scripted(async function* () {
			yield { type: "start-step" };
			yield opens;
			yield words("Roses are");
			sent = await say(owner, chatId, "make it about cats");
			await later();
			yield words(" red");
			yield words(", violets are blue");
			yield closes;
			yield finishStep;
			cutOff = false;
		});
		let restarted: ModelMessage[] = [];
		scripted(async function* (o) {
			restarted = o.messages;
			yield { type: "start-step" };
			yield* answer("Switching to cats: cats are soft.");
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });

		expect(cutOff).toBe(true);
		expect(streamText).toHaveBeenCalledTimes(2);
		// The new run: what the first was sent (the prompt), then the person's message.
		expect(restarted).toHaveLength(2);
		expect(restarted[0]).toMatchObject({ role: "user", content: expect.stringContaining("do X") });
		expect(lastContent(restarted)).toMatchObject({ role: "user", text: expect.stringContaining('"make it about cats"') });
		// One reply, with only the new answer: the cut-off text isn't left behind.
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: "Switching to cats: cats are soft." });
		expect(await agentMessages(t, chatId)).toHaveLength(1);
		expect(await turnFor(t, sent)).toMatchObject({ status: "done", mergedInto: turnId });
		expect((await turnOf(t, turnId))!.stopping).toBeUndefined();
	});

	it("a burst while it writes: waits for the person to pause, starts over once with all of it, and shows below it", async () => {
		const { t, owner, chatId, turnId } = await dm();
		// Real time from here: the runner sleeps until the person pauses.
		vi.useRealTimers();
		const sent: Id<"chatMessages">[] = [];
		let cutOff = false;
		let rest: Promise<void> = Promise.resolve();
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield opens;
			yield words("Sure");
			sent.push(await say(owner, chatId, "with something?"));
			// The next part flushes (every 200ms) and hears it.
			await pause(250);
			yield words(", what");
			cutOff = o.abortSignal.aborted;
			// The rest of the burst lands while it waits.
			rest = (async () => {
				await pause(300);
				sent.push(await say(owner, chatId, "pl;llllease?"));
				await pause(300);
				sent.push(await say(owner, chatId, ":)"));
			})();
			yield words(" do you need?");
			yield closes;
			yield finishStep;
		});
		let restarted: ModelMessage[] = [];
		scripted(async function* (o) {
			restarted = o.messages;
			yield { type: "start-step" };
			yield* answer("Sure, what do you need help with?");
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });
		await rest;

		expect(cutOff).toBe(true);
		// One restart for the whole burst, with all three in its note, in order.
		expect(streamText).toHaveBeenCalledTimes(2);
		expect(restarted).toHaveLength(2);
		expect(lastContent(restarted).text).toMatch(/"with something\?"[\s\S]*"pl;llllease\?"[\s\S]*":\)"/);
		expect((await turnOf(t, turnId))!.steered).toEqual(sent);
		for (const id of sent) expect(await turnFor(t, id)).toMatchObject({ status: "done", mergedInto: turnId });
		// No follow-up: nothing is left to answer.
		expect((await turnsOf(t)).filter((x) => x.status === "queued" || x.status === "running")).toHaveLength(0);
		expect(await agentMessages(t, chatId)).toHaveLength(1);
		// The reply shows below everything it read, though it began before them.
		expect((await owner.query(api.messages.list, { chatId })).map((m) => m.text)).toEqual(["do X", "with something?", "pl;llllease?", ":)", "Sure, what do you need help with?"]);
	});

	it("Stop pressed while it waits for the person to pause ends the turn", async () => {
		const { t, owner, chatId, turnId } = await dm();
		vi.useRealTimers();
		let sent!: Id<"chatMessages">;
		let stopping: Promise<unknown> = Promise.resolve();
		scripted(async function* () {
			yield { type: "start-step" };
			yield opens;
			yield words("Sure");
			sent = await say(owner, chatId, "with something?");
			await pause(250);
			yield words(", what");
			stopping = pause(300).then(() => owner.mutation(api.turns.stop, { turnId }));
			yield words(" do you need?");
		});
		await t.action(internal.agent.respond, { turnId });
		await stopping;

		// It never started over, and the cut-off text is gone.
		expect(streamText).toHaveBeenCalledTimes(1);
		expect((await turnOf(t, turnId))!).toMatchObject({ status: "done" });
		expect((await turnOf(t, turnId))!.steered).toBeUndefined();
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: "", stoppedBy: expect.anything() });
		// The message wasn't taken in: it gets its own turn, as after any Stop.
		expect(await turnFor(t, sent)).toMatchObject({ status: "running" });
	});

	it(`keeps starting over while the person writes; past ${STEER_WINDOW_MS / 1000}s a message gets the usual follow-up`, async () => {
		const { t, owner, chatId, turnId } = await dm();
		const sent: Id<"chatMessages">[] = [];
		// Five bursts (more than any old count limit) are all taken in; then the clock passes the window.
		const restarts = 5;
		for (let run = 0; run <= restarts; run++) {
			scripted(async function* () {
				yield { type: "start-step" };
				yield opens;
				yield words(`Answer ${run}`);
				if (run === restarts) vi.setSystemTime(Date.now() + STEER_WINDOW_MS);
				sent.push(await say(owner, chatId, `more ${run}`));
				await later();
				yield words(".");
				yield closes;
				yield finishStep;
			});
		}
		await t.action(internal.agent.respond, { turnId });

		expect(streamText).toHaveBeenCalledTimes(restarts + 1);
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: `Answer ${restarts}.` });
		const merged = sent.slice(0, restarts);
		for (const id of merged) expect(await turnFor(t, id)).toMatchObject({ status: "done", mergedInto: turnId });
		expect((await turnOf(t, turnId))!.steered).toEqual(merged);
		// The last one came past the window: it starts its own turn, whose window has only it.
		const followUp = await turnFor(t, sent.at(-1)!);
		expect(followUp.status).toBe("running");
		expect((await t.query(internal.turns.turnContext, { turnId: followUp._id })).messages.map((m) => m.text)).toEqual([`more ${restarts}`]);
	});

	it("another person's message never steers someone else's turn: it keeps its own", async () => {
		const { t, owner, member } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, general, companybot._id);
		let next: ModelMessage[] | null = null;
		let theirs!: Id<"chatMessages">;
		let heard: unknown;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			theirs = await say(member, general, "@Companybot do Z instead", [companybot._id]);
			heard = await t.query(internal.turns.isStopping, { turnId });
			yield toolResult("c1");
			yield finishStep;
			next = await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			yield* answer("Here's X.");
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });

		expect(heard).toEqual({ stopped: false, steer: false });
		expect(JSON.stringify(next)).not.toContain("do Z instead");
		expect((await turnOf(t, turnId))!.steered).toBeUndefined();
		// The member's turn runs next, as the member.
		expect(await turnFor(t, theirs)).toMatchObject({ status: "running", actorId: member.userId });
		expect((await turnFor(t, theirs)).mergedInto).toBeUndefined();
	});
});

// A channel set to "When relevant": the dispatcher's pick runs like any turn, and may answer with nothing.
describe("steering a dispatcher's pick in a channel", () => {
	const quietly = { emoji: null, new_point: "", to: "room", message: "" };
	/** Lets an un-awaited check (turnStop's, on a stream part) land before the script goes on. */
	const settled = async (o: Options) => {
		for (let i = 0; i < 500 && !o.abortSignal.aborted; i++) await Promise.resolve();
	};
	const routerRuns = (t: T) => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.startsWith("router")).map((f) => f.args[0]));

	/** #ops with Companybot and Scribe; the owner's un-mentioned question was picked for Companybot, whose reply runs, not shown yet. */
	async function picked() {
		const { t, owner, member } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		await owner.mutation(api.chats.addMembers, { chatId, userIds: [member.userId], agentIds: [companybot._id, scribe._id] });
		const asked = await say(owner, chatId, "Can you do this problem for me: 5 / 10");
		await t.mutation(internal.router.apply, { messageId: asked, replies: [{ agentId: companybot._id, probability: 0.4 }], model: "jev", costUsd: 0.0002 });
		const turn = await turnFor(t, asked);
		expect(turn).toMatchObject({ status: "running", routed: true, dispatch: { band: "might" } });
		expect((await replyOf(t, turn._id))!.quiet).toBe(true);
		return { t, owner, member, companybot, scribe, chatId, turnId: turn._id };
	}

	it("your un-mentioned message reaches it at its next step: no reply of its own", async () => {
		const { t, owner, chatId, turnId, companybot } = await picked();
		let next: ModelMessage[] | null = null;
		let nvm!: Id<"chatMessages">;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			nvm = await say(owner, chatId, "nvm");
			yield toolResult("c1");
			yield finishStep;
			next = await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(quietly) };
			yield finishStep;
		}, quietly);
		await t.action(internal.agent.respond, { turnId });

		expect(lastContent(next!)).toMatchObject({ role: "user", text: expect.stringMatching(/sent this while you were replying[\s\S]*\(asker\)[^\n]*"nvm"/) });
		expect((await turnOf(t, turnId))!).toMatchObject({ status: "done", steered: [nvm] });
		// Queued as a follow-up like the pick (how sure it was), but not a pick: no cost, nothing to wait for.
		const followUp = await turnFor(t, nvm);
		expect(followUp).toMatchObject({ status: "done", mergedInto: turnId, person: true, routed: true, dispatch: { band: "might", costUsd: 0 } });
		expect(followUp.dispatch!.after).toBeUndefined();
		// It decided not to post, and "nvm" got no reply of its own.
		expect((await agentMessages(t, chatId)).filter((m) => !m.quiet)).toHaveLength(0);
		expect((await turnsOf(t)).filter((x) => x.status === "queued" || x.status === "running")).toHaveLength(0);
		// The router still weighs "nvm" for the others, but doesn't pick Companybot for it again.
		expect(await routerRuns(t)).toContainEqual({ messageId: nvm });
		await t.mutation(internal.router.apply, { messageId: nvm, replies: [{ agentId: companybot._id, probability: 0.4 }], model: "jev", costUsd: 0.0002 });
		expect((await turnsOf(t)).filter((x) => x.triggerId === nvm)).toHaveLength(1);
	});

	it("mid-message: drops what it wrote and streams its new answer, like any turn", async () => {
		const { t, owner, chatId, turnId } = await picked();
		let nvm!: Id<"chatMessages">;
		let cutOff = true;
		let shownBefore: unknown;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield { type: "text-delta", text: '{"emoji":null,"new_point":"5 ÷ 10 = 0.5","to":"room","message":"5 ÷' };
			// The message started: it's shown, streaming, like an asked reply.
			await later();
			yield { type: "text-delta", text: " 10" };
			const replyId = (await turnOf(t, turnId))!.replyId;
			shownBefore = (await owner.query(api.messages.list, { chatId })).find((m) => m._id === replyId);
			nvm = await say(owner, chatId, "nvm, what's 6 / 3?");
			await later();
			// The next part's check hears it and cuts the step off.
			yield { type: "text-delta", text: " =" };
			await settled(o);
			yield { type: "text-delta", text: ' 0.5"}' };
			yield finishStep;
			cutOff = false;
		}, { emoji: null, new_point: "5 ÷ 10 = 0.5", to: "room", message: "5 ÷ 10 = 0.5" });
		let restarted: ModelMessage[] = [];
		let streamAtRestart: unknown;
		scripted(async function* (o) {
			restarted = o.messages;
			streamAtRestart = await t.run(async (ctx) => (await ctx.db.query("replyStreams").first())?.text);
			yield { type: "start-step" };
			yield* answer("6 ÷ 3 = 2.");
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });

		expect(cutOff).toBe(true);
		expect(shownBefore).toMatchObject({ status: "streaming" });
		expect(streamText).toHaveBeenCalledTimes(2);
		expect(lastContent(restarted)).toMatchObject({ role: "user", text: expect.stringContaining('"nvm, what\'s 6 / 3?"') });
		// The partial message was dropped before the new run began, and only the new answer is left.
		expect(streamAtRestart).toBe("");
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: "6 ÷ 3 = 2.", parts: [{ type: "text", text: "6 ÷ 3 = 2." }] });
		expect((await owner.query(api.messages.list, { chatId })).map((m) => m.text).slice(-2)).toEqual(["nvm, what's 6 / 3?", "6 ÷ 3 = 2."]);
		expect(await turnFor(t, nvm)).toMatchObject({ status: "done", mergedInto: turnId });
	});

	it("a restart that ends with no message leaves no reply, though its draft was shown", async () => {
		const { t, owner, chatId, turnId } = await picked();
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield { type: "text-delta", text: '{"emoji":null,"new_point":"5 ÷ 10 = 0.5","to":"room","message":"5 ÷' };
			await later();
			yield { type: "text-delta", text: " 10" };
			await say(owner, chatId, "nvm");
			await later();
			yield { type: "text-delta", text: " =" };
			await settled(o);
			yield { type: "text-delta", text: ' 0.5"}' };
		}, { emoji: null, new_point: "", to: "room", message: "5 ÷ 10 = 0.5" });
		scripted(async function* () {
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(quietly) };
			yield finishStep;
		}, quietly);
		await t.action(internal.agent.respond, { turnId });
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", quiet: true, parts: [] });
		expect((await owner.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent")).toEqual([]);
	});

	it("an @mention of another agent reaches it too, and that agent still answers", async () => {
		const { t, owner, chatId, turnId, scribe } = await picked();
		let next: ModelMessage[] | null = null;
		let sent!: Id<"chatMessages">;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			sent = await say(owner, chatId, "@Scribe can you take this instead?", [scribe._id]);
			yield toolResult("c1");
			yield finishStep;
			next = await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(quietly) };
			yield finishStep;
		}, quietly);
		await t.action(internal.agent.respond, { turnId });

		expect(lastContent(next!).text).toContain("can you take this instead?");
		const turns = (await turnsOf(t)).filter((x) => x.triggerId === sent);
		expect(turns.find((x) => x.agentId === scribe._id)).toMatchObject({ status: "running", person: true });
		expect(turns.find((x) => x.agentId !== scribe._id)).toMatchObject({ status: "done", mergedInto: turnId });
	});

	it("a reply it posts shows below the messages it took in", async () => {
		const { t, owner, chatId, turnId } = await picked();
		const posts = { emoji: null, new_point: "offer help", to: "room", message: "Sure, what do you need help with?" };
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			await say(owner, chatId, "with something?");
			yield toolResult("c1");
			yield finishStep;
			await nextStep(o, 1, o.messages);
			await later();
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(posts) };
			yield finishStep;
		}, posts);
		await t.action(internal.agent.respond, { turnId });

		const texts = (await owner.query(api.messages.list, { chatId })).map((m) => m.text);
		expect(texts.slice(-2)).toEqual(["with something?", "Sure, what do you need help with?"]);
	});

	it("missed, it runs as a follow-up told it was a pick; one that covers a direct ask is told it was asked", async () => {
		const { t, owner, chatId, turnId, companybot } = await picked();
		const nvm = await say(owner, chatId, "nvm");
		// The pick ends before taking it in (no step boundary came).
		await finishTurn(t, turnId, "");
		const followUp = await turnFor(t, nvm);
		expect(followUp).toMatchObject({ status: "running", routed: true });
		await finishTurn(t, followUp._id, "");

		// Again, but they also @mention it meanwhile: asked directly.
		const again = await say(owner, chatId, "and 6 / 3?");
		await t.mutation(internal.router.apply, { messageId: again, replies: [{ agentId: companybot._id, probability: 0.9 }], model: "jev", costUsd: 0.0002 });
		const pick = await turnFor(t, again);
		const quiet = await say(owner, chatId, "hm");
		const direct = await say(owner, chatId, "@Companybot answer it", [companybot._id]);
		await finishTurn(t, pick._id, "");
		const next = await turnFor(t, direct);
		expect(next).toMatchObject({ status: "running" });
		expect(next.routed).toBeUndefined();
		expect(await turnFor(t, quiet)).toMatchObject({ status: "done", mergedInto: next._id });
	});

	it("another person's un-mentioned message doesn't reach it: it goes to the router", async () => {
		const { t, member, chatId, turnId } = await picked();
		let heard: unknown;
		let theirs!: Id<"chatMessages">;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield toolCall("c1");
			theirs = await say(member, chatId, "nvm");
			heard = await t.query(internal.turns.isStopping, { turnId });
			yield toolResult("c1");
			yield finishStep;
			await nextStep(o, 1, o.messages);
			yield { type: "start-step" };
			yield { type: "text-delta", text: JSON.stringify(quietly) };
			yield finishStep;
		}, quietly);
		await t.action(internal.agent.respond, { turnId });

		expect(heard).toEqual({ stopped: false, steer: false });
		expect((await turnOf(t, turnId))!.steered).toBeUndefined();
		expect((await turnsOf(t)).filter((x) => x.triggerId === theirs)).toHaveLength(0);
		expect(await routerRuns(t)).toContainEqual({ messageId: theirs });
	});

	it("with nothing running, an un-mentioned message goes to the router as before", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [companybot._id] });
		const sent = await owner.mutation(api.messages.send, { chatId, text: "nvm", mentions: noMentions });
		expect(await turnsOf(t)).toEqual([]);
		expect(await routerRuns(t)).toEqual([{ messageId: sent }]);
	});
});
