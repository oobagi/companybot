import { signIn, newTest, workspaceOf } from "./helpers";
import migrationsTest from "@convex-dev/migrations/test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// The userMentions backfill (migrations.ts) on messages that each mention a crowd: no
// transaction may go over Convex's 16,000-write limit, and every row lands.

it("backfills 100 messages mentioning 161 people each without hitting the write limit", { timeout: 600_000 }, async () => {
	const t = newTest();
	migrationsTest.register(t);
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const chatId = await owner.mutation(api.chats.createChannel, { name: "large", private: false });
	await t.run(async (ctx) => {
		const userIds: Id<"users">[] = [];
		for (let i = 0; i < 161; i++) {
			const id = await ctx.db.insert("users", { email: `person${i}@co.com` });
			await ctx.db.insert("members", { userId: id, workspaceId, role: "member" });
			userIds.push(id);
		}
		// One that names few people, so both paths run.
		await ctx.db.insert("chatMessages", { chatId, workspaceId, text: "@few", parts: [], mentions: { userIds: userIds.slice(0, 3), agentIds: [] }, status: "done" });
		for (let i = 0; i < 100; i++) {
			await ctx.db.insert("chatMessages", { chatId, workspaceId, text: "@all", parts: [], mentions: { userIds, agentIds: [] }, status: "done" });
		}
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
	expect(await t.query(internal.migrations.status)).toContainEqual(expect.objectContaining({ name: "migrations:userMentions", state: "success" }));
	expect(await t.run(async (ctx) => (await ctx.db.query("userMentions").collect()).length)).toBe(100 * 161 + 3);
});
