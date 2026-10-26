import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { modules, settle, signIn } from "./helpers";

// Deleting a workspace bigger than one transaction may write (16,000), with a message whose
// reactions alone span several runs: every run must stay under Convex's limits.

it("deletes a workspace with 17,000 messages and 2,500 reactions on one without exceeding transaction limits", { timeout: 600_000 }, async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = (await owner.query(api.workspace.me))!.workspaceId!;
	const chatId = (await owner.query(api.chats.list))!.channels[0]!._id;
	const message = { chatId, workspaceId, authorUserId: owner.userId, text: "hi", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" as const };
	for (let start = 0; start < 17_000; start += 2_000) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 2_000; i++) await ctx.db.insert("chatMessages", message);
		});
	}
	await t.run(async (ctx) => {
		const messageId = (await ctx.db.query("chatMessages").first())!._id;
		for (let i = 0; i < 2_500; i++) await ctx.db.insert("reactions", { messageId, chatId, emoji: `e${i}`, userId: owner.userId });
	});
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(workspaceId))).toBeNull();
	for (const table of ["chatMessages", "reactions", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first())).toBeNull();
});
