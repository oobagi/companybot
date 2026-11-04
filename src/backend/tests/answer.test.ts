import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, generalOf, ownerAndMember } from "./helpers";

// An asked turn (an @mention) ends with the same decision as an unasked one (core postDecision): its
// message always posts, streamed as the JSON fills in, and it may react too. No network: the model's
// stream is scripted.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

afterEach(() => void vi.useRealTimers());

/** A model that writes `decision` as JSON in `chunks`, calling `after` once each is out. */
function writes(decision: Record<string, unknown>, chunks: string[], after: () => Promise<unknown> = async () => {}) {
	expect(chunks.join("")).toBe(JSON.stringify(decision));
	streamText.mockReturnValue({
		stream: (async function* () {
			yield { type: "start-step" };
			for (const text of chunks) {
				// Past the runner's flush interval, so each chunk is written.
				await new Promise((r) => setTimeout(r, 250));
				yield { type: "text-delta", text };
				await after();
			}
		})(),
		output: Promise.resolve(decision),
	});
}

async function mentioned() {
	const { t, owner } = await ownerAndMember();
	const chatId = (await generalOf(owner))._id;
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, chatId, companybot._id);
	vi.useRealTimers();
	return { t, owner, chatId, turnId };
}

describe("an asked turn's answer", () => {
	it("posts its message and adds its reaction to the message it answers: both", async () => {
		const { t, owner, chatId, turnId } = await mentioned();
		const decision = { new_point: "Saying hi back", respond: "post", emoji: "👋", to: "owner@co.com", message: "Hi! What can I do?" };
		writes(decision, [JSON.stringify(decision)]);
		await t.action(internal.agent.respond, { turnId });
		// The same decision schema as an unasked turn, so the request is the same shape.
		expect(streamText.mock.calls[0]![0].output).toBeDefined();
		const messages = await owner.query(api.messages.list, { chatId });
		expect(messages.filter((m) => m.author.type === "agent").map((m) => m.text)).toEqual(["Hi! What can I do?"]);
		expect(messages.find((m) => m.text === "hi")!.reactions).toMatchObject([{ emoji: "👋", count: 1, mine: false, people: [{ type: "agent", name: "Companybot" }] }]);
		expect((await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.decision).toEqual(decision);
	});

	it("streams its message as the decision's JSON fills in, never the JSON itself", async () => {
		const { t, owner, chatId, turnId } = await mentioned();
		const decision = { new_point: "Greeting", respond: "post", emoji: null, to: "room", message: "Hello there, friend" };
		const seen: string[] = [];
		const json = JSON.stringify(decision);
		const at = json.indexOf("Hello");
		writes(decision, [json.slice(0, at + 3), json.slice(at + 3, at + 11), json.slice(at + 11)], async () => {
			const stream = await t.run((ctx) => ctx.db.query("replyStreams").first());
			if (stream) seen.push(stream.text);
		});
		await t.action(internal.agent.respond, { turnId });
		expect(seen).toEqual(["Hel", "Hello there", "Hello there, friend"]);
		const reply = (await owner.query(api.messages.list, { chatId })).find((m) => m.author.type === "agent")!;
		expect(reply.text).toBe("Hello there, friend");
		expect(reply.parts).toEqual([{ type: "text", text: "Hello there, friend" }]);
	});

	it("answers with its reaction alone when it wrote no message, and fails when it did nothing", async () => {
		const reacted = await mentioned();
		const decision = { new_point: "", respond: "react", emoji: "👍", to: "room", message: "" };
		writes(decision, [JSON.stringify(decision)]);
		await reacted.t.action(internal.agent.respond, { turnId: reacted.turnId });
		const seen = await reacted.owner.query(api.messages.list, { chatId: reacted.chatId });
		expect(seen.filter((m) => m.author.type === "agent")).toEqual([]);
		expect(seen.find((m) => m.text === "hi")!.reactions.map((r) => r.emoji)).toEqual(["👍"]);

		const blank = await mentioned();
		const none = { new_point: "", respond: "post", emoji: null, to: "room", message: "" };
		writes(none, [JSON.stringify(none)]);
		await blank.t.action(internal.agent.respond, { turnId: blank.turnId });
		const replies = (await blank.owner.query(api.messages.list, { chatId: blank.chatId })).filter((m) => m.author.type === "agent");
		expect(replies.map((m) => [m.text, m.status])).toEqual([["", "error"]]);
	});
});
