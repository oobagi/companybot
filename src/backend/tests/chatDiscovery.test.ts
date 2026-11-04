import migrationsTest from "@convex-dev/migrations/test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { newTest, noMentions, signIn, workspaceOf } from "./helpers";

it("backfills legacy search audiences and activity seats, and reindexes access changes", async () => {
	const t = newTest();
	migrationsTest.register(t);
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const chatId = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
	const messageId = await t.run(async (ctx) => {
		await ctx.db.patch(chatId, { searchPublic: undefined });
		const seat = await ctx.db.query("chatMembers").withIndex("by_user", (q) => q.eq("userId", owner.userId).eq("chatId", chatId)).first();
		await ctx.db.patch(seat!._id, { activityAt: undefined, restricted: undefined });
		return ctx.db.insert("chatMessages", { workspaceId, chatId, authorUserId: owner.userId, text: "legacy history", parts: [], status: "done", mentions: noMentions });
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally { vi.useRealTimers(); }
	expect((await t.run((ctx) => ctx.db.get("chatMessages", messageId)))!.searchPublic).toBe(true);
	const seat = await t.run((ctx) => ctx.db.query("chatMembers").withIndex("by_user", (q) => q.eq("userId", owner.userId).eq("chatId", chatId)).first());
	expect(seat).toMatchObject({ restricted: false, activityAt: expect.any(Number) });
	const ownerRole = (await owner.query(api.roles.list))!.find((r) => r.name === "Owner")!.id;
	await owner.mutation(api.chats.setAccess, { chatId, access: [{ role: ownerRole, level: "edit" }] });
	await t.mutation(internal.chatDiscovery.refreshMessages, { chatId, cursor: null });
	await t.mutation(internal.chatDiscovery.refreshSeats, { chatId, cursor: null });
	expect((await t.run((ctx) => ctx.db.get("chatMessages", messageId)))!.searchPublic).toBe(false);
	expect((await t.run((ctx) => ctx.db.get("chatMembers", seat!._id)))!.restricted).toBe(true);
	const sent = await owner.mutation(api.messages.send, { chatId, text: "new restricted message", mentions: noMentions });
	expect((await t.run((ctx) => ctx.db.get("chatMessages", sent)))!.searchPublic).toBe(false);
	await t.mutation(internal.chatDiscovery.refreshSeats, { chatId, cursor: null });
	expect((await t.run((ctx) => ctx.db.get("chatMembers", seat!._id)))!.activityAt).toBe((await t.run((ctx) => ctx.db.get("chats", chatId)))!.lastMessageAt);
});
