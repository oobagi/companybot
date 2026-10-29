import { legacySkills, legacyAutomations } from "../convex/legacyCatalogs";
import { installedSkills } from "../convex/lib";
import { seedSkill, seedAutomation } from "./legacyFixtures";
import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

import { modules, signIn, ownerAndMember, settle } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("migrations", () => {
	it("empties the retired legacyWorkspaces pins", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			await ctx.db.insert("legacyWorkspaces", { userId, workspaceId });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		expect(await t.run((ctx) => ctx.db.query("legacyWorkspaces").collect())).toEqual([]);
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

	it("normalizes membership emails for bounded invitation checks, and fails closed on a row without one", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "MixedCase@Co.com");
		const membership = await t.run(ctx => ctx.db.query("members").first());
		expect(membership!.email).toBe("mixedcase@co.com");
		await expect(owner.mutation(api.workspace.invite, { email: "MIXEDCASE@CO.COM", role: "member" })).rejects.toThrow("already a member");
		await t.run(ctx => ctx.db.patch(membership!._id, { email: undefined }));
		await expect(owner.mutation(api.workspace.invite, { email: "next@co.com", role: "member" })).rejects.toThrow("being updated");
	});

	it("snapshots retired library installs and retires the test connector", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const agentId = (await ctx.db.query("agents").first())!._id;
			const channelId = (await ctx.db.query("chats").first())!._id;
			const base = { workspaceId, agentId, enabled: true, timeZone: "UTC", installedBy: userId };
			await ctx.db.insert("skillInstalls", { workspaceId, skillId: "meeting-notes" });
			await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "night-owl", roles: ["owner"], installedBy: userId });
			await ctx.db.insert("connectorConnections", { workspaceId, connectorId: "night-owl", userId, credentials: "encrypted", connectedBy: userId });
			return {
				dms: await ctx.db.insert("automationInstalls", { ...base, automationId: "morning-brief", audience: "subscribers" }),
				channel: await ctx.db.insert("automationInstalls", { ...base, automationId: "after-call-summary", channelId, audience: "channel" }),
			};
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const snapshots = await t.run(async (ctx) => ({
			skills: (await ctx.db.query("skillInstalls").collect()).map((i) => i.definition),
			automations: (await ctx.db.query("automationInstalls").collect()).map((i) => i.definition),
			connectors: await ctx.db.query("connectorInstalls").collect(),
			credentials: await ctx.db.query("connectorConnections").collect(),
		}));
		expect(snapshots).toEqual({ skills: [legacySkills[0]], automations: legacyAutomations, connectors: [], credentials: [] });
		const skills = legacySkills.splice(0), automations = legacyAutomations.splice(0);
		try {
			const workspaceId = (await t.run((ctx) => ctx.db.get(ids.dms)))!.workspaceId;
			expect(await t.run((ctx) => installedSkills(ctx, workspaceId))).toEqual(snapshots.skills);
			const install = (await t.run((ctx) => ctx.db.get(ids.channel)))!;
			const { definitionOf } = await import("../convex/automationOps");
			expect(await t.run((ctx) => definitionOf(ctx, { ...install, audience: install.audience! }))).toEqual(snapshots.automations[1]);
		} finally { legacySkills.push(...skills); legacyAutomations.push(...automations); }
	});
});

it("snapshots trashed installs without reviving them or resetting their 30-day retention", async () => {
	const { t, owner } = await ownerAndMember();
	migrationsTest.register(t);
	await seedSkill(t, owner, "meeting-notes");
	await seedAutomation(t, owner, "morning-brief");
	await t.run(async (ctx) => { const workspaceId = (await ctx.db.query("skillInstalls").first())!.workspaceId; await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "night-owl", roles: ["owner"], installedBy: owner.userId }); });
	await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
	await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
	const before = await t.run((ctx) => ctx.db.query("trash").collect());
	vi.useFakeTimers();
	for (let n = 0; n < 2; n++) { await t.mutation(internal.migrations.runAll); await settle(t); }
	expect(await t.run((ctx) => ctx.db.query("trash").collect())).toEqual(before);
	expect(await t.run((ctx) => ctx.db.query("connectorInstalls").collect())).toEqual([]);
	const rows = await t.run(async (ctx) => ({ skill: (await ctx.db.query("skillInstalls").first())!, automation: (await ctx.db.query("automationInstalls").first())! }));
	expect(rows.skill).toMatchObject({ archived: true, definition: legacySkills[0] });
	expect(rows.automation).toMatchObject({ archived: true, definition: legacyAutomations[0] });
	expect(await t.run((ctx) => installedSkills(ctx, rows.skill.workspaceId))).toEqual([]);
	for (const entry of before) await owner.mutation(api.trash.restore, { kind: entry.kind, id: entry.itemId });
	expect((await owner.query(api.skills.list))[0]).toMatchObject({ trash: null, name: "Meeting notes" });
	expect((await owner.query(api.automations.list))[0]).toMatchObject({ trash: null, subscribed: true });
});
