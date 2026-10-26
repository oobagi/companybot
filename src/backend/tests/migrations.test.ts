import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

import { modules, signIn, generalOf } from "./helpers";
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

	it("moves rows from the old plugin tables to the connector tables", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			await ctx.db.insert("pluginInstalls", { workspaceId, pluginId: "crm", roles: ["owner"], installedBy: userId });
			await ctx.db.insert("pluginConnections", { workspaceId, pluginId: "crm", userId: null, credentials: "enc", connectedBy: userId });
			await ctx.db.insert("pluginOAuthFlows", { state: "s", pluginId: "crm", userId, data: "d", expiresAt: 1 });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const rows = await t.run(async (ctx) => ({
			old: [
				...(await ctx.db.query("pluginInstalls").collect()),
				...(await ctx.db.query("pluginConnections").collect()),
				...(await ctx.db.query("pluginOAuthFlows").collect()),
			].length,
			installs: await ctx.db.query("connectorInstalls").collect(),
			connections: await ctx.db.query("connectorConnections").collect(),
			flows: await ctx.db.query("connectorOAuthFlows").collect(),
		}));
		expect(rows.old).toBe(0);
		expect(rows.installs.map((r) => [r.connectorId, r.roles])).toEqual([["crm", ["owner"]]]);
		expect(rows.connections.map((r) => [r.connectorId, r.credentials])).toEqual([["crm", "enc"]]);
		expect(rows.flows.map((r) => [r.connectorId, r.state])).toEqual([["crm", "s"]]);
		expect(await owner.query(api.connectors.list)).toContainEqual(expect.objectContaining({ id: "crm", installed: true }));
	});

	it("gives old automation installs an audience, keeping channels and subscribing the installer", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const agentId = (await ctx.db.query("agents").first())!._id;
			const channelId = (await ctx.db.query("chats").first())!._id;
			const base = { workspaceId, agentId, enabled: true, timeZone: "UTC", installedBy: userId };
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
	});
});

describe("migrations: Companybot chat tools", () => {
	it("adds the make-skills, automations and records tools to existing Companybots, each as a new version", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const agents = await ctx.db.query("agents").collect();
			const bot = agents.find((a) => a.name === "Companybot")!;
			const scribe = agents.find((a) => a.name === "Scribe")!;
			await ctx.db.patch(bot._id, { tools: ["memory.*", "skills.load", "chat.*"] });
			return { bot: bot._id, scribe: scribe._id, version: bot.version };
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({ bot: (await ctx.db.get(ids.bot))!, scribe: (await ctx.db.get(ids.scribe))! }));
		expect(after.bot.tools).toEqual(["memory.*", "skills.load", "chat.*", "skills.create", "automations.*", "records.*"]);
		expect(after.bot.version).toBe(ids.version + 2);
		expect(after.scribe.tools).not.toContain("skills.create");
		expect(after.scribe.tools).not.toContain("records.*");
	});
});
