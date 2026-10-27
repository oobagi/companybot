import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema, { audience } from "../convex/schema";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
	it("adds the make-skills, automations, records and pages and parity tools to existing Companybots, each as a new version", async () => {
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
		expect(after.bot.tools).toEqual(["memory.*", "skills.load", "chat.*", "skills.create", "automations.*", "records.*", "pages.*", "channels.*", "skills.manage", "skills.remove", "members.*", "workspace.*", "agents.manage", "skills.edit"]);
		expect(after.bot.version).toBe(ids.version + 6);
		expect(after.scribe.tools).not.toContain("skills.create");
		expect(after.scribe.tools).not.toContain("records.*");
	});
});
