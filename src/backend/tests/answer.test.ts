import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, generalOf, ownerAndMember, turnsOf } from "./helpers";

// Every turn ends with the same answer (core postDecision), asked (an @mention) or not (a dispatcher's
// pick): it posts iff its message isn't blank, reacts iff its emoji is one emoji, and its reply shows,
// streaming, once the message starts. No network: the model's stream is scripted.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

afterEach(() => void vi.useRealTimers());

/** A model that writes `answer` as JSON in `chunks`, calling `after` once each is out; `output` is what the SDK parses. */
function writes(answer: Record<string, unknown>, chunks: string[], after: () => Promise<unknown> = async () => {}, output: Promise<unknown> = Promise.resolve(answer)) {
	expect(chunks.join("")).toBe(JSON.stringify(answer));
	output.catch(() => {});
	streamText.mockReturnValue({
		stream: (async function* () {
			yield { type: "start-step" };
			for (const text of chunks) {
				// Past the runner's flush interval, so each chunk is written.
				await new Promise((r) => setTimeout(r, 250));
				yield { type: "text-delta", text };
				await after();
			}
			yield { type: "finish-step", usage: { inputTokens: 100, outputTokens: 20 }, providerMetadata: { gateway: { cost: "0.001" } } };
		})(),
		output,
	});
}

/** A running turn in #general on "hi": @mentioned, or picked by the dispatcher (nobody asked it). */
async function turn(kind: "asked" | "picked") {
	const { t, owner } = await ownerAndMember();
	const chatId = (await generalOf(owner))._id;
	const { companybot } = await agentsOf(owner);
	let turnId: Id<"agentTurns">;
	if (kind === "asked") turnId = await agentTurn(t, owner, chatId, companybot._id);
	else {
		// Fake timers hold the scheduled run back, as agentTurn does: the test runs it.
		vi.useFakeTimers();
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "hi", mentions: { userIds: [], agentIds: [] } });
		await t.mutation(internal.router.apply, { messageId, replies: [{ agentId: companybot._id, probability: 0.9 }], model: "jev", costUsd: 0 });
		turnId = (await turnsOf(t)).find((x) => x.triggerId === messageId)!._id;
	}
	vi.useRealTimers();
	const replies = async () => (await owner.query(api.messages.list, { chatId })).filter((m) => m.author.type === "agent");
	const reactions = async () => (await owner.query(api.messages.list, { chatId })).find((m) => m.text === "hi")!.reactions.map((r) => r.emoji);
	return { t, owner, chatId, turnId, replies, reactions };
}

describe("every turn's answer", () => {
	it("nobody asked, and it writes and reacts: both", async () => {
		const { t, turnId, replies, reactions } = await turn("picked");
		const answer = { emoji: "🦄", new_point: "Saying hi back", to: "Ada", message: "Hi!" };
		writes(answer, [JSON.stringify(answer)]);
		await t.action(internal.agent.respond, { turnId });
		// The same request as an asked turn: one schema.
		expect(streamText.mock.calls[0]![0].output).toBeDefined();
		expect((await replies()).map((m) => m.text)).toEqual(["Hi!"]);
		expect(await reactions()).toEqual(["🦄"]);
		expect((await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.decision).toEqual(answer);
	});

	it("asked, and it only reacts: the reaction, and no message", async () => {
		const { t, turnId, replies, reactions } = await turn("asked");
		const answer = { emoji: "👍", new_point: "", to: "room", message: "" };
		writes(answer, [JSON.stringify(answer)]);
		await t.action(internal.agent.respond, { turnId });
		expect(await replies()).toEqual([]);
		expect(await reactions()).toEqual(["👍"]);
	});

	it("neither, asked or not: no message, and what it cost is still recorded", async () => {
		for (const kind of ["asked", "picked"] as const) {
			const { t, turnId, replies, reactions } = await turn(kind);
			const answer = { emoji: null, new_point: "", to: "room", message: " " };
			writes(answer, [JSON.stringify(answer)]);
			await t.action(internal.agent.respond, { turnId });
			expect(await replies()).toEqual([]);
			expect(await reactions()).toEqual([]);
			const reply = await t.run(async (ctx) => ctx.db.get((await ctx.db.get(turnId))!.replyId!));
			expect(reply).toMatchObject({ status: "done", quiet: true, stats: { costUsd: 0.001 } });
		}
	});

	it("an answer that isn't valid fails where people see it, asked or not", async () => {
		for (const kind of ["asked", "picked"] as const) {
			const { t, turnId, replies } = await turn(kind);
			writes({ emoji: "no" }, ['{"emoji":"no"}'], async () => {}, Promise.reject(new Error("No object generated")));
			await t.action(internal.agent.respond, { turnId });
			expect((await replies()).map((m) => [m.status, m.error])).toEqual([["error", "It didn't write a reply."]]);
		}
	});

	it("nobody asked: hidden while it decides, then its message streams as it fills in, never the JSON", async () => {
		const { t, owner, turnId, replies } = await turn("picked");
		const answer = { emoji: null, new_point: "Greeting", to: "room", message: "Hello there, friend" };
		const json = JSON.stringify(answer);
		const at = json.indexOf("Hello");
		const seen: string[] = [];
		writes(answer, [json.slice(0, at), json.slice(at, at + 3), json.slice(at + 3, at + 11), json.slice(at + 11)], async () => {
			const [reply] = await replies();
			seen.push(reply ? `${reply.status}: ${(await owner.query(api.messages.stream, { messageId: reply._id }))?.text}` : "hidden");
		});
		await t.action(internal.agent.respond, { turnId });
		expect(seen).toEqual(["hidden", "streaming: Hel", "streaming: Hello there", "streaming: Hello there, friend"]);
		const [reply] = await replies();
		expect(reply).toMatchObject({ status: "done", text: "Hello there, friend", parts: [{ type: "text", text: "Hello there, friend" }] });
	});
});
