import type { convexTest } from "convex-test";
import { QUIET_WINDOW_MS } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentsOf, generalOf, ownerAndMember, turnsOf } from "./helpers";

// A person's messages to an agent wait a quiet window, and a burst gets one reply (wiki/chat.md,
// "One turn per agent per place"). The tests play the scheduler: model replies are held back.
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

type T = ReturnType<typeof convexTest>;

/** Fires every pending quiet-window timer (turns.startQueued), oldest first, as the scheduler would after QUIET_WINDOW_MS. */
async function quietWindowsEnd(t: T) {
	const jobs = await t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.state.kind === "pending" && j.name.startsWith("turns") && j.name.endsWith("startQueued")),
	);
	for (const job of jobs) {
		expect(job.scheduledTime - job._creationTime).toBeGreaterThanOrEqual(QUIET_WINDOW_MS - 1);
		await t.run((ctx) => ctx.scheduler.cancel(job._id));
		await t.mutation(internal.turns.startQueued, job.args[0] as { turnId: Id<"agentTurns"> });
	}
}

const say = (as: As, chatId: Id<"chats">, text: string, agentIds: Id<"agents">[] = []) =>
	as.mutation(api.messages.send, { chatId, text, mentions: { userIds: [], agentIds } });

const textOf = (t: T, id: Id<"chatMessages">) => t.run(async (ctx) => (await ctx.db.get(id))!.text);
const running = async (t: T) => (await turnsOf(t)).filter((x) => x.status === "running");
const contextTexts = async (t: T, turnId: Id<"agentTurns">) =>
	(await t.query(internal.turns.turnContext, { turnId })).messages.map((m) => m.text);

describe("bursts", () => {
	it("gives three quick messages in an agent DM one reply, on the newest, seeing all three", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const me = owner.debounced();
		await say(me, chatId, "A");
		await say(me, chatId, "B");
		const c = await say(me, chatId, "C");

		// In the quiet window: nothing runs, no reply bubble yet.
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["queued", "queued", "queued"]);
		await quietWindowsEnd(t);

		const turns = await turnsOf(t);
		const [started] = await running(t);
		expect(started).toMatchObject({ triggerId: c, actorId: owner.userId });
		const merged = turns.filter((x) => x._id !== started!._id);
		expect(merged.map((x) => [x.status, x.mergedInto, x.replyId])).toEqual([
			["done", started!._id, undefined],
			["done", started!._id, undefined],
		]);
		// Each message once: the trigger isn't pushed in again.
		expect(await contextTexts(t, started!._id)).toEqual(["A", "B", "C"]);
		const replies = await t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).filter((m) => m.chatId === chatId && m.authorAgentId));
		expect(replies).toHaveLength(1);
	});

	it("gives a burst sent while a reply runs one follow-up, which answers nothing twice", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const me = owner.debounced();
		await say(me, chatId, "first");
		await quietWindowsEnd(t);
		const [first] = await running(t);
		expect(await contextTexts(t, first!._id)).toEqual(["first"]);
		// What the runner saves before its model call: the next turn's window starts after this one.
		await t.mutation(internal.turns.savePrompt, { turnId: first!._id, prompt: "first" });

		await say(me, chatId, "B");
		await say(me, chatId, "C");
		// The reply ends while C is still in its quiet window: nothing starts until it's over.
		await t.mutation(internal.turns.finishReply, { turnId: first!._id });
		expect(await running(t)).toHaveLength(0);
		await say(me, chatId, "D");
		await quietWindowsEnd(t);

		const [next] = await running(t);
		expect((await textOf(t, next!.triggerId!))).toBe("D");
		expect((await turnsOf(t)).filter((x) => x.mergedInto === next!._id)).toHaveLength(2);
		// "first" was answered (it's before the window); B, C and D are each in it once.
		expect(await contextTexts(t, next!._id)).toEqual(["B", "C", "D"]);
		await t.mutation(internal.turns.finishReply, { turnId: next!._id });
		expect((await turnsOf(t)).filter((x) => x.status === "queued" || x.status === "running")).toHaveLength(0);
	});

	it("folds a burst queued behind a running reply into one follow-up when that reply ends", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const me = owner.debounced();
		await say(me, chatId, "first");
		await quietWindowsEnd(t);
		const [first] = await running(t);
		await say(me, chatId, "B");
		await say(me, chatId, "C");
		// Their windows end while the first reply still runs: they wait in the queue.
		await quietWindowsEnd(t);
		expect((await turnsOf(t)).filter((x) => x.status === "queued")).toHaveLength(2);

		await t.mutation(internal.turns.finishReply, { turnId: first!._id });
		const [next] = await running(t);
		expect((await textOf(t, next!.triggerId!))).toBe("C");
		expect((await turnsOf(t)).filter((x) => x.mergedInto === next!._id)).toHaveLength(1);
	});

	it("keeps another person's message its own turn, acting as them", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await say(owner.debounced(), chatId, "@Companybot one", [companybot._id]);
		await say(member.debounced(), chatId, "@Companybot two", [companybot._id]);
		await say(owner.debounced(), chatId, "@Companybot three", [companybot._id]);
		await quietWindowsEnd(t);

		// The owner's two fold into one; the member's waits for its own turn.
		const [first] = await running(t);
		expect(first).toMatchObject({ actorId: owner.userId });
		expect((await turnsOf(t)).filter((x) => x.mergedInto)).toHaveLength(1);
		await t.mutation(internal.turns.finishReply, { turnId: first!._id });
		const [second] = await running(t);
		expect(second).toMatchObject({ actorId: member.userId });
		expect((await turnsOf(t)).filter((x) => x.mergedInto)).toHaveLength(1);
	});
});
