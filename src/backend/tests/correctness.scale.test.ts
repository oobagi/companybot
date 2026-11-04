import { expect, it, vi } from "vitest";
import { usageMonth } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import { addToChat, insertMessage } from "../convex/chatOps";
import { activityPage } from "../convex/activity";
import { memberOf } from "../convex/lib";
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
			for (let n = 0; n < 11; n++) await ctx.db.insert("memories", { workspaceId, agentId, scope: "personal", ownerId: userId, content: "private".repeat(200), updatedBy: userId, updatedAt: 0, version: 1 });
		}
	});
	await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "team" });
	await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "mine" });
	expect((await owner.query(api.memory.list)).map((m) => m.content).sort()).toEqual(["mine", "team"]);
});

it("reports exact totals at 12k usage buckets and enforces the full image budget", { timeout: 600_000 }, async () => {
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
	expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 12000, truncated: false, rowCount: 12000 });
	expect(await t.run((ctx) => imageSpent(ctx, workspaceId))).toBe(1000);
	expect(await t.mutation(internal.imageGen.prepareFor, { turnId, editFiles: [] })).toHaveProperty("error");
	await t.run((ctx) => ctx.db.insert("usage", { workspaceId, month, kind: "image", costUsd: 2 }));
	expect(await owner.query(api.usage.report, {})).toMatchObject({ total: 12002, truncated: false });
	expect(await t.run((ctx) => imageSpent(ctx, workspaceId))).toBe(1002);
});

it("finds public history beyond the 25th channel and ranks the real answer above current-chat near matches", async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const here = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const turnId = await agentTurn(t, owner, here, agentId);
	const sales = await t.run(async (ctx) => {
		const sales = await ctx.db.insert("chats", { workspaceId, kind: "channel", name: "sales", private: false, searchPublic: true, archived: false, createdBy: owner.userId, lastMessageAt: 0 });
		for (let i = 1; i <= 25; i++) await ctx.db.insert("chats", { workspaceId, kind: "channel", name: `newer-${i}`, private: false, searchPublic: true, archived: false, createdBy: owner.userId, lastMessageAt: i });
		for (let i = 0; i < 25; i++) await ctx.db.insert("chatMessages", { workspaceId, chatId: here, authorUserId: owner.userId, text: "Acme pricingdraft is still being reviewed", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done", searchPublic: false });
		await ctx.db.insert("chatMessages", { workspaceId, chatId: sales, authorUserId: owner.userId, text: "Acme pricing is $50", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done", searchPublic: true });
		return sales;
	});
	const result = await t.mutation(internal.chatTools.searchFor, { turnId, query: "Acme pricing" });
	expect(result).toHaveProperty("messages");
	if ("messages" in result) expect(result.messages[0]).toMatchObject({ chat: "#sales", text: "Acme pricing is $50" });
	// The returned restricted/public hits retain source tagging. Candidate discovery must not tag unrelated chats.
	const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
	expect((await t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).not.toContain(sales);
});

it("bounds search and activity discovery with 5k joined chats and reports the private search cutoff", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const here = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
	const turnId = await agentTurn(t, owner, here, agentId);
	for (let start = 0; start < 5000; start += 500) await t.run(async (ctx) => {
		for (let i = start; i < start + 500; i++) {
			const chatId = await ctx.db.insert("chats", { workspaceId, kind: "dm", private: true, archived: false, createdBy: owner.userId, lastMessageAt: i });
			const seatId = await ctx.db.insert("chatMembers", { workspaceId, chatId, userId: owner.userId });
			await ctx.db.insert("seatActivity", { workspaceId, chatId, seatId, userId: owner.userId, activityAt: i, restricted: true });
		}
	});
	const result = await t.mutation(internal.chatTools.searchFor, { turnId, query: "needle" });
	expect(result).toMatchObject({ messages: [], notice: expect.stringContaining("50 most recent private chats") });
	expect(await owner.query(api.activity.list, {})).toEqual([]);
	expect(await owner.query(api.activity.recent, {})).toMatchObject({ truncated: true });
});

it("continues past masked replies in a readable channel and reports when its activity budget is exhausted", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const chatId = await owner.mutation(api.chats.createChannel, { name: "shared", private: false });
	await member.mutation(api.chats.join, { chatId });
	const turnId = await agentTurn(t, member, chatId, agentId);
	await t.run(async (ctx) => {
		const publicReply = await ctx.db.insert("chatMessages", { workspaceId, chatId, authorUserId: owner.userId, text: "public", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done", searchPublic: true });
		await ctx.db.insert("agentActivity", { workspaceId, chatId, actorId: owner.userId, agentId, replyId: publicReply, callId: "visible", tool: "chat.search", input: "{}", changes: false, status: "done" });
		const replyId = await ctx.db.insert("chatMessages", { workspaceId, chatId, authorAgentId: agentId, text: "secret", searchPublic: true, parts: [], mentions: { userIds: [], agentIds: [] }, status: "done", usedPlaces: [owner.userId] });
		for (let i = 0; i < 150; i++) await ctx.db.insert("agentActivity", { workspaceId, chatId, actorId: owner.userId, agentId, replyId, callId: `${i}`, tool: "chat.search", input: "{}", changes: false, status: "done" });
	});
	expect(await member.query(api.activity.list, {})).toMatchObject([{ callId: "visible" }]);
	const page = await t.run(async (ctx) => activityPage(ctx, (await memberOf(ctx, member.userId, workspaceId))!, { cursor: null, numItems: 20 }));
	expect(page.page).toEqual([]);
	expect(page.isDone).toBe(false);
	expect(page.continueCursor).toBeTruthy();
	await t.run(async (ctx) => {
		const hidden = await ctx.db.query("agentActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).order("desc").first();
		for (let i = 0; i < 1500; i++) await ctx.db.insert("agentActivity", { workspaceId, chatId, actorId: owner.userId, agentId, replyId: hidden!.replyId, callId: `more-${i}`, tool: "chat.search", input: "{}", changes: false, status: "done" });
	});
	expect(await member.query(api.activity.recent, {})).toMatchObject({ entries: [], truncated: true, budgetExhausted: true });
	expect(await member.query(api.activity.list, {})).toEqual([]);

	// Search masking remains active even in a public channel the actor can read.
	expect(await t.mutation(internal.chatTools.searchFor, { turnId, query: "secret", chat: chatId })).toMatchObject({ messages: [] });
});

it("caps only the top people breakdown while preserving 30k bucket totals", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const month = usageMonth(Date.now());
	const users = await t.run(async (ctx) => {
		const users = [];
		for (let i = 0; i < 120; i++) users.push(await ctx.db.insert("users", { email: `${i}@co.com` }));
		return users;
	});
	for (let start = 0; start < 30000; start += 1000) await t.run(async (ctx) => {
		for (let i = start; i < start + 1000; i++) await ctx.db.insert("usage", { workspaceId, month, userId: users[i % users.length], kind: "chat", model: `model-${i % 250}`, costUsd: i % users.length === 119 ? 2 : 1 });
	});
	const report = await owner.query(api.usage.report, {});
	expect(report).toMatchObject({ total: 30250, truncated: true, personCount: 100, rowCount: 30000 });
	expect(report!.byPerson).toHaveLength(100);
	expect(report!.byPerson[0]).toMatchObject({ id: users[119], costUsd: 500 });
	expect(report!.byKind).toEqual([{ kind: "chat", costUsd: 30250 }]);
});

it("debounces 3 messages in a 500-seat private channel into one bounded update, with no public activity writes", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const publicId = await owner.mutation(api.chats.createChannel, { name: "public-scale", private: false });
	const privateId = await owner.mutation(api.chats.createChannel, { name: "private-scale", private: true });
	const start = Date.now();
	await t.run(async (ctx) => {
		const chats = [(await ctx.db.get("chats", publicId))!, (await ctx.db.get("chats", privateId))!];
		for (let i = 0; i < 499; i++) {
			const userId = await ctx.db.insert("users", { email: `seat${i}@co.com` });
			await addMember(ctx, { workspaceId, userId, role: "member" });
			for (const chat of chats) await addToChat(ctx, chat, { userId });
		}
	});
	const activity = (chatId: typeof publicId) => t.run((ctx) => ctx.db.query("seatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect());
	const post = (chatId: typeof publicId) => t.run(async (ctx) => {
		const chat = (await ctx.db.get("chats", chatId))!;
		const writes = vi.spyOn(ctx.db, "patch");
		const reads = vi.spyOn(ctx.db, "query");
		const jobs = vi.spyOn(ctx.scheduler, "runAfter");
		try {
			await insertMessage(ctx, chat, { authorAgentId: agentId, text: "Team update", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" });
			return { activityWrites: writes.mock.calls.filter(([id]) => ctx.db.normalizeId("seatActivity", id)).length,
				seatWrites: writes.mock.calls.filter(([id]) => ctx.db.normalizeId("chatMembers", id)).length,
				queries: reads.mock.calls.map(([table]) => table), jobs: jobs.mock.calls.length };
		} finally { writes.mockRestore(); reads.mockRestore(); jobs.mockRestore(); }
	});
	vi.useFakeTimers();
	try {
		const before = await activity(publicId);
		expect(before).toHaveLength(500);
		for (const elapsed of [1000, 2000, 3000]) {
			vi.setSystemTime(start + elapsed);
			expect(await post(publicId)).toMatchObject({ activityWrites: 0, seatWrites: 0, jobs: 0 });
		}
		expect(await activity(publicId)).toEqual(before);
		const initial = await activity(privateId);
		for (const elapsed of [4000, 5000, 6000]) {
			vi.setSystemTime(start + elapsed);
			const result = await post(privateId);
			expect(result).toMatchObject({ activityWrites: 0, seatWrites: 0, jobs: elapsed === 4000 ? 1 : 0 });
			if (elapsed > 4000) expect(result.queries).toEqual(["chatActivity"]);
		}
		expect(await activity(privateId)).toEqual(initial);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const updated = await activity(privateId);
		expect(updated).toHaveLength(500);
		expect(updated.every((row) => row.activityAt === start + 6000)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", privateId)).first())).toMatchObject({ activityAt: start + 6000, pendingAt: undefined });
		const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(jobs.filter((job) => job.name === "chatDiscovery:refreshSeats")).toHaveLength(5);
	} finally { vi.useRealTimers(); }
});

it("finds a target DM after a message at T+20s among 51 DMs", async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const agentId = (await agentsOf(owner)).companybot._id;
	const start = Date.now();
	vi.useFakeTimers();
	try {
		const chats = await t.run(async (ctx) => {
			const ids = [];
			for (let i = 0; i < 51; i++) {
				const chatId = await ctx.db.insert("chats", { workspaceId, kind: "dm", private: true, searchPublic: false, archived: false, createdBy: owner.userId, lastMessageAt: start + (i ? 10000 + i : 0) });
				const chat = (await ctx.db.get("chats", chatId))!;
				await addToChat(ctx, chat, { userId: owner.userId });
				await addToChat(ctx, chat, { agentId });
				ids.push(chatId);
			}
			return ids;
		});
		vi.setSystemTime(start + 19000);
		const turnId = await agentTurn(t, owner, chats[50]!, agentId);
		vi.setSystemTime(start + 20000);
		await t.run(async (ctx) => insertMessage(ctx, (await ctx.db.get("chats", chats[0]!))!, { authorAgentId: agentId, text: "needle target", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" }));
		expect(await t.mutation(internal.chatTools.searchFor, { turnId, query: "needle" })).toMatchObject({ messages: [{ text: "needle target" }] });
	} finally { vi.useRealTimers(); }
});
