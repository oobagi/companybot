import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";

import { agentsOf, setup as ownerAndMember, noMentions, generalOf, turnsOf, usage } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("agent turns", () => {
	// Keep the scheduled model reply back while the test drives its turn.
	beforeEach(() => void vi.useFakeTimers());
	it.each(["dm", "channel", "thread", "own-thread"] as const)("foreign automation %s runs receive their trigger without earlier private history, replay or summary", async place => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = place === "dm"
			? await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] })
			: await owner.mutation(api.chats.createChannel, { name: "private-history", private: true });
		const parent = place === "thread" ? await owner.mutation(api.messages.send, { chatId, text: "PRIVATE_PARENT", mentions: noMentions }) : undefined;
		await owner.mutation(api.messages.send, { chatId, threadId: parent, text: "PRIVATE_MESSAGE", mentions: { userIds: [], agentIds: [companybot._id] } });
		const first = (await turnsOf(t)).at(-1)!;
		await t.mutation(internal.turns.savePrompt, { turnId: first._id, prompt: "PRIVATE_REPLAY" });
		await t.run(ctx => ctx.db.patch(first.sessionId!, { summary: "PRIVATE_SUMMARY" }));
		await t.mutation(internal.turns.finishReply, { turnId: first._id });
		const config = { name: "Foreign", prompt: "AUTOMATION_TRIGGER", trigger: { type: "schedule" as const, time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await owner.mutation(api.automations.subscribe, { automationId: id, on: true });
		await t.mutation(internal.automationRuns.tick, { now: Date.now() + 2 * 86_400_000 });
		const run = (await turnsOf(t)).find(r => r.actorId === owner.userId && r._id !== first._id)!;
		// Model each destination while preserving a real automation's server-written provenance.
		await t.run(async ctx => {
			await ctx.db.patch(run.triggerId, { chatId, threadId: parent });
			const threadId = place === "own-thread" ? run.triggerId : parent;
			await ctx.db.patch(run.replyId!, { chatId, threadId });
			await ctx.db.patch(run._id, { chatId, threadId, sessionId: first.sessionId });
		});
		const context = await t.query(internal.turns.turnContext, { turnId: run._id });
		expect(context.session).toMatchObject({ summary: null, turns: [] });
		expect(context.messages.map(m => m.text)).toEqual(["AUTOMATION_TRIGGER"]);
		if (place === "own-thread") expect(context.place.thread?.parent.text).toBe("AUTOMATION_TRIGGER");
		else expect(context.place.thread).toBeNull();
		expect(JSON.stringify(context)).not.toContain("PRIVATE_");
		const readInput = place === "thread" ? { threadOf: parent } : place === "dm" ? {} : { chat: "#private-history" };
		const held = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "read", tool: "chat.read", input: JSON.stringify(readInput), risk: "inside" });
		const row = (await t.run(ctx => ctx.db.get(held.approvalId)))!;
		if (place === "own-thread") await owner.mutation(api.messages.send, { chatId, threadId: run.triggerId, text: "RUN_THREAD", mentions: noMentions });
		await owner.mutation(api.approvals.decide, { approvalId: row._id, hash: row.hash, approve: true });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const resumed = (await turnsOf(t)).find(r => r.approvalId === row._id)!;
		const continuation = await t.query(internal.turns.turnContext, { turnId: resumed._id });
		expect(JSON.stringify(continuation)).not.toContain("PRIVATE_");
		expect(continuation.session).toMatchObject({ summary: null, turns: [] });
		if (place === "own-thread") expect(continuation.messages.some(m => m.text === "RUN_THREAD")).toBe(true);
		// Consent unlocks an explicit read, not implicit prompt history.
		expect(await t.mutation(internal.approvals.claim, { approvalId: row._id, turnId: resumed._id })).toEqual({ tool: "chat.read", input: readInput });
		expect(JSON.stringify(await t.query(internal.chatTools.readFor, { turnId: resumed._id, ...readInput }))).toContain("PRIVATE_MESSAGE");
	});

	it("replies to mentions in channels, adding the agent to the channel", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "no mention", mentions: noMentions });
		expect(await turnsOf(t)).toHaveLength(0);
		const trigger = await owner.mutation(api.messages.send, {
			chatId,
			text: "@Companybot hi",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn).toMatchObject({ status: "running", triggerId: trigger, agentId: companybot._id });
		expect((await generalOf(owner)).members.some((m) => m.id === companybot._id)).toBe(true);
		const messages = await owner.query(api.messages.list, { chatId });
		expect(messages.at(-1)).toMatchObject({ _id: turn!.replyId, author: { type: "agent", name: "Companybot" }, status: "streaming" });
	});

	it("answers every message in an agent DM, one at a time", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		let turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["running", "queued"]);

		await t.mutation(internal.turns.finishReply, { turnId: turns[0]!._id, usage: usage(0.01) });
		turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["done", "running"]);
		await t.mutation(internal.turns.finishReply, { turnId: turns[1]!._id, usage: usage(0.02) });
		const stats = (await owner.query(api.messages.list, { chatId })).flatMap((m) => (m.stats ? [m.stats.conversationCostUsd] : []));
		expect(stats).toEqual([0.01, 0.03]);
		expect((await owner.query(api.chats.place, { chatId }))?.costUsd).toBeCloseTo(0.03);
	});

	it("never lets agents trigger agents, and drops mentions of archived agents", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.turns.updateReply, { replyId: turn!.replyId!, text: "@Scribe help", parts: [{ type: "text", text: "@Scribe help" }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect((await turnsOf(t)).map((x) => x.agentId)).toEqual([companybot._id]);

		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		await owner.mutation(api.messages.send, { chatId, text: "@Scribe", mentions: { userIds: [], agentIds: [scribe._id] } });
		expect(await turnsOf(t)).toHaveLength(1);
	});

	it("fails a turn stuck over 5 minutes and moves the queue on", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		const [stuck] = await turnsOf(t);
		await t.run((ctx) => ctx.db.patch(stuck!._id, { startedAt: Date.now() - 6 * 60_000 }));
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["error", "running"]);
		const reply = await t.run((ctx) => ctx.db.get(stuck!.replyId!));
		expect(reply).toMatchObject({ status: "error", error: "Reply timed out." });
	});

	it("replies in the thread it was mentioned in", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan", mentions: noMentions });
		await owner.mutation(api.messages.send, {
			chatId,
			threadId: parent,
			text: "@Companybot thoughts?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn?.threadId).toBe(parent);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.author.type)).toEqual([
			"user",
			"user",
			"agent",
		]);
		const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.place.thread).toMatchObject({ first: true, parent: { text: "Plan" } });
		expect(context.memory).toBe("team");
	});

	it("feeds new messages since the last reply and replays past turns as sent", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "first", mentions: noMentions });
		let [turn] = await turnsOf(t);
		let context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.memory).toBe("personal");
		expect(context.messages.map((m) => m.text)).toEqual(["first"]);
		await t.mutation(internal.turns.savePrompt, { turnId: turn!._id, prompt: "PROMPT 1" });
		await t.mutation(internal.turns.updateReply, {
			replyId: turn!.replyId!,
			text: "answer",
			parts: [
				{ type: "tool", id: "c1", name: "chat_react", status: "done" },
				{ type: "text", text: "answer" },
			],
		});
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });

		await owner.mutation(api.messages.send, { chatId, text: "second", mentions: noMentions });
		turn = (await turnsOf(t))[1];
		context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		// Tools it used replay too, so later it knows it really acted.
		expect(context.session.turns).toEqual([{ prompt: "PROMPT 1", reply: "answer\n[Tools you used: chat_react (done)]" }]);
		expect(context.messages.map((m) => m.text)).toEqual(["second"]);
		expect(context.triggerId).toBe(context.messages[0]!.id);
	});

	it("compacts a session's older turns, keeping a recent tail", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		for (const text of ["a", "b", "c"]) {
			await owner.mutation(api.messages.send, { chatId, text, mentions: noMentions });
			const turn = (await turnsOf(t)).at(-1)!;
			await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: `prompt ${text}`.repeat(10) });
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, usage: usage(0.01) });
		}
		const sessionId = (await turnsOf(t))[0]!.sessionId!;
		const input = await t.mutation(internal.turns.startCompaction, { sessionId, keepTokens: 1 });
		expect(input?.turns).toHaveLength(2);
		expect((await owner.query(api.chats.place, { chatId }))?.compacting).toBe(true);
		expect(await t.mutation(internal.turns.startCompaction, { sessionId })).toBeNull();
		await t.mutation(internal.turns.finishCompaction, { sessionId, result: { summary: "- Said a, b", upTo: input!.upTo, costUsd: 0.005 } });
		const place = await owner.query(api.chats.place, { chatId });
		expect(place).toMatchObject({ summary: "- Said a, b", summarizedUpTo: input!.upTo, compacting: false });
		expect(place?.costUsd).toBeCloseTo(0.035);

		await owner.mutation(api.messages.send, { chatId, text: "d", mentions: noMentions });
		const context = await t.query(internal.turns.turnContext, { turnId: (await turnsOf(t)).at(-1)!._id });
		expect(context.session.summary).toBe("- Said a, b");
		expect(context.session.turns.map((x) => x.prompt.slice(0, 8))).toEqual(["prompt c"]);
	});

	it("lets chat tools see only what the person can, and react to the trigger", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const chatId = (await generalOf(member))._id;
		const trigger = await member.mutation(api.messages.send, {
			chatId,
			text: "@Companybot what's on #board?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(await t.query(internal.chatTools.readFor, { turnId: turn!._id, chat: "#board" })).toEqual({
			error: 'No channel "#board" you can see.',
		});
		const here = await t.query(internal.chatTools.readFor, { turnId: turn!._id });
		expect("messages" in here && here.messages.map((m) => [m.chat, m.author, m.text])).toEqual([
			["#general", "member@co.com", "@Companybot what's on #board?"],
		]);
		expect(await t.mutation(internal.chatTools.reactFor, { turnId: turn!._id, emoji: "👀" })).toEqual({ reacted: true });
		const [m] = (await member.query(api.messages.list, { chatId })).filter((x) => x._id === trigger);
		expect(m!.reactions).toEqual([{ emoji: "👀", count: 1, mine: false, names: ["Companybot"] }]);
		const after = await t.query(internal.chatTools.readFor, { turnId: turn!._id });
		expect("messages" in after && after.messages[0]?.reactions).toEqual([{ emoji: "👀", by: ["Companybot"] }]);
	});
});
