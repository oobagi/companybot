import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, turnsOf } from "./helpers";

// No network: the runner's model call is stubbed with a scripted stream that honors the abort signal
// and the stop conditions, as the AI SDK's loop does.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

type Options = { abortSignal: AbortSignal; stopWhen: ((o: { steps: unknown[] }) => boolean | PromiseLike<boolean>)[] };
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
/** After a step that called tools, the SDK's loop asks every stop condition before the next one. */
const stopsAfter = async (o: Options, steps: number) => (await Promise.all(o.stopWhen.map((c) => c({ steps: Array(steps).fill({}) })))).some(Boolean);
const finishStep = { type: "finish-step", usage: { inputTokens: 100, outputTokens: 20 }, providerMetadata: { gateway: { cost: "0.001" } } };

afterEach(() => {
	vi.useRealTimers();
	streamText.mockReset();
});

async function setUp() {
	const { t, owner, member } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const { companybot } = await agentsOf(owner);
	return { t, owner, member, general, companybot };
}
const turnOf = (t: Awaited<ReturnType<typeof setUp>>["t"], id: Id<"agentTurns">) => t.run((ctx) => ctx.db.get(id));
const replyOf = async (t: Awaited<ReturnType<typeof setUp>>["t"], id: Id<"agentTurns">) => t.run(async (ctx) => ctx.db.get((await ctx.db.get(id))!.replyId!));

describe("stopping an agent mid-reply", () => {
	it("mid-text: the stream is aborted, what it wrote stays, marked stopped", async () => {
		const { t, owner, general, companybot } = await setUp();
		const turnId = await agentTurn(t, owner, general, companybot._id);
		vi.useRealTimers();
		let aborted = false;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield { type: "text-delta", text: "Hello" };
			await owner.mutation(api.turns.stop, { turnId });
			// The next flush (every 200ms) hears it.
			await new Promise((r) => setTimeout(r, 250));
			yield { type: "text-delta", text: " there" };
			aborted = o.abortSignal.aborted;
			yield { type: "text-delta", text: " and more" };
		});
		await t.action(internal.agent.respond, { turnId });
		expect(aborted).toBe(true);
		expect(await turnOf(t, turnId)).toMatchObject({ status: "done", stopping: { by: owner.userId } });
		expect(await replyOf(t, turnId)).toMatchObject({ status: "done", text: "Hello there", stoppedBy: owner.userId });
		const listed = (await owner.query(api.messages.list, { chatId: general })).at(-1)!;
		expect(listed).toMatchObject({ status: "done", error: null, stoppedBy: "owner@co.com" });
		// Later turns know it was cut short.
		const next = await agentTurn(t, owner, general, companybot._id);
		expect((await t.mutation(internal.turns.turnContext, { turnId: next })).session.turns.at(-1)!.reply).toBe("Hello there\n[Stopped by the person before you finished]");
	});

	it("mid-tool: the running call finishes and its cost is kept, but no later step or tool runs", async () => {
		const { t, owner, general, companybot } = await setUp();
		const turnId = await agentTurn(t, owner, general, companybot._id);
		vi.useRealTimers();
		let aborted: boolean | undefined;
		scripted(async function* (o) {
			yield { type: "start-step" };
			yield { type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: { query: "Acme" } };
			await owner.mutation(api.turns.stop, { turnId });
			await new Promise((r) => setTimeout(r, 250));
			yield { type: "tool-result", toolCallId: "c1", toolName: "memory_search", input: { query: "Acme" }, output: [] };
			yield finishStep;
			aborted = o.abortSignal.aborted;
			if (await stopsAfter(o, 1)) return;
			yield { type: "start-step" };
			yield { type: "tool-call", toolCallId: "c2", toolName: "memory_search", input: { query: "Beta" } };
			yield { type: "tool-result", toolCallId: "c2", toolName: "memory_search", input: { query: "Beta" }, output: [] };
		});
		await t.action(internal.agent.respond, { turnId });
		expect(aborted).toBe(false);
		const reply = (await replyOf(t, turnId))!;
		expect(reply.parts).toEqual([expect.objectContaining({ type: "tool", id: "c1", status: "done" })]);
		expect(reply).toMatchObject({ status: "done", stoppedBy: owner.userId, stats: { steps: 1, costUsd: 0.001 } });
		expect((await turnOf(t, turnId))!.usage).toMatchObject({ steps: 1, costUsd: 0.001 });
	});

	it("starts the next queued turn in the place", async () => {
		const { t, owner, general, companybot } = await setUp();
		const first = await agentTurn(t, owner, general, companybot._id);
		const second = await agentTurn(t, owner, general, companybot._id);
		expect((await turnOf(t, second))!.status).toBe("queued");
		await owner.mutation(api.turns.stop, { turnId: first });
		// Stopped before it wrote anything: the first flush hears it.
		scripted(async function* () {
			yield { type: "start-step" };
			yield { type: "text-delta", text: "Never shown" };
		});
		await t.action(internal.agent.respond, { turnId: first });
		expect(await replyOf(t, first)).toMatchObject({ text: "", stoppedBy: owner.userId });
		expect(await turnOf(t, first)).toMatchObject({ status: "done" });
		expect(await turnOf(t, second)).toMatchObject({ status: "running" });
	});

	it("only the person it works for, or a role with turns.stopAny, can stop it", async () => {
		const { t, owner, member, general, companybot } = await setUp();
		const owners = await agentTurn(t, owner, general, companybot._id);
		await expect(member.mutation(api.turns.stop, { turnId: owners })).rejects.toThrow("The agent is working for owner@co.com. Only people with the Owner role can stop agents working for someone else.");
		expect((await turnOf(t, owners))!.stopping).toBeUndefined();
		expect((await owner.query(api.typing.list, { chatId: general })).agents[0]).toMatchObject({ turnId: owners, canStop: true, stopping: false });
		expect((await member.query(api.typing.list, { chatId: general })).agents[0]).toMatchObject({ canStop: false });

		const { scribe } = await agentsOf(owner);
		const members = await agentTurn(t, member, general, scribe._id);
		expect((await member.query(api.typing.list, { chatId: general })).agents.find((a) => a.turnId === members)).toMatchObject({ canStop: true });
		await member.mutation(api.turns.stop, { turnId: members });
		expect((await turnOf(t, members))!.stopping).toMatchObject({ by: member.userId });
		// An owner can stop anyone's.
		await owner.mutation(api.turns.stop, { turnId: owners });
		expect((await owner.query(api.typing.list, { chatId: general })).agents.find((a) => a.turnId === owners)).toMatchObject({ stopping: true });
	});

	it("a message saying stop is just a message", async () => {
		const { t, owner, general, companybot } = await setUp();
		const turnId = await agentTurn(t, owner, general, companybot._id);
		const sent = await owner.mutation(api.messages.send, { chatId: general, text: "stop", mentions: noMentions });
		expect((await turnOf(t, turnId))!.stopping).toBeUndefined();
		// It reaches the reply like any message from them (steering), for the model to read.
		const turns = await turnsOf(t);
		expect(turns).toHaveLength(2);
		expect(turns.find((x) => x.triggerId === sent)).toMatchObject({ status: "queued", person: true, actorId: owner.userId });
		expect(await t.query(internal.turns.isStopping, { turnId })).toEqual({ stopped: false, steer: true });
	});
});
