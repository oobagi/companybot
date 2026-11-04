import type { convexTest } from "convex-test";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { STEER_RESTARTS } from "../convex/agent";
import { type As, agentTurn, agentsOf, generalOf, ownerAndMember, turnsOf } from "./helpers";

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
/** Scripts one run: `script` yields stream parts; the stub ends the stream on abort, like the SDK. */
function scripted(script: (o: Options) => AsyncGenerator<object>) {
	streamText.mockImplementationOnce((o: Options) => ({
		stream: (async function* (): AsyncGenerator<object> {
			for await (const part of script(o)) {
				if (o.abortSignal.aborted) {
					yield { type: "abort" };
					return;
				}
				yield part;
			}
		})(),
	}));
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
/** Moves the clock past FLUSH_MS, so the runner's next part flushes (and hears what's new). Timers don't fire: the scheduled runs stay put. */
const later = async () => vi.setSystemTime(Date.now() + 1_100);

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
			yield { type: "text-delta", text: "Switching to Y. Done." };
			yield finishStep;
		});
		await t.action(internal.agent.respond, { turnId });

		expect(lastContent(steered!)).toMatchObject({ role: "user", text: expect.stringMatching(/while you were working on this reply[\s\S]*priority[\s\S]*\(asker\)[^\n]*"actually do Y"/) });
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
				yield { type: "text-delta", text: "Okay, stopped." };
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
			yield { type: "text-delta", text: "Roses are" };
			sent = await say(owner, chatId, "make it about cats");
			await later();
			yield { type: "text-delta", text: " red" };
			yield { type: "text-delta", text: ", violets are blue" };
			yield finishStep;
			cutOff = false;
		});
		let restarted: ModelMessage[] = [];
		scripted(async function* (o) {
			restarted = o.messages;
			yield { type: "start-step" };
			yield { type: "text-delta", text: "Switching to cats: cats are soft." };
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

	it(`starts over at most ${STEER_RESTARTS} times; a message after that gets the usual follow-up`, async () => {
		const { t, owner, chatId, turnId } = await dm();
		const sent: Id<"chatMessages">[] = [];
		for (let run = 0; run <= STEER_RESTARTS; run++) {
			scripted(async function* () {
				yield { type: "start-step" };
				yield { type: "text-delta", text: `Answer ${run}` };
				sent.push(await say(owner, chatId, `more ${run}`));
				await later();
				yield { type: "text-delta", text: "." };
				yield finishStep;
			});
		}
		await t.action(internal.agent.respond, { turnId });

		expect(streamText).toHaveBeenCalledTimes(STEER_RESTARTS + 1);
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: `Answer ${STEER_RESTARTS}.` });
		const merged = sent.slice(0, STEER_RESTARTS);
		for (const id of merged) expect(await turnFor(t, id)).toMatchObject({ status: "done", mergedInto: turnId });
		expect((await turnOf(t, turnId))!.steered).toEqual(merged);
		// The last one wasn't taken in: it starts its own turn, whose window has only it.
		const followUp = await turnFor(t, sent.at(-1)!);
		expect(followUp.status).toBe("running");
		expect((await t.query(internal.turns.turnContext, { turnId: followUp._id })).messages.map((m) => m.text)).toEqual([`more ${STEER_RESTARTS}`]);
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
			yield { type: "text-delta", text: "Here's X." };
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
