import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

import { agentTurn, agentsOf, generalOf, modules, signIn } from "./helpers";
import { seedAutomation } from "./legacyFixtures";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("migrations", () => {
	it("writes schedules from before cron as cron, starting after their last run", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const { companybot } = await agentsOf(owner);
		const id = await owner.mutation(api.automations.create, {
			config: { name: "Daily", prompt: "p", trigger: { type: "schedule", cron: "0 9 * * *" } },
			agentId: companybot._id,
			audience: "creator",
			timeZone: "UTC",
		});
		await seedAutomation(t, owner, "morning-brief");
		await t.run(async (ctx) => {
			for (const install of await ctx.db.query("automationInstalls").collect()) {
				const custom = install.custom && { ...install.custom, trigger: { type: "schedule" as const, time: "09:30", weekdays: [1, 3] } };
				await ctx.db.patch(install._id, { custom, lastScheduledAt: undefined, lastRunDate: "2026-10-21", lastRunAt: 1_000 });
			}
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const installs = await t.run((ctx) => ctx.db.query("automationInstalls").collect());
		const made = installs.find((i) => i.automationId === id)!;
		const brief = installs.find((i) => i.automationId === "morning-brief")!;
		expect(made).toMatchObject({ custom: { trigger: { type: "schedule", cron: "30 9 * * 1,3" }, version: 1 }, lastScheduledAt: 1_000 });
		expect(brief).toMatchObject({ definition: { trigger: { type: "schedule", cron: "0 8 * * 1-5" } }, lastScheduledAt: 1_000 });
		expect([made.lastRunDate, brief.lastRunDate]).toEqual([undefined, undefined]);
	});

	it("clears the retired welcome from old turns", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, (await agentsOf(owner)).companybot._id);
		await t.run((ctx) => ctx.db.patch(turnId, { welcome: "new_workspace" }));
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		expect(await t.run(async (ctx) => (await ctx.db.query("agentTurns").collect()).filter((turn) => turn.welcome).length)).toBe(0);
	});

	it("moves agents on the old default model to the new one, and leaves models picked on purpose", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const [onDefault, picked] = await t.run(async (ctx) => {
			const agent = (await ctx.db.query("agents").first())!;
			await ctx.db.patch(agent._id, { model: "anthropic/claude-sonnet-5.5" });
			const { _id, _creationTime, ...copy } = agent;
			return [agent._id, await ctx.db.insert("agents", { ...copy, model: "anthropic/claude-opus-5.5" })];
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		expect(await t.run(async (ctx) => [(await ctx.db.get(onDefault))!.model, (await ctx.db.get(picked))!.model])).toEqual(["openai/gpt-6-luna", "anthropic/claude-opus-5.5"]);
	});

	it("grants help.read to Companybots on their default tools, as a new version, and leaves rebuilt ones", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const [old, rebuilt] = await t.run(async (ctx) => {
			const agent = (await ctx.db.query("agents").first())!;
			const tools = agent.tools.filter((x) => x !== "help.read");
			await ctx.db.patch(agent._id, { tools });
			const { _id, _creationTime, ...copy } = agent;
			return [agent._id, await ctx.db.insert("agents", { ...copy, tools: ["memory.*"] })];
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({ old: (await ctx.db.get(old))!, rebuilt: (await ctx.db.get(rebuilt))!, versions: await ctx.db.query("agentVersions").collect() }));
		expect(after.old.tools).toContain("help.read");
		expect(after.rebuilt.tools).toEqual(["memory.*"]);
		expect(after.versions.find((v) => v.agentId === old && v.version === after.old.version)!.config.tools).toContain("help.read");
	});

	it("grants web tools to Companybots that keep their default grants, as a new version", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const [stock, rebuilt] = await t.run(async (ctx) => {
			const agent = (await ctx.db.query("agents").first())!;
			const { _id, _creationTime, ...copy } = agent;
			await ctx.db.patch(agent._id, { tools: agent.tools.filter((id) => id !== "web.*") });
			return [agent._id, await ctx.db.insert("agents", { ...copy, tools: ["chat.*"] })];
		});
		const before = (await t.run((ctx) => ctx.db.get(stock)))!.version;
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const [after, other, saved] = await t.run(async (ctx) => [
			(await ctx.db.get(stock))!,
			(await ctx.db.get(rebuilt))!,
			await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", stock).eq("version", before + 1)).unique(),
		] as const);
		expect(after.tools).toContain("web.*");
		expect(after.version).toBe(before + 1);
		expect(saved?.config.tools).toEqual(after.tools);
		expect(other.tools).toEqual(["chat.*"]);
	});

	it("grants images.generate to Companybots that keep their default grants, once, as a new version", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const [stock, rebuilt] = await t.run(async (ctx) => {
			const agent = (await ctx.db.query("agents").first())!;
			const { _id, _creationTime, ...copy } = agent;
			await ctx.db.patch(agent._id, { tools: agent.tools.filter((id) => id !== "images.generate") });
			return [agent._id, await ctx.db.insert("agents", { ...copy, tools: ["chat.*"] })];
		});
		const before = (await t.run((ctx) => ctx.db.get(stock)))!.version;
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const [after, other, saved] = await t.run(async (ctx) => [
			(await ctx.db.get(stock))!,
			(await ctx.db.get(rebuilt))!,
			await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", stock).eq("version", before + 1)).unique(),
		] as const);
		expect(after.tools.filter((id) => id === "images.generate")).toHaveLength(1);
		expect(after.version).toBe(before + 1);
		expect(saved?.config.tools).toEqual(after.tools);
		expect(other.tools).toEqual(["chat.*"]);
	});

	it("normalizes membership emails for bounded invitation checks, and fails closed on a row without one", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "MixedCase@Co.com");
		const membership = await t.run(ctx => ctx.db.query("members").first());
		expect(membership!.email).toBe("mixedcase@co.com");
		await expect(owner.mutation(api.workspace.invite, { email: "MIXEDCASE@CO.COM", role: "member" })).rejects.toThrow("already a member");
		await t.run(ctx => ctx.db.patch(membership!._id, { email: undefined }));
		await expect(owner.mutation(api.workspace.invite, { email: "next@co.com", role: "member" })).rejects.toThrow("being updated");
	});
});
