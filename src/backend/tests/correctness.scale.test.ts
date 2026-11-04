import { expect, it } from "vitest";
import { usageMonth } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import { imageSpent } from "../convex/usage";
import { addMember, agentTurn, agentsOf, ownerAndMember, workspaceOf } from "./helpers";

it("lists team and own memories with 1,600 members' personal histories", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	for (let start = 0; start < 1600; start += 100) await t.run(async (ctx) => {
		for (let i = start; i < start + 100; i++) {
			const userId = await ctx.db.insert("users", { email: `${i}@co.com` });
			await addMember(ctx, { workspaceId, userId, role: "member" });
			for (let n = 0; n < 11; n++) await ctx.db.insert("memories", { workspaceId, agentId, scope: "personal", ownerId: userId, content: "private", updatedBy: userId, updatedAt: 0, version: 1 });
		}
	});
	await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "team" });
	await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "mine" });
	expect((await owner.query(api.memory.list)).map((m) => m.content).sort()).toEqual(["mine", "team"]);
});

it("marks partial totals at 12k usage buckets and enforces the full image budget", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const month = usageMonth(Date.now());
	const agentId = (await agentsOf(owner)).companybot._id;
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const turnId = await agentTurn(t, owner, dm, agentId);
	await t.run((ctx) => ctx.db.patch(workspaceId, { imageBudgetUsd: 1000 }));
	expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 0, truncated: false, rowCount: 0 });
	for (let start = 0; start < 12000; start += 1000) await t.run(async (ctx) => {
		for (let i = start; i < start + 1000; i++) await ctx.db.insert("usage", { workspaceId, month, userId: owner.userId, kind: i < 11000 ? "chat" : "image", model: `model-${i}`, costUsd: 1 });
	});
	expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 4000, truncated: true, rowCount: 4000 });
	expect(await t.run((ctx) => imageSpent(ctx, workspaceId))).toBe(1000);
	expect(await t.mutation(internal.imageGen.prepareFor, { turnId, editFiles: [] })).toHaveProperty("error");
	await t.run((ctx) => ctx.db.insert("usage", { workspaceId, month, kind: "image", costUsd: 2 }));
	expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 4001, truncated: true });
	expect(await t.run((ctx) => imageSpent(ctx, workspaceId))).toBe(1002);
});

it("search and activity survive 5k other people's private DM rows", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const mine = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const theirs = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const turnId = await agentTurn(t, owner, mine, agentId);
	await t.run(async (ctx) => {
		await ctx.db.insert("chatMessages", { workspaceId, chatId: mine, authorUserId: owner.userId, text: "needle mine", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" });
		await ctx.db.insert("agentActivity", { workspaceId, chatId: mine, actorId: owner.userId, agentId, callId: "mine", tool: "chat.search", input: "{}", changes: false, status: "done" });
	});
	for (let start = 0; start < 5000; start += 500) await t.run(async (ctx) => {
		for (let i = start; i < start + 500; i++) {
			await ctx.db.insert("chatMessages", { workspaceId, chatId: theirs, authorUserId: member.userId, text: "needle private", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" });
			await ctx.db.insert("agentActivity", { workspaceId, chatId: theirs, actorId: member.userId, agentId, callId: `${i}`, tool: "chat.search", input: "{}", changes: false, status: "done" });
		}
	});
	const result = await t.query(internal.chatTools.searchFor, { turnId, query: "needle" });
	expect.soft(result).toMatchObject({ messages: [{ text: "needle mine" }] });
	expect(await owner.query(api.activity.list, {})).toMatchObject([{ callId: "mine", mine: true }]);
});
