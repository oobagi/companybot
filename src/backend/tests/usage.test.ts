import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usageMonth } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { STALE_TURN_MS } from "../convex/turns";
import { agentTurn, agentsOf, modules, ownerAndMember, signIn, workspaceOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

const usage = (costUsd: number, model = "openai/gpt-6-luna") => ({
	model,
	steps: 1,
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 20,
	contextTokens: 120,
	costUsd,
	durationMs: 900,
});

/** A running turn of Companybot for `as`, in their DM with it. */
async function turnFor(t: Awaited<ReturnType<typeof ownerAndMember>>["t"], as: Awaited<ReturnType<typeof signIn>>) {
	const { companybot } = await agentsOf(as);
	const dm = await as.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	return { turnId: await agentTurn(t, as, dm, companybot._id), companybot, dm };
}

describe("recording usage", () => {
	it("adds a reply's cost to the month's row for the person it ran for, and counts it once", async () => {
		const { t, owner, member } = await ownerAndMember();
		const mine = await turnFor(t, owner);
		const theirs = await turnFor(t, member);
		await t.mutation(internal.turns.finishReply, { turnId: mine.turnId, usage: usage(0.01) });
		await t.mutation(internal.turns.finishReply, { turnId: theirs.turnId, usage: usage(0.02) });
		// Another reply of the same person, agent and model lands on the same row.
		const again = await turnFor(t, owner);
		await t.mutation(internal.turns.finishReply, { turnId: again.turnId, usage: usage(0.03) });
		// A call that cost nothing writes nothing.
		const free = await turnFor(t, owner);
		await t.mutation(internal.turns.finishReply, { turnId: free.turnId, usage: usage(0) });

		const rows = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(rows.map((r) => [r.userId, r.agentId, r.kind, r.model, r.month, r.costUsd])).toEqual([
			[owner.userId, mine.companybot._id, "chat", "openai/gpt-6-luna", usageMonth(Date.now()), 0.04],
			[member.userId, mine.companybot._id, "chat", "openai/gpt-6-luna", usageMonth(Date.now()), 0.02],
		]);
		const replies = (await t.run((ctx) => ctx.db.query("chatMessages").collect())).filter((m) => m.stats);
		expect(replies.map((m) => !!m.stats?.counted)).toEqual([true, true, true, false]);
	});

	it("counts a summary as the person whose reply triggered it, as its own kind", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { turnId } = await turnFor(t, member);
		await t.mutation(internal.turns.finishReply, { turnId });
		const sessionId = ((await t.run((ctx) => ctx.db.get(turnId))) as Doc<"agentTurns">).sessionId!;
		await t.mutation(internal.turns.finishCompaction, { sessionId, turnId, result: { summary: "- Said a", upTo: 1, costUsd: 0.005, model: "anthropic/claude-haiku-5.5" } });
		const rows = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(rows).toEqual([expect.objectContaining({ userId: member.userId, kind: "summary", model: "anthropic/claude-haiku-5.5", costUsd: 0.005 })]);
		// Totals include it, under its own kind.
		expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 0.005, byKind: [{ kind: "summary", costUsd: 0.005 }] });
	});

	it("refuses a call that finishes after its workspace started going", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId } = await turnFor(t, owner);
		const workspaceId = await workspaceOf(owner);
		await t.run((ctx) => ctx.db.patch(workspaceId, { deleting: true }));
		await t.mutation(internal.turns.finishReply, { turnId, usage: usage(0.01) });
		expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
	});

	it("records web search as its own kind, out of the reply's chat row, and still in the reply's and chat's cost", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId } = await turnFor(t, owner);
		await t.mutation(internal.turns.addSearchCost, { turnId, model: "exa", costUsd: 0.005 });
		await t.mutation(internal.turns.addSearchCost, { turnId, model: "exa", costUsd: 0.005 });
		await t.mutation(internal.turns.finishReply, { turnId, usage: usage(0.02) });
		const rows = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(rows.map((r) => [r.kind, r.model, r.costUsd]).sort()).toEqual([["chat", "openai/gpt-6-luna", 0.02], ["search", "exa", 0.01]]);
		const turn = (await t.run((ctx) => ctx.db.get(turnId))) as Doc<"agentTurns">;
		expect((await replyOf(t, turn)).stats).toMatchObject({ costUsd: 0.02, searchCostUsd: 0.01, conversationCostUsd: 0.03 });
		expect(((await t.run((ctx) => ctx.db.get(turn.chatId))) as Doc<"chats">).costUsd).toBeCloseTo(0.03);
		expect((await owner.query(api.usage.report, {}))!.byKind).toEqual([{ kind: "chat", costUsd: 0.02 }, { kind: "search", costUsd: 0.01 }]);
	});

	it("records each finished model call as it finishes, and the rest at the end, never twice", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId } = await turnFor(t, owner);
		await t.mutation(internal.turns.saveUsage, { turnId, usage: usage(0.01) });
		expect(await chatSpent(t)).toBe(0.01);
		await t.mutation(internal.turns.saveUsage, { turnId, usage: { ...usage(0.03), steps: 2 } });
		// The same total again, or an older one arriving late, adds nothing.
		await t.mutation(internal.turns.saveUsage, { turnId, usage: { ...usage(0.03), steps: 2 } });
		await t.mutation(internal.turns.saveUsage, { turnId, usage: usage(0.01) });
		expect(await chatSpent(t)).toBe(0.03);
		await t.mutation(internal.turns.finishReply, { turnId, usage: { ...usage(0.04), steps: 3 } });
		expect(await chatSpent(t)).toBe(0.04);
		const turn = (await t.run((ctx) => ctx.db.get(turnId))) as Doc<"agentTurns">;
		expect((await replyOf(t, turn)).stats).toMatchObject({ costUsd: 0.04, steps: 3, conversationCostUsd: 0.04, counted: true });
		expect(((await t.run((ctx) => ctx.db.get(turn.chatId))) as Doc<"chats">).costUsd).toBeCloseTo(0.04);
		expect(((await t.run((ctx) => ctx.db.get(turn.sessionId!))) as Doc<"agentSessions">).costUsd).toBeCloseTo(0.04);
	});

	it("keeps what a turn's finished calls cost when its action dies, and gives its reply their stats", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId, dm } = await turnFor(t, owner);
		await t.mutation(internal.turns.saveUsage, { turnId, usage: { ...usage(0.02), steps: 2 } });
		await t.mutation(internal.turns.addSearchCost, { turnId, model: "exa", costUsd: 0.005 });
		// The action is killed: no finishReply. The next message fails the turn as stale.
		vi.setSystemTime(Date.now() + STALE_TURN_MS + 1);
		await owner.mutation(api.messages.send, { chatId: dm, text: "still there?", mentions: { userIds: [], agentIds: [] } });
		const turn = (await t.run((ctx) => ctx.db.get(turnId))) as Doc<"agentTurns">;
		expect(turn.status).toBe("error");
		expect(await replyOf(t, turn)).toMatchObject({ status: "error", error: "Reply timed out.", stats: { costUsd: 0.02, steps: 2, searchCostUsd: 0.005, conversationCostUsd: 0.025 } });
		expect(await chatSpent(t)).toBe(0.02);
		// If the action did finish after all, only what's new is added.
		await t.mutation(internal.turns.finishReply, { turnId, error: "late", usage: { ...usage(0.03), steps: 3 } });
		expect(await chatSpent(t)).toBe(0.03);
		expect((await replyOf(t, turn)).stats).toMatchObject({ costUsd: 0.03, conversationCostUsd: 0.035 });
	});
});

async function replyOf(t: Awaited<ReturnType<typeof ownerAndMember>>["t"], turn: Doc<"agentTurns">) {
	return (await t.run((ctx) => ctx.db.get(turn.replyId!))) as Doc<"chatMessages">;
}

/** This month's chat rows, summed. */
async function chatSpent(t: Awaited<ReturnType<typeof ownerAndMember>>["t"]) {
	const rows = await t.run((ctx) => ctx.db.query("usage").collect());
	return Math.round(rows.filter((r) => r.kind === "chat").reduce((sum, r) => sum + r.costUsd, 0) * 1e6) / 1e6;
}

describe("reading usage", () => {
	async function spent() {
		const { t, owner, member } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const workspaceId = await workspaceOf(owner);
		const month = usageMonth(Date.now());
		const add = (userId: Id<"users">, agentId: Id<"agents">, kind: "chat" | "image", costUsd: number, model?: string, at = month) =>
			t.run((ctx) => ctx.db.insert("usage", { workspaceId, month: at, userId, agentId, kind, model, costUsd }));
		await add(owner.userId, companybot._id, "chat", 0.5, "openai/gpt-6-luna");
		await add(member.userId, companybot._id, "chat", 0.25, "openai/gpt-6-luna");
		await add(member.userId, scribe._id, "chat", 0.125, "anthropic/claude-haiku-5.5");
		await add(member.userId, scribe._id, "image", 0.0625);
		await add(owner.userId, companybot._id, "chat", 9, "openai/gpt-6-luna", "2020-01");
		return { t, owner, member, companybot, scribe, workspaceId };
	}

	it("gives owners the whole workspace by agent, person, kind and model", async () => {
		const { owner, member, companybot, scribe } = await spent();
		const report = await owner.query(api.usage.report, {});
		expect(report).toMatchObject({ scope: "workspace", total: 0.9375, month: usageMonth(Date.now()) });
		expect(report!.byAgent.map((l) => [l.id, l.name, l.costUsd])).toEqual([
			[companybot._id, "Companybot", 0.75],
			[scribe._id, "Scribe", 0.1875],
		]);
		expect(report!.byPerson.map((l) => [l.id, l.costUsd])).toEqual([[owner.userId, 0.5], [member.userId, 0.4375]]);
		expect(report!.byKind).toEqual([{ kind: "chat", costUsd: 0.875 }, { kind: "image", costUsd: 0.0625 }]);
		expect(report!.byModel).toEqual([
			{ model: "openai/gpt-6-luna", name: "GPT-6 Luna", costUsd: 0.75 },
			{ model: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", costUsd: 0.125 },
		]);
		expect(await owner.query(api.usage.report, { month: "2020-01" })).toMatchObject({ total: 9 });
		expect(await owner.query(api.usage.report, { month: "2020-02" })).toMatchObject({ total: 0, byAgent: [] });
		await expect(owner.query(api.usage.report, { month: "last" })).rejects.toThrow("Month must look like");
	});

	it("gives everyone else only their own share", async () => {
		const { member, owner, scribe } = await spent();
		const report = (await member.query(api.usage.report, {}))!;
		expect(report).toMatchObject({ scope: "mine", total: 0.4375, byPerson: [] });
		expect(report.byAgent.map((l) => l.id)).toContain(scribe._id);
		expect(JSON.stringify(report)).not.toContain(owner.userId);
		// A month someone else spent in shows them nothing.
		expect(await member.query(api.usage.report, { month: "2020-01" })).toMatchObject({ total: 0 });
	});

	it("shows nothing to someone outside the workspace", async () => {
		const { t, workspaceId } = await spent();
		const stranger = await signIn(t, "stranger@co.com");
		expect(await stranger.in(workspaceId).query(api.usage.report, {})).toBeNull();
	});

	it("lets an agent read the same numbers, by the acting person's rights", async () => {
		const { t, owner, member } = await spent();
		const run = async (as: typeof owner) => {
			const { turnId } = await turnFor(t, as);
			return t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "usage" } } });
		};
		expect(await run(owner)).toMatchObject({ scope: "workspace", total: 0.9375 });
		expect(await run(member)).toMatchObject({ scope: "mine", total: 0.4375, byPerson: [] });
	});
});

describe("the usage backfill", () => {
	it("adds this month's earlier replies once, for the person each ran for", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const { companybot } = await agentsOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const turnId = await agentTurn(t, owner, dm, companybot._id);
		const turn = (await t.run((ctx) => ctx.db.get(turnId)))! as Doc<"agentTurns">;
		const stats = { ...usage(0.07), conversationCostUsd: 0.07 };
		// A reply from before usage was recorded, and one that was recorded live meanwhile.
		await t.run((ctx) => ctx.db.patch(turn.replyId!, { status: "done", stats }));
		await t.run(async (ctx) => {
			const { _id, _creationTime, ...copy } = turn;
			const reply = (await ctx.db.get(turn.replyId!))! as Doc<"chatMessages">;
			const { _id: _r, _creationTime: _c, ...replyCopy } = reply;
			const replyId = await ctx.db.insert("chatMessages", { ...replyCopy, stats: { ...stats, costUsd: 0.5, counted: true } });
			await ctx.db.insert("agentTurns", { ...copy, replyId });
		});
		for (let i = 0; i < 2; i++) {
			vi.useFakeTimers();
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			vi.useRealTimers();
		}
		const rows = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(rows).toEqual([expect.objectContaining({ userId: owner.userId, agentId: companybot._id, kind: "chat", costUsd: 0.07 })]);
		expect(((await t.run((ctx) => ctx.db.get(turn.replyId!))) as Doc<"chatMessages">).stats?.counted).toBe(true);
	});
});
