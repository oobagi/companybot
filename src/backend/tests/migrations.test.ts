import { legacySkills, legacyAutomations } from "../convex/legacyCatalogs";
import { installedSkills } from "../convex/lib";
import { scribe, seedSkill, seedAutomation } from "./legacyFixtures";
import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema, { audience } from "../convex/schema";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { modules, signIn, generalOf, ownerAndMember, settle } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("migrations", () => {
	it("indexes mentions in messages sent before the mentions index", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const general = await generalOf(owner);
		const messageId = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const message = { chatId: general._id, workspaceId, text: "@you", parts: [], status: "done" as const };
			await ctx.db.insert("chatMessages", { ...message, threadId: undefined, mentions: { userIds: [], agentIds: [] } });
			return ctx.db.insert("chatMessages", { ...message, mentions: { userIds: [userId, userId], agentIds: [] } });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const rows = await t.run((ctx) => ctx.db.query("userMentions").collect());
		expect(rows.map((r) => r.messageId)).toEqual([messageId]);
	});

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

	it("backfills normalized membership emails before bounded invitation checks, preserving mixed-case alpha.6 accounts", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "MixedCase@Co.com");
		const membership = await t.run(ctx => ctx.db.query("members").first());
		expect(membership!.email).toBe("mixedcase@co.com");
		await expect(owner.mutation(api.workspace.invite, { email: "MIXEDCASE@CO.COM", role: "member" })).rejects.toThrow("already a member");
		await t.run(ctx => ctx.db.patch(membership!._id, { email: undefined }));
		await expect(owner.mutation(api.workspace.invite, { email: "next@co.com", role: "member" })).rejects.toThrow("being updated");
		vi.useFakeTimers();
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await t.run(ctx => ctx.db.get(membership!._id)))!.email).toBe("mixedcase@co.com");
		await expect(owner.mutation(api.workspace.invite, { email: "mixedcase@co.com", role: "member" })).rejects.toThrow("already a member");
		expect(await owner.mutation(api.workspace.invite, { email: "next@co.com", role: "member" })).toEqual({ emailed: true });
	});

	it("gives old automation installs an audience, keeping channels and subscribing the installer", async () => {
		const legacySchema = defineSchema({
			...schema.tables,
			automationInstalls: defineTable({ ...schema.tables.automationInstalls.validator.fields, audience: v.optional(audience) })
				.index("by_workspace", ["workspaceId", "automationId"])
				.index("by_enabled", ["enabled"])
				.index("by_webhook", ["webhookToken"]),
		});
		const t = convexTest({ schema: legacySchema, modules, transactionLimits: true });
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
				userId,
				dms: await ctx.db.insert("automationInstalls", { ...base, automationId: "morning-brief" }),
				channel: await ctx.db.insert("automationInstalls", { ...base, automationId: "after-call-summary", channelId }),
			};
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({
			dms: (await ctx.db.get(ids.dms))!.audience,
			channel: (await ctx.db.get(ids.channel))!.audience,
			subs: (await ctx.db.query("automationSubscriptions").collect()).map((s) => [s.installId, s.userId]),
		}));
		expect(after).toEqual({ dms: "subscribers", channel: "channel", subs: [[ids.dms, ids.userId]] });
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

describe("migrations: Companybot chat tools", () => {
	it("adds the make-skills, automations, records and pages and parity tools to existing Companybots, each as a new version", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const agents = await ctx.db.query("agents").collect();
			const bot = agents.find((a) => a.name === "Companybot")!;
			const { _id, _creationTime, ...stored } = bot;
			const writerId = await ctx.db.insert("agents", { ...stored, ...scribe });
			const writer = (await ctx.db.get(writerId))!;
			await ctx.db.patch(bot._id, { tools: ["memory.*", "skills.load", "chat.*"] });
			return { bot: bot._id, scribe: writer._id, version: bot.version };
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({ bot: (await ctx.db.get(ids.bot))!, scribe: (await ctx.db.get(ids.scribe))! }));
		expect(after.bot.tools).toEqual(["memory.*", "skills.load", "chat.*", "skills.create", "automations.*", "records.*", "pages.*", "channels.*", "skills.manage", "skills.remove", "members.*", "workspace.*", "agents.manage", "skills.edit"]);
		expect(after.bot.version).toBe(ids.version + 6);
		expect(after.scribe.tools).not.toContain("skills.create");
		expect(after.scribe.tools).not.toContain("records.*");
	});
});
