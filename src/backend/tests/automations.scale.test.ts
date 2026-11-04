import { automationJobs } from "./automationJobs";
import { internal } from "../convex/_generated/api";
import { signIn, newTest, workspaceOf, generalOf, addMember } from "./helpers";
import { expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

// A busy webhook keeps a week of delivery ids: deleting its automation forever must stay under
// Convex's 16,000-write limit however many there are.

it("deletes an automation with 20,000 webhook deliveries without exceeding transaction limits", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	const automationId = await owner.mutation(api.automations.create, {
		config: { name: "Hook", prompt: "Act on it.", trigger: { type: "webhook" } },
		agentId,
		audience: "creator",
		timeZone: "UTC",
	});
	const installId = (await t.run((ctx) => ctx.db.query("automationInstalls").first()))!._id;
	for (let start = 0; start < 20_000; start += 2_000) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 2_000; i++) await ctx.db.insert("automationEvents", { installId, eventId: `e${i}` });
		});
	}
	vi.useFakeTimers();
	try {
		// Delete goes to Archive; deleting it forever is what clears the deliveries.
		await owner.mutation(api.automations.remove, { automationId });
		const [entry] = (await owner.query(api.trash.list, { paginationOpts: { numItems: 10, cursor: null } })).page;
		await owner.mutation(api.trash.purge, { id: entry!.itemId });
		expect(await t.run((ctx) => ctx.db.get(installId))).toBeNull();
		await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
	} finally {
		vi.useRealTimers();
	}
	expect(await t.run((ctx) => ctx.db.query("automationEvents").first())).toBeNull();
});

// The test backend enforces real transaction limits, including index ranges and scheduled jobs.
it.each(["tick", "send"] as const)("batches %s with 1,500 subscribers and 300 due workspaces", { timeout: 600_000 }, async (kind) => {
	vi.useFakeTimers();
	try {
		const t = newTest();
		const owner = await signIn(t, "scale@co.com");
		const workspaceId = await workspaceOf(owner);
		const agentId = (await owner.query(api.agents.list))[0]!._id;
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.automations.create, {
			config: { name: "Scale", prompt: "Hello", trigger: kind === "tick" ? { type: "schedule", cron: "0 9 * * *" } : { type: "event", event: "message.posted", channelId: chatId } },
			agentId, audience: "subscribers", timeZone: "UTC",
		});
		const install = (await t.run(ctx => ctx.db.query("automationInstalls").first()))!;
		for (let start = 1; start < 1500; start += 100) await t.run(async ctx => {
			for (let i = start; i < Math.min(start + 100, 1500); i++) {
				const userId = await ctx.db.insert("users", { email: `scale${i}@co.com` });
				await addMember(ctx, { workspaceId, userId, email: `scale${i}@co.com`, role: "member" });
				await ctx.db.insert("automationSubscriptions", { installId: install._id, userId });
			}
		});
		if (kind === "tick") {
			for (let start = 0; start < 300; start += 50) await t.run(async ctx => {
				for (let i = start; i < start + 50; i++) {
					const ws = await ctx.db.insert("workspaces", { name: `Workspace ${i}`, version: 1 });
					const { _id, _creationTime, ...fields } = install;
					await ctx.db.insert("automationInstalls", { ...fields, workspaceId: ws, audience: "creator", nextRunAt: 0, lastScheduledAt: 0 });
				}
			});
			await t.run(ctx => ctx.db.patch(install._id, { nextRunAt: 0, lastScheduledAt: 0 }));
			await t.mutation(internal.automationRuns.tick, { now: Date.UTC(2026, 10, 4, 10) });
		} else {
			await owner.mutation(api.messages.send, { chatId, text: "Trigger", mentions: { userIds: [], agentIds: [] } });
		}
		// Neither entry point delivers inline.
		expect(await t.run(ctx => ctx.db.query("agentTurns").collect())).toHaveLength(0);
		await automationJobs(t);
		expect(await t.run(ctx => ctx.db.query("agentTurns").collect())).toHaveLength(1500);
		expect((await t.run(ctx => ctx.db.get(install._id)))!.lastOutcome?.text).toBe("Sent to 1500 people.");
		if (kind === "tick") expect(await t.run(ctx => ctx.db.query("automationInstalls").withIndex("by_due", q => q.gt("nextRunAt", undefined).lte("nextRunAt", Date.UTC(2026, 10, 4, 10))).collect())).toHaveLength(0);
	} finally { vi.useRealTimers(); }
});
