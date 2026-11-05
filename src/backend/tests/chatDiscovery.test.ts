import migrationsTest from "@convex-dev/migrations/test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { activityOf, addToChat, dropSeat, insertMessage, markChatRead } from "../convex/chatOps";
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
		const activity = await ctx.db.query("seatActivity").withIndex("by_seat", (q) => q.eq("seatId", seat!._id)).first();
		await ctx.db.delete(activity!._id);
		return ctx.db.insert("chatMessages", { workspaceId, chatId, authorUserId: owner.userId, text: "legacy history", parts: [], status: "done", mentions: noMentions });
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally { vi.useRealTimers(); }
	expect((await t.run((ctx) => ctx.db.get("chatMessages", messageId)))!.searchPublic).toBe(true);
	const seat = await t.run((ctx) => ctx.db.query("chatMembers").withIndex("by_user", (q) => q.eq("userId", owner.userId).eq("chatId", chatId)).first());
	const activity = () => t.run((ctx) => ctx.db.query("seatActivity").withIndex("by_seat", (q) => q.eq("seatId", seat!._id)).first());
	expect(await activity()).toMatchObject({ restricted: false, activityAt: expect.any(Number) });
	const ownerRole = (await owner.query(api.roles.list))!.find((r) => r.name === "Owner")!.id;
	await owner.mutation(api.chats.setAccess, { chatId, access: [{ role: ownerRole, level: "edit" }] });
	await t.mutation(internal.chatDiscovery.refreshMessages, { chatId, cursor: null });
	expect((await t.run((ctx) => ctx.db.get("chatMessages", messageId)))!.searchPublic).toBe(false);
	expect(await activity()).toMatchObject({ restricted: true });
	const sent = await owner.mutation(api.messages.send, { chatId, text: "new restricted message", mentions: noMentions });
	expect((await t.run((ctx) => ctx.db.get("chatMessages", sent)))!.searchPublic).toBe(false);
	expect((await activity())!.activityAt).toBe((await t.run(async (ctx) => activityOf(ctx, (await ctx.db.get("chats", chatId))!))).lastMessageAt);
});

it("sets search audiences when creating general, an agent DM and its side chat", async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const side = await owner.mutation(api.chats.createSideChat, { parentId: dm });
	const audiences = await t.run(async (ctx) => {
		const general = await ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("kind", "channel")).filter((q) => q.eq(q.field("isDefault"), true)).first();
		return [general!.searchPublic, (await ctx.db.get("chats", dm))!.searchPublic, (await ctx.db.get("chats", side))!.searchPublic];
	});
	expect(audiences).toEqual([true, false, false]);
});


it("sends update activity documents while markRead touches only the seat document", async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const send = await t.run(async (ctx) => {
		const chat = (await ctx.db.get("chats", chatId))!;
		const reads = vi.spyOn(ctx.db, "query");
		const writes = vi.spyOn(ctx.db, "patch");
		try {
			await insertMessage(ctx, chat, { authorAgentId: agentId, text: "reply", parts: [], mentions: noMentions, status: "done" });
			return { reads: reads.mock.calls.map(([table]) => table), writes: writes.mock.calls.map(([id]) => id) };
		} finally { reads.mockRestore(); writes.mockRestore(); }
	});
	const read = await t.run(async (ctx) => {
		const writes = vi.spyOn(ctx.db, "patch");
		try {
			await markChatRead(ctx, chatId, owner.userId);
			return writes.mock.calls.map(([id]) => id);
		} finally { writes.mockRestore(); }
	});
	expect(send.reads).not.toContain("chatMembers");
	expect(send.writes.filter((id) => read.includes(id))).toEqual([]);
	expect(read).toHaveLength(1);
	expect(await t.run(async (ctx) => send.writes.filter((id) => ctx.db.normalizeId("seatActivity", id)).length)).toBe(1);
});


it("does not create discovery rows for agents or count them toward the inline threshold", async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const chatId = await owner.mutation(api.chats.createChannel, { name: "agents", private: true });
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	await t.run(async (ctx) => {
		const chat = (await ctx.db.get("chats", chatId))!;
		const { _id, _creationTime, ...config } = (await ctx.db.get("agents", agentId))!;
		for (let i = 0; i < 100; i++) {
			const id = await ctx.db.insert("agents", { ...config, name: `Agent ${i}` });
			await addToChat(ctx, chat, { agentId: id });
		}
		const jobs = vi.spyOn(ctx.scheduler, "runAfter");
		try {
			await insertMessage(ctx, chat, { authorUserId: owner.userId, text: "hello", parts: [], mentions: noMentions, status: "done" });
			expect(jobs).not.toHaveBeenCalled();
		} finally { jobs.mockRestore(); }
	});
	const activity = await t.run((ctx) => ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect());
	expect(activity).toHaveLength(1);
	expect(activity[0]!.userId).toBe(owner.userId);
	expect((await t.run((ctx) => ctx.db.get("chats", chatId)))!.memberCount).toBe(101);
	await t.run(async (ctx) => {
		const seat = (await ctx.db.query("chatMembers").withIndex("by_user", (q) => q.eq("userId", owner.userId).eq("chatId", chatId)).first())!;
		await dropSeat(ctx, seat);
		expect(await ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect()).toEqual([]);
		expect((await ctx.db.get("chats", chatId))!.memberCount).toBe(100);
	});
});
