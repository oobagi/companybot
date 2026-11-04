import migrationsTest from "@convex-dev/migrations/test";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
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

	it("strips the retired chat.react from agents and their versions, and drops rules and locks on it", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const { companybot } = await agentsOf(owner);
		const tools = ["memory.search", "chat.react", "chat.read"];
		await t.run(async (ctx) => {
			const agent = (await ctx.db.get(companybot._id))!;
			await ctx.db.patch(agent._id, { tools });
			const version = (await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", agent._id)).first())!;
			await ctx.db.patch(version._id, { config: { ...version.config, tools } });
			const rule = { workspaceId: agent.workspaceId, userId: owner.userId, setting: "never" as const, setAt: 1 };
			await ctx.db.insert("permissionRules", { ...rule, action: "chat.react" });
			await ctx.db.insert("permissionRules", { ...rule, action: "chat.read" });
			await ctx.db.insert("permissionLocks", { workspaceId: agent.workspaceId, action: "chat.react", lock: "block", setBy: owner.userId, setAt: 1 });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({
			agent: (await ctx.db.get(companybot._id))!,
			versions: await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", companybot._id)).collect(),
			rules: await ctx.db.query("permissionRules").collect(),
			locks: await ctx.db.query("permissionLocks").collect(),
		}));
		expect(after.agent.tools).toEqual(["memory.search", "chat.read"]);
		// Not a new version: nothing it can do changed.
		expect(after.agent.version).toBe(companybot.version);
		expect(after.versions.map((v) => v.config.tools)).toEqual([["memory.search", "chat.read"]]);
		expect(after.rules.map((r) => r.action)).toEqual(["chat.read"]);
		expect(after.locks).toEqual([]);
	});

	// COMPAT(0.1.0-alpha.10): delete with migrations.automationOutcomes.
	it("turns automations' last run lines into outcomes that name channels by id, and drops ones it can't place", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		prosemirrorSync.register(t);
		const owner = await signIn(t, "owner@co.com");
		const vault = await owner.mutation(api.chats.createChannel, { name: "vault", private: false });
		const { companybot } = await agentsOf(owner);
		const make = async (name: string, trigger: object = { type: "schedule", cron: "0 9 * * *" }) =>
			(await owner.mutation(api.automations.create, { config: { name, prompt: "Sum it up.", trigger: trigger as never }, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" }));
		const lines = {
			Posted: "Posted in #vault.",
			Missing: "Didn't run: Owner, who made it, isn't in #vault. Pick another channel.",
			Watches: "Didn't run: It watches #vault, which is private, so it can only post there or to people who turn it on.",
			Plain: "Sent to 3 people.",
			Gone: "Posted in #nowhere.",
		};
		const ids: Record<string, string> = {};
		for (const name of Object.keys(lines)) ids[name] = await make(name, name === "Watches" ? { type: "event", event: "message.posted", channelId: vault } : undefined);
		await t.run(async (ctx) => {
			for (const install of await ctx.db.query("automationInstalls").collect()) {
				const name = Object.keys(ids).find((n) => ids[n] === install.automationId) as keyof typeof lines | undefined;
				if (name) await ctx.db.patch(install._id, { lastRunAt: 1, lastResult: lines[name] });
			}
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ctx.db.query("automationInstalls").collect());
		const of = (name: string) => after.find((i) => i.automationId === ids[name])!;
		expect(after.every((i) => i.lastResult === undefined)).toBe(true);
		expect(of("Posted").lastOutcome).toEqual({ text: "Posted in {channel}.", channelId: vault });
		expect(of("Missing").lastOutcome).toEqual({ text: "Didn't run: Owner, who made it, isn't in {channel}. Pick another channel.", channelId: vault });
		expect(of("Watches").lastOutcome).toEqual({ text: "Didn't run: It watches {watched}, which is private, so it can only post there or to people who turn it on.", watchedId: vault });
		expect(of("Plain").lastOutcome).toEqual({ text: "Sent to 3 people." });
		expect(of("Gone").lastOutcome).toBeUndefined();
		expect((await owner.query(api.automations.list)).find((a) => a.name === "Posted")!.lastResult).toBe("Posted in #vault.");
	});

	// COMPAT(0.1.0-alpha.10): delete with migrations.pageMoveIds.
	it("turns page move history's titles into page ids, top level as null, unmatched or ambiguous as unknown", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		prosemirrorSync.register(t);
		const owner = await signIn(t, "owner@co.com");
		const board = await owner.mutation(api.pages.create, { title: "Board" });
		const agenda = await owner.mutation(api.pages.create, { title: "Agenda" });
		await owner.mutation(api.pages.create, { title: "Notes" });
		await owner.mutation(api.pages.create, { title: "Notes" });
		// Many near matches before the exact one, and a second exact one in Archive.
		for (let i = 0; i < 25; i++) await owner.mutation(api.pages.create, { title: `Plan ${i}` });
		const plan = await owner.mutation(api.pages.create, { title: "Plan" });
		for (let i = 0; i < 25; i++) await owner.mutation(api.pages.create, { title: `Draft ${i}` });
		await owner.mutation(api.pages.create, { title: "Draft" });
		await owner.mutation(api.trash.move, { kind: "page", id: await owner.mutation(api.pages.create, { title: "Draft" }) });
		const rows = await t.run(async (ctx) => {
			const { workspaceId } = (await ctx.db.get(agenda))!;
			const userId = (await ctx.db.query("users").first())!._id;
			const row = (n: number, from: string, to: string) => ctx.db.insert("pageMoves", { workspaceId, pageId: agenda, n, userId, from, to });
			return [await row(1, "Pages", "Board"), await row(2, "Notes", "Gone page"), await row(3, "Plan", "Draft")];
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const [first, second, third] = await t.run(async (ctx) => Promise.all(rows.map((id) => ctx.db.get(id))));
		expect([third!.fromId, third!.toId]).toEqual([plan, undefined]);
		expect(first).toMatchObject({ fromId: null, toId: board });
		expect([second!.fromId, second!.toId]).toEqual([undefined, undefined]);
		expect([first!.from, first!.to, second!.from, second!.to]).toEqual([undefined, undefined, undefined, undefined]);
		expect((await owner.query(api.pages.moves, { pageId: agenda, paginationOpts: { numItems: 10, cursor: null } })).page.map((m) => [m.from, m.to])).toEqual([
			["Plan", "another page"],
			["another page", "another page"],
			["Pages", "Board"],
		]);
	});
});
