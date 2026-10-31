import { CHAIN_MAX_HOPS } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scribe } from "../../core/test/fixtures";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { dmKeyOf } from "../convex/chatOps";
import { enqueueTurn } from "../convex/turns";
import { wake } from "../convex/wakeups";
import { agentsOf, generalOf, noMentions, ownerAndMember, turnsOf } from "./helpers";

// Agents handing work to each other (chains.ts). No network: the dispatcher's decide (Jev) is stubbed,
// and fake timers hold every reply back, so each test writes the agents' replies itself.
const decideWith = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), experimental_decide: decideWith }));

beforeEach(() => {
	vi.useFakeTimers();
	decideWith.mockReset();
});
afterEach(() => void vi.useRealTimers());

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];

/** #general with Companybot, Scribe and Scout; the member asks Companybot something. */
async function setUp() {
	const { t, owner, member } = await ownerAndMember();
	const { companybot, scribe: scribeAgent } = await agentsOf(owner);
	const chatId = (await generalOf(owner))._id;
	const scout = await t.run(async (ctx) => {
		const workspaceId = (await ctx.db.get(chatId))!.workspaceId;
		return ctx.db.insert("agents", { ...scribe, name: "Scout", description: "Finds leads.", workspaceId, archived: false, version: 1, updatedBy: owner.userId, updatedAt: Date.now() });
	});
	await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [companybot._id, scribeAgent._id, scout] });
	const ask = (text: string, agentId: Id<"agents">, threadId?: Id<"chatMessages">) => member.mutation(api.messages.send, { chatId, threadId, text, mentions: { userIds: [], agentIds: [agentId] } });
	return { t, owner, member, chatId, companybot: companybot._id, scribe: scribeAgent._id, scout, ask };
}

/** The agent's running turn (fake timers keep it from running). */
async function running(t: T, agentId: Id<"agents">) {
	const turns = (await turnsOf(t)).filter((x) => x.agentId === agentId && x.status === "running");
	expect(turns, "one running turn").toHaveLength(1);
	return turns[0]!;
}

/** The agent's running turn writes `text` and ends. */
async function say(t: T, agentId: Id<"agents">, text: string) {
	const turn = await running(t, agentId);
	await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text, parts: [{ type: "text", text }] });
	await t.mutation(internal.turns.finishReply, { turnId: turn._id });
	return turn;
}

const pauses = (t: T) => t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).filter((m) => m.pause));

describe("handoffs by @mention", () => {
	it("ping-pong stops at the limit with the paused line, and Continue resumes for the person only", async () => {
		const { t, owner, member, chatId, companybot, scribe, ask } = await setUp();
		await ask("@Companybot get Scribe to draft it", companybot);
		const first = await say(t, companybot, "@Scribe draft the intro");
		const thread = first.replyId!;
		for (let i = 0; i < 2; i++) {
			await say(t, scribe, "@Companybot draft's ready");
			await say(t, companybot, "@Scribe one more pass");
		}
		// Two back-and-forths: the fifth handoff between them is held, with a line in the thread.
		expect((await turnsOf(t)).filter((x) => x.status !== "done")).toEqual([]);
		const [line] = await pauses(t);
		expect(line).toMatchObject({ chatId, threadId: thread, authorAgentId: companybot, text: "Agents paused: Companybot and Scribe went back and forth 2 times.", mentions: { userIds: [member.userId] } });
		const shown = (await member.query(api.messages.list, { chatId, threadId: thread })).find((m) => m._id === line!._id)!;
		expect(shown.pause).toEqual({ status: "paused", for: "member@co.com", by: null, canDecide: true });
		expect((await owner.query(api.messages.list, { chatId, threadId: thread })).find((m) => m._id === line!._id)!.pause!.canDecide).toBe(false);

		await expect(owner.mutation(api.chains.decide, { messageId: line!._id, action: "continue" })).rejects.toThrow("Only");
		await member.mutation(api.chains.decide, { messageId: line!._id, action: "continue" });
		const resumed = await running(t, scribe);
		expect(resumed).toMatchObject({ threadId: thread, actorId: member.userId });
		expect((await t.run((ctx) => ctx.db.get(line!._id)))!.pause).toMatchObject({ status: "continued", by: member.userId });
		await expect(member.mutation(api.chains.decide, { messageId: line!._id, action: "stop" })).rejects.toThrow("already decided");
	});

	it("Stop ends it: what was held never runs", async () => {
		const { t, member, companybot, scribe, ask } = await setUp();
		await ask("@Companybot go", companybot);
		await say(t, companybot, "@Scribe go");
		for (let i = 0; i < 2; i++) {
			await say(t, scribe, "@Companybot back");
			await say(t, companybot, "@Scribe again");
		}
		const [line] = await pauses(t);
		await member.mutation(api.chains.decide, { messageId: line!._id, action: "stop" });
		expect((await turnsOf(t)).filter((x) => x.status !== "done")).toEqual([]);
		const chain = await t.run(async (ctx) => (await ctx.db.query("agentChains").collect())[0]!);
		expect(chain).toMatchObject({ status: "stopped" });
	});

	it("a person writing in the thread gives the chain a fresh budget", async () => {
		const { t, member, chatId, companybot, scribe, ask } = await setUp();
		await ask("@Companybot go", companybot);
		const first = await say(t, companybot, "@Scribe go");
		await say(t, scribe, "@Companybot back");
		await say(t, companybot, "@Scribe again");
		// The member chimes in mid-chain: no new turn (no mention), but the counts start over.
		await member.mutation(api.messages.send, { chatId, threadId: first.replyId!, text: "keep going, you two", mentions: noMentions });
		const chain = await t.run(async (ctx) => (await ctx.db.query("agentChains").collect())[0]!);
		expect(chain).toMatchObject({ turns: 0, pairs: [], epoch: 1 });
		for (let i = 0; i < 2; i++) {
			await say(t, scribe, "@Companybot back");
			await say(t, companybot, "@Scribe again");
		}
		// Past where it would have paused without the reset.
		expect(await pauses(t)).toEqual([]);
		await running(t, scribe);
	});

	it("a ring (A → B → C → A) pauses", async () => {
		const { t, companybot, scribe, scout, ask } = await setUp();
		await ask("@Companybot go", companybot);
		await say(t, companybot, "@Scribe write it up");
		await say(t, scribe, "@Scout find the leads");
		await say(t, scout, "@Companybot here they are");
		const [line] = await pauses(t);
		expect(line!.text).toContain("came back around");
		expect((await turnsOf(t)).filter((x) => x.status !== "done")).toEqual([]);
	});

	it("wakeups and automations never start chains", async () => {
		const { t, member, chatId, companybot, scribe } = await setUp();
		// A follow-up's wake turn.
		await t.run(async (ctx) => {
			const chat = (await ctx.db.get(chatId))!;
			const id = await ctx.db.insert("wakeups", { workspaceId: chat.workspaceId, agentId: companybot, chatId, actorId: member.userId, createdBy: member.userId, note: "Chase it", foreign: false, status: "pending", jobId: "j" });
			await wake(ctx, id);
		});
		await say(t, companybot, "@Scribe chase Acme");
		// An automation's run, posted as the member.
		await t.run(async (ctx) => {
			const chat = (await ctx.db.get(chatId))!;
			const triggerId = await ctx.db.insert("chatMessages", {
				chatId, workspaceId: chat.workspaceId, authorUserId: member.userId, text: "Daily brief", parts: [], mentions: { userIds: [], agentIds: [companybot] }, status: "done",
				automation: { id: "brief", name: "Brief", foreign: false },
			});
			await enqueueTurn(ctx, chat, { agentId: companybot, chatId, triggerId, actorId: member.userId });
		});
		await say(t, companybot, "@Scribe add it to the brief");
		expect((await turnsOf(t)).filter((x) => x.agentId === scribe)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("agentChains").collect())).toEqual([]);
	});
});

describe("the dispatcher after an agent's message", () => {
	/** Jev's answer to "who goes next" (a1 is the first other agent in the channel) and "only an acknowledgement?". */
	const next = (choice: string, p = 0.9, ack = 0.1) =>
		decideWith.mockResolvedValue({ answers: { next: { type: "choice", choice, probabilities: { [choice]: p } }, ack: { type: "boolean", probability: ack } }, providerMetadata: { gateway: { cost: "0.0001" } } });

	async function inChain() {
		const s = await setUp();
		await s.owner.mutation(api.chats.updateChannel, { chatId: s.chatId, replyMode: "relevant" });
		await s.ask("@Companybot get Scribe on it", s.companybot);
		const first = await say(s.t, s.companybot, "@Scribe draft the intro");
		const done = await say(s.t, s.scribe, "Here's the intro: …");
		const nextOf = () => s.t.action(internal.router.next, { turnId: done._id });
		return { ...s, first, done, nextOf };
	}

	it("wakes the agent it picks, sure enough, as a hop; records the call for the person", async () => {
		const { t, member, companybot, first, nextOf } = await inChain();
		next("a1");
		await nextOf();
		const call = decideWith.mock.calls[0]![0];
		expect(call.state).toContain("Newest message, by Scribe (agent)");
		expect(call.state).toContain("a1: Companybot");
		expect(Object.keys(call.questions)).toEqual(["next", "ack"]);
		expect(await running(t, companybot)).toMatchObject({ threadId: first.replyId, routed: true, actorId: member.userId });
		const chain = await t.run(async (ctx) => (await ctx.db.query("agentChains").collect())[0]!);
		expect(chain.hops).toBe(1);
		expect((await t.run((ctx) => ctx.db.query("usage").collect())).filter((u) => u.kind === "router")).toEqual([expect.objectContaining({ userId: member.userId, costUsd: 0.0001 })]);
	});

	it("wakes nobody for the person, done, an acknowledgement, or a guess under 0.6", async () => {
		const { t, nextOf } = await inChain();
		const before = (await turnsOf(t)).length;
		for (const [choice, p, ack] of [["person", 0.9, 0], ["done", 0.9, 0], ["a1", 0.9, 0.8], ["a1", 0.5, 0]] as const) {
			next(choice, p, ack);
			await nextOf();
		}
		expect(await turnsOf(t)).toHaveLength(before);
	});

	it(`pauses past ${CHAIN_MAX_HOPS} hops nobody asked for`, async () => {
		const { t, nextOf } = await inChain();
		await t.run(async (ctx) => {
			const chain = (await ctx.db.query("agentChains").collect())[0]!;
			await ctx.db.patch(chain._id, { hops: CHAIN_MAX_HOPS });
		});
		next("a1");
		await nextOf();
		expect((await pauses(t))[0]!.text).toBe(`Agents paused after ${CHAIN_MAX_HOPS} handoffs nobody asked for.`);
	});

	it("isn't asked in Mentions only channels", async () => {
		const { t, owner, chatId, companybot, scribe, ask } = await setUp();
		await owner.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" });
		await ask("@Companybot go", companybot);
		await say(t, companybot, "@Scribe go");
		await say(t, scribe, "Done.");
		const scheduled = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.startsWith("router")));
		expect(scheduled).toEqual([]);
	});
});

describe("asking privately (chat.ask_agent)", () => {
	it("asks in a thread of the person's group DM, only they see it, and the answer finishes the asker's reply", async () => {
		const { t, owner, member, chatId, companybot, scribe, ask } = await setUp();
		await ask("@Companybot what's our refund policy?", companybot);
		const asking = await running(t, companybot);
		const result = await t.mutation(internal.chains.askFor, { turnId: asking._id, agent: "Scribe", message: "What's our refund policy?" });
		if ("error" in result) throw new Error(result.error);
		const dm = (await t.run((ctx) => ctx.db.get(result.thread.chatId as Id<"chats">)))!;
		expect(dm.dmKey).toBe(dmKeyOf([member.userId], [companybot, scribe]));
		// Nobody but the member sees it.
		expect((await member.query(api.messages.list, { chatId: dm._id })).map((m) => m.text)).toEqual(["@Scribe What's our refund policy?"]);
		expect(await owner.query(api.messages.list, { chatId: dm._id })).toEqual([]);
		expect((await owner.query(api.chats.list))!.dms.some((d) => d._id === dm._id)).toBe(false);

		const answering = await running(t, scribe);
		expect(answering).toMatchObject({ chatId: dm._id, threadId: result.thread.messageId, actorId: member.userId, chain: { depth: 1 } });
		expect((await t.query(internal.turns.turnContext, { turnId: answering._id })).handoff).toEqual({ from: "Companybot", ask: true });
		// Its answer, even with an @mention, wakes nobody else; it goes back to the asker.
		await say(t, scribe, "30 days, @Companybot.");
		await say(t, companybot, "I asked Scribe; back in a moment.");
		const answer = await running(t, companybot);
		expect(answer).toMatchObject({ chatId, wakeupId: expect.any(String) });
		expect(answer.threadId).toBeUndefined();
		const context = await t.query(internal.turns.turnContext, { turnId: answer._id });
		expect(context.wake).toMatchObject({ answer: { from: "Scribe" }, result: JSON.stringify("30 days, @Companybot.") });
		// Not quiet: this reply finishes the one they were waiting for.
		expect((await t.run((ctx) => ctx.db.get(answer.replyId! as Id<"chatMessages">)))!.quiet).toBeUndefined();
		await say(t, companybot, "Refunds are within 30 days. @Scribe thanks");
		expect((await turnsOf(t)).filter((x) => x.status !== "done")).toEqual([]);
	});

	it("an asked agent can ask another, up to 3 deep", async () => {
		const { t, companybot, scribe, scout, ask } = await setUp();
		await ask("@Companybot plan the week", companybot);
		const first = await running(t, companybot);
		await t.mutation(internal.chains.askFor, { turnId: first._id, agent: "Scribe", message: "What's due?" });
		const second = await running(t, scribe);
		const asked = await t.mutation(internal.chains.askFor, { turnId: second._id, agent: "Scout", message: "Any new leads?" });
		expect(asked).toMatchObject({ asked: "Scout" });
		expect(await running(t, scout)).toMatchObject({ chain: { depth: 2 } });
		await t.run(async (ctx) => {
			const turn = (await ctx.db.query("agentTurns").collect()).find((x) => x.agentId === scout)!;
			await ctx.db.patch(turn._id, { chain: { ...turn.chain!, depth: 3 } });
		});
		const deepest = await running(t, scout);
		expect(await t.mutation(internal.chains.askFor, { turnId: deepest._id, agent: "Companybot", message: "?" })).toEqual({
			error: "Not asked: asks can only go 3 deep. Answer with what you have, or ask the person.",
		});
	});

	it("refuses in a wake turn, for itself, and an unknown agent", async () => {
		const { t, member, chatId, companybot, ask } = await setUp();
		await ask("@Companybot hi", companybot);
		const turn = await running(t, companybot);
		expect(await t.mutation(internal.chains.askFor, { turnId: turn._id, agent: "Companybot", message: "x" })).toEqual({ error: "That's you." });
		expect(await t.mutation(internal.chains.askFor, { turnId: turn._id, agent: "Nobody", message: "x" })).toMatchObject({ error: expect.stringContaining('No agent named "Nobody"') });
		await say(t, companybot, "Hi!");
		await t.run(async (ctx) => {
			const chat = (await ctx.db.get(chatId))!;
			const id = await ctx.db.insert("wakeups", { workspaceId: chat.workspaceId, agentId: companybot, chatId, actorId: member.userId, createdBy: member.userId, note: "Check", foreign: false, status: "pending", jobId: "j" });
			await wake(ctx, id);
		});
		const woke = await running(t, companybot);
		expect(await t.mutation(internal.chains.askFor, { turnId: woke._id, agent: "Scribe", message: "x" })).toMatchObject({ error: expect.stringContaining("Nobody asked you") });
	});
});
