import { signIn, newTest } from "./helpers";
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
