import { automationJobs } from "./automationJobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";

import { agentsOf, finishTurn, ownerAndMember, noMentions, generalOf, turnsOf, setMemberSwitch, messagesIn } from "./helpers";

const usage = (costUsd: number) => ({
	model: "anthropic/claude-haiku-5.5",
	steps: 1,
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 20,
	contextTokens: 120,
	costUsd,
	durationMs: 900,
});

afterEach(() => void vi.useRealTimers());

describe("agent turns", () => {
	// Keep the scheduled model reply back while the test drives its turn.
	beforeEach(() => void vi.useFakeTimers());
	it.each(["dm", "channel", "thread", "own-thread"] as const)("foreign automation %s runs receive their trigger without earlier private history, replay or summary", async place => {
		const { t, owner, member } = await ownerAndMember();
		await setMemberSwitch(owner, "automations.edit", true);
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
		const config = { name: "Foreign", prompt: "AUTOMATION_TRIGGER", trigger: { type: "schedule" as const, cron: "0 9 * * *" } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await owner.mutation(api.automations.subscribe, { automationId: id, on: true });
		await t.mutation(internal.automationRuns.tick, { now: (Math.floor(Date.now() / 86_400_000) + 2) * 86_400_000 + 10 * 3_600_000 });
		await automationJobs(t);
		const run = (await turnsOf(t)).find(r => r.actorId === owner.userId && r._id !== first._id)!;
		// Model each destination while preserving a real automation's server-written provenance.
		await t.run(async ctx => {
			await ctx.db.patch(run.triggerId, { chatId, threadId: parent });
			const threadId = place === "own-thread" ? run.triggerId : parent;
			await ctx.db.patch(run.replyId!, { chatId, threadId });
			await ctx.db.patch(run._id, { chatId, threadId, sessionId: first.sessionId });
		});
		const context = await t.mutation(internal.turns.turnContext, { turnId: run._id });
		expect(context.session).toMatchObject({ summary: null, turns: [] });
		expect(context.messages.map(m => m.text)).toEqual(["AUTOMATION_TRIGGER"]);
		if (place === "own-thread") expect(context.place.thread?.parent.text).toBe("AUTOMATION_TRIGGER");
		else expect(context.place.thread).toBeNull();
		expect(JSON.stringify(context)).not.toContain("PRIVATE_");
		const readInput = place === "thread" ? { threadOf: parent } : place === "dm" ? {} : { chat: "#private-history" };
		const held = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "read", tool: "chat.read", input: JSON.stringify(readInput), risk: "inside" });
		const row = (await t.run(ctx => ctx.db.get(held.approvalId)))!;
		if (place === "own-thread") await owner.mutation(api.messages.send, { chatId, threadId: run.triggerId, text: "RUN_THREAD", mentions: noMentions });
		await owner.mutation(api.approvals.decide, { approvalId: row._id, hash: row.hash, approve: true, always: false });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const resumed = (await turnsOf(t)).find(r => r.approvalId === row._id)!;
		const continuation = await t.mutation(internal.turns.turnContext, { turnId: resumed._id });
		expect(JSON.stringify(continuation)).not.toContain("PRIVATE_");
		expect(continuation.session).toMatchObject({ summary: null, turns: [] });
		if (place === "own-thread") expect(continuation.messages.some(m => m.text === "RUN_THREAD")).toBe(true);
		// Consent unlocks an explicit read, not implicit prompt history.
		expect(await t.mutation(internal.approvals.claim, { approvalId: row._id, turnId: resumed._id })).toEqual({ tool: "chat.read", input: readInput });
		expect(JSON.stringify(await t.mutation(internal.chatTools.readFor, { turnId: resumed._id, ...readInput }))).toContain("PRIVATE_MESSAGE");
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
		// Not shown until it writes: the typing line says it's working.
		expect((await messagesIn(owner, { chatId })).at(-1)!._id).toBe(trigger);

		// Streaming writes go to the reply's own stream, not the message the timeline reads; ending moves them over.
		const replyId = turn!.replyId!;
		const parts = [{ type: "text" as const, text: "Hello" }];
		await t.mutation(internal.turns.updateReply, { turnId: turn!._id, text: "Hello", parts });
		expect(await owner.query(api.messages.stream, { messageId: replyId })).toEqual({ text: "Hello", parts, records: [] });
		expect((await messagesIn(owner, { chatId })).at(-1)).toMatchObject({ _id: replyId, author: { type: "agent", name: "Companybot" }, status: "streaming", text: "", parts: [] });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect(await owner.query(api.messages.stream, { messageId: replyId })).toBeNull();
		expect((await messagesIn(owner, { chatId })).at(-1)).toMatchObject({ text: "Hello", parts, status: "done" });
		expect(await t.run((ctx) => ctx.db.query("replyStreams").collect())).toEqual([]);
	});

	it("answers every message in an agent DM, one at a time", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		let turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["running", "queued"]);

		const answer = async (turn: (typeof turns)[number], cost: number) => {
			await t.mutation(internal.turns.updateReply, { turnId: turn._id, text: "ok", parts: [{ type: "text", text: "ok" }] });
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, usage: usage(cost) });
		};
		await answer(turns[0]!, 0.01);
		turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["done", "running"]);
		await answer(turns[1]!, 0.02);
		const stats = (await messagesIn(owner, { chatId })).flatMap((m) => (m.stats ? [m.stats.conversationCostUsd] : []));
		expect(stats).toEqual([0.01, 0.03]);
		expect((await owner.query(api.chats.place, { chatId }))?.costUsd).toBeCloseTo(0.03);
	});

	it("an agent's @mention of another hands it the work in a thread, for the same person; not itself, not archived agents", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await member.mutation(api.messages.send, { chatId, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
		const [turn] = await turnsOf(t);
		const text = "@Companybot noted. @Scribe help";
		await t.mutation(internal.turns.updateReply, { turnId: turn!._id, text, parts: [{ type: "text", text }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		const [, handed] = await turnsOf(t);
		// A new thread under the reply, so the top level stays the people's; as the person who asked.
		expect(handed).toMatchObject({ agentId: scribe._id, chatId, threadId: turn!.replyId, triggerId: turn!.replyId, actorId: member.userId });
		expect(handed!.chain).toMatchObject({ depth: 0, path: [companybot._id, scribe._id] });
		expect(await t.run((ctx) => ctx.db.get(turn!.replyId!))).toMatchObject({ mentions: { agentIds: [scribe._id] } });
		const context = await t.mutation(internal.turns.turnContext, { turnId: handed!._id });
		expect(context.handoff).toEqual({ from: "Companybot", ask: false });

		await owner.mutation(api.trash.move, { kind: "agent", id: scribe._id });
		await owner.mutation(api.messages.send, { chatId, text: "@Scribe", mentions: { userIds: [], agentIds: [scribe._id] } });
		expect(await turnsOf(t)).toHaveLength(2);
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
		await t.mutation(internal.turns.updateReply, { turnId: turn!._id, text: "Ship it", parts: [{ type: "text", text: "Ship it" }] });
		expect((await messagesIn(owner, { chatId, threadId: parent })).map((m) => m.author.type)).toEqual([
			"user",
			"user",
			"agent",
		]);
		const context = await t.mutation(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.place.thread).toMatchObject({ first: true, parent: { text: "Plan" } });
		expect(context.memory).toBe("team");
	});

	it("lets web.fetch open links the person wrote in the thread's parent, never someone else's", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		const mine = await owner.mutation(api.messages.send, { chatId, text: "https://acme.com/report", mentions: noMentions });
		const theirs = await member.mutation(api.messages.send, { chatId, text: "https://member.example/notes", mentions: noMentions });
		const ask = { text: "@Companybot summarize this", mentions: { userIds: [], agentIds: [companybot._id] } };
		await owner.mutation(api.messages.send, { chatId, threadId: mine, ...ask });
		await owner.mutation(api.messages.send, { chatId, threadId: theirs, ...ask });
		const turnIn = async (threadId: typeof mine) => (await turnsOf(t)).find((x) => x.threadId === threadId)!._id;
		const asked = async (threadId: typeof mine) => (await t.mutation(internal.turns.turnContext, { turnId: await turnIn(threadId) })).asked;
		expect(await asked(mine)).toEqual(["@Companybot summarize this", "https://acme.com/report"]);
		// One turn at a time in a chat: the second thread's starts when the first ends.
		await finishTurn(t, await turnIn(mine), "");
		expect(await asked(theirs)).toEqual(["@Companybot summarize this"]);
	});

	it("after an approval, still lets web.fetch open the links in the message that started it", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot read https://acme.com/report then post it", mentions: { userIds: [], agentIds: [companybot._id] } });
		const turn = (await turnsOf(t)).at(-1)!;
		await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: "PROMPT" });
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: turn._id, callId: "c1", tool: "chat.read", input: JSON.stringify({}), risk: "inside" });
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		await member.mutation(api.messages.send, { chatId, text: "https://member.example/notes", mentions: noMentions });
		const row = (await t.run((ctx) => ctx.db.get(approvalId)))!;
		await owner.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: false });
		const resumed = (await turnsOf(t)).find((x) => x.approvalId === approvalId)!;
		const context = await t.mutation(internal.turns.turnContext, { turnId: resumed._id });
		expect(context.messages.map((m) => m.text)).toEqual(["https://member.example/notes"]);
		expect(context.asked).toEqual(["@Companybot read https://acme.com/report then post it"]);
	});

	it("feeds new messages since the last reply and replays past turns as sent", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "first", mentions: noMentions });
		let [turn] = await turnsOf(t);
		let context = await t.mutation(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.memory).toBe("personal");
		expect(context.messages.map((m) => m.text)).toEqual(["first"]);
		await t.mutation(internal.turns.savePrompt, { turnId: turn!._id, prompt: "PROMPT 1" });
		const steps = JSON.stringify([
			{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: { query: "q4" } }] },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "memory_search", output: { type: "json", value: { found: [] } } }] },
		]);
		await t.mutation(internal.turns.keepStep, { turnId: turn!._id, messages: steps });
		await t.mutation(internal.turns.updateReply, {
			turnId: turn!._id,
			text: "answer",
			parts: [
				{ type: "tool", id: "c1", name: "memory_search", status: "done" },
				{ type: "text", text: "answer" },
			],
		});
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });

		await owner.mutation(api.messages.send, { chatId, text: "second", mentions: noMentions });
		turn = (await turnsOf(t))[1];
		context = await t.mutation(internal.turns.turnContext, { turnId: turn!._id });
		// Its tool calls and their results replay as it had them, so later it knows it really acted.
		expect(context.session.turns).toEqual([{ prompt: "PROMPT 1", steps, answer: "answer" }]);
		expect(context.messages.map((m) => m.text)).toEqual(["second"]);
		expect(context.triggerId).toBe(context.messages[0]!.id);
	});

	it("shows a woken agent the reactions it added in earlier turns, and reactions on what's new", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const ask = async (text: string, emoji: string) => {
			const id = await owner.mutation(api.messages.send, { chatId, text, mentions: noMentions });
			const turn = (await turnsOf(t)).at(-1)!;
			await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: text });
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, decision: { emoji, new_point: "", to: "room", message: "" } });
			return id;
		};
		const first = await ask("React with your favorite emoji", "✨");
		const second = await ask("Pick another", "🐙");
		const third = await owner.mutation(api.messages.send, { chatId, text: "And another", mentions: noMentions });
		await owner.mutation(api.messages.react, { messageId: third, emoji: "👀" });
		const context = await t.mutation(internal.turns.turnContext, { turnId: (await turnsOf(t)).at(-1)!._id });
		// Its last pick was on a message before this turn's window: it's shown again, with its reactions.
		expect(context.reacted.map((m) => [m.id, m.reactions])).toEqual([[second, [{ emoji: "🐙", by: ["Companybot"] }]]]);
		expect(context.reacted.some((m) => m.id === first)).toBe(false);
		const [now] = context.messages;
		expect(now).toMatchObject({ id: third, reactions: [{ emoji: "👀", by: [expect.any(String)] }] });
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
		const context = await t.mutation(internal.turns.turnContext, { turnId: (await turnsOf(t)).at(-1)!._id });
		expect(context.session.summary).toBe("- Said a, b");
		expect(context.session.turns.map((x) => x.prompt.slice(0, 8))).toEqual(["prompt c"]);
	});

	it("lets chat tools see only what the person can, and read the reaction its answer added", async () => {
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
		expect(await t.mutation(internal.chatTools.readFor, { turnId: turn!._id, chat: "#board" })).toEqual({
			error: 'No channel "#board" you can see.',
		});
		const here = await t.mutation(internal.chatTools.readFor, { turnId: turn!._id });
		expect("messages" in here && here.messages.map((m) => [m.chat, m.author, m.text])).toEqual([
			["#general", "member@co.com", "@Companybot what's on #board?"],
		]);
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id, decision: { emoji: "👀", new_point: "On #board", to: "room", message: "I can't see #board." } });
		const [m] = (await messagesIn(member, { chatId })).filter((x) => x._id === trigger);
		expect(m!.reactions).toMatchObject([{ emoji: "👀", count: 1, mine: false, people: [{ type: "agent", name: "Companybot" }] }]);
		await member.mutation(api.messages.send, { chatId, text: "@Companybot and now?", mentions: { userIds: [], agentIds: [companybot._id] } });
		const after = await t.mutation(internal.chatTools.readFor, { turnId: (await turnsOf(t)).at(-1)!._id });
		expect("messages" in after && after.messages[0]?.reactions).toEqual([{ emoji: "👀", by: ["Companybot"] }]);
	});
});
