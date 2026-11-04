import { PRIVATE_RESULT } from "@companybot/core";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, finishTurn, generalOf, ownerAndMember, turnsOf } from "./helpers";

// Later turns replay a turn's tool calls and results as its model had them (core replay.ts), not
// notes in its reply's text, which the model took for its own writing and copied into new replies.

// The real AI SDK loop, with a scripted model in place of the gateway's.
const model = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("ai", async (original) => {
	const ai = await original<typeof import("ai")>();
	return { ...ai, streamText: (o: Parameters<typeof ai.streamText>[0]) => ai.streamText({ ...o, model: model.current as never }) };
});

afterEach(() => {
	vi.useRealTimers();
	model.current = null;
});

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: "tool-calls" | "stop") => ({ type: "finish", finishReason: { unified, raw: undefined }, usage });
/** A model that searches memory, then answers. */
function searchesThenAnswers(answer: string) {
	let step = 0;
	return new MockLanguageModelV4({
		doStream: async () => ({
			stream: convertArrayToReadableStream<unknown>(
				step++ === 0
					? [{ type: "stream-start", warnings: [] }, { type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: JSON.stringify({ query: "logo" }) }, finish("tool-calls")]
					: [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: answer }, { type: "text-end", id: "t" }, finish("stop")],
			) as never,
		}),
	});
}

describe("replaying past turns", () => {
	it("keeps each step's calls and results as the model had them, and replays them with its answer", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const general = (await generalOf(owner))._id;
		const turnId = await agentTurn(t, owner, general, companybot._id);
		vi.useRealTimers();
		const answer = '{"emoji":"👍","new_point":"No logo saved","to":"Owner","message":"Nothing saved about a logo."}';
		model.current = searchesThenAnswers(answer);
		await t.action(internal.agent.respond, { turnId });

		const [step] = await t.run((ctx) => ctx.db.query("turnSteps").collect());
		const kept = JSON.parse(step!.messages) as ModelMessage[];
		expect(kept).toMatchObject([
			{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: { query: "logo" } }] },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "memory_search", output: { type: "json" } }] },
		]);

		const next = await agentTurn(t, owner, general, companybot._id);
		const [replayed] = (await t.mutation(internal.turns.turnContext, { turnId: next })).session.turns;
		expect(JSON.parse(replayed!.steps)).toEqual(kept);
		// Its reaction is in its answer, as it wrote it: nothing added to what it said.
		expect(JSON.parse(replayed!.answer)).toEqual(JSON.parse(answer));
		expect(JSON.stringify(replayed)).not.toMatch(/\[(Tools you used|You reacted|Files you attached)/);
	});

	it("shows someone else's turn with its calls, but not what they got back", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const general = (await generalOf(owner))._id;
		const turnId = await agentTurn(t, owner, general, companybot._id);
		const steps = [
			{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: { query: "salary" } }] },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "memory_search", output: { type: "json", value: { found: ["Owner earns 1M"] } } }] },
		];
		await t.mutation(internal.turns.savePrompt, { turnId, prompt: "what do you know about me?" });
		await t.mutation(internal.turns.keepStep, { turnId, messages: JSON.stringify(steps) });
		await finishTurn(t, turnId, "Done.");

		// The owner's next turn has it all.
		const own = await agentTurn(t, owner, general, companybot._id);
		expect(JSON.parse((await t.mutation(internal.turns.turnContext, { turnId: own })).session.turns[0]!.steps)).toEqual(steps);
		await t.mutation(internal.turns.savePrompt, { turnId: own, prompt: "thanks" });
		await finishTurn(t, own, "Ok.");

		const theirs = await agentTurn(t, member, general, companybot._id);
		const replayed = (await t.mutation(internal.turns.turnContext, { turnId: theirs })).session.turns[0]!;
		expect(replayed.answer).toContain("Done.");
		expect(replayed.steps).not.toContain("1M");
		expect(JSON.parse(replayed.steps)[1].content[0].output).toEqual({ type: "text", value: PRIVATE_RESULT });
		expect((await turnsOf(t)).length).toBe(3);
	});
});
