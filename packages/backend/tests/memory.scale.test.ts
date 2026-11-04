import { signIn, newTest, workspaceOf } from "./helpers";
import { expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

it.each([
	{ name: "16,100 personal memories", count: 16_100, contentSize: 20, batch: 1_000 },
	{ name: "19 MB of personal memories", count: 24, contentSize: 800_000, batch: 5 },
])("removes a member with $name without exceeding transaction limits", { timeout: 600_000 }, async ({ count, contentSize, batch }) => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	const memberId = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { email: "member@co.com" });
		return ctx.db.insert("members", { userId, workspaceId, role: "member" });
	});
	const userId = (await t.run((ctx) => ctx.db.get(memberId)))!.userId;
	for (let start = 0; start < count; start += batch) {
		await t.run(async (ctx) => {
			for (let i = start; i < Math.min(start + batch, count); i++) {
				await ctx.db.insert("memories", {
					workspaceId, agentId, ownerId: userId, scope: "personal", content: `${"x".repeat(contentSize)} ${i}`,
					updatedAt: Date.now(), updatedBy: userId, version: 1,
				});
			}
		});
	}
	vi.useFakeTimers();
	try {
		await owner.mutation(api.workspace.removeMember, { id: memberId });
		expect(await t.run((ctx) => ctx.db.get(memberId))).toBeNull();
		await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
	} finally {
		vi.useRealTimers();
	}
	expect(await t.run((ctx) => ctx.db.query("memories").first())).toBeNull();
});
