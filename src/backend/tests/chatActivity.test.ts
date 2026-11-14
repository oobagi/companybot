import { MESSAGE_PAGE, defaultModel } from "@companybot/core";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ACTIVE_THREADS_PER_CHANNEL } from "../convex/chats";
import { agentTurn, agentsOf, finishTurn, generalOf, noMentions, ownerAndMember, settle, tick } from "./helpers";

afterEach(() => void vi.useRealTimers());

const usageOf = (costUsd: number) => ({ model: defaultModel, steps: 1, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, contextTokens: 100, costUsd, durationMs: 900 });

// The chat row is what the sidebar, channel browser, permission checks and every chat screen read. A message
// or an agent's spend moves only its activity, so none of those re-run for it.
it("leaves the chat itself unchanged when people post and agents spend, while unread and running cost still move", async () => {
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const chatId = (await generalOf(owner))._id;
	await owner.mutation(api.chats.markRead, { chatId });
	const before = await t.run((ctx) => ctx.db.get(chatId));
	await tick();
	await member.mutation(api.messages.send, { chatId, text: "Morning", mentions: noMentions });
	const turnId = await agentTurn(t, member, chatId, companybot._id);
	await finishTurn(t, turnId, "Morning to you", { usage: usageOf(0.02) });
	expect(await t.run((ctx) => ctx.db.get(chatId))).toEqual(before);
	expect((await owner.query(api.chats.list))!.channels.find((c) => c._id === chatId)).toMatchObject({ unread: true });
	expect((await owner.query(api.chats.place, { chatId }))!.costUsd).toBeCloseTo(0.02);
});

it("pages a thread from its newest replies, its parent on the first page only", async () => {
	const { owner } = await ownerAndMember();
	const chatId = (await generalOf(owner))._id;
	const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan?", mentions: noMentions });
	const replies: Id<"chatMessages">[] = [];
	for (let i = 0; i < 5; i++) replies.push(await owner.mutation(api.messages.send, { chatId, threadId: parent, text: `Reply ${i}`, mentions: noMentions }));
	const page = (cursor: string | null) => owner.query(api.messages.page, { chatId, threadId: parent, paginationOpts: { numItems: 3, cursor } });
	const first = await page(null);
	expect(first.page.map((m) => m._id)).toEqual([parent, ...replies.slice(2)]);
	const older = await page(first.continueCursor);
	expect(older.page.map((m) => m._id)).toEqual(replies.slice(0, 2));
	expect(older.isDone).toBe(true);
});

it("shows each channel's newest threads in the sidebar, so one busy channel can't crowd out the rest", async () => {
	const { owner, member } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const other = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
	await member.mutation(api.chats.join, { chatId: other });
	const quiet = await owner.mutation(api.messages.send, { chatId: other, text: "Checklist", mentions: noMentions });
	await owner.mutation(api.messages.send, { chatId: other, threadId: quiet, text: "Done", mentions: noMentions });
	const busy: Id<"chatMessages">[] = [];
	for (let i = 0; i < ACTIVE_THREADS_PER_CHANNEL + 2; i++) {
		await tick();
		const id = await owner.mutation(api.messages.send, { chatId: general, text: `Topic ${i}`, mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId: general, threadId: id, text: "Reply", mentions: noMentions });
		busy.push(id);
	}
	const threads = await member.query(api.chats.activeThreads, { now: Date.now() });
	expect(threads.map((x) => x.messageId)).toEqual([...busy.slice(2).reverse(), quiet]);
});

it("puts a reply shown late on the newest page, however many messages came in while it was quiet", async () => {
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const chatId = (await generalOf(owner))._id;
	const turnId = await agentTurn(t, owner, chatId, companybot._id);
	const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
	for (let i = 0; i < MESSAGE_PAGE + 5; i++, vi.setSystemTime(Date.now() + 10)) await member.mutation(api.messages.send, { chatId, text: `Meanwhile ${i}`, mentions: noMentions });
	const newest = async () => (await member.query(api.messages.page, { chatId, paginationOpts: { numItems: MESSAGE_PAGE, cursor: null } })).page.map((m) => m._id);
	expect(await newest()).not.toContain(replyId);
	// The clock moves without running the turn's scheduled runner: this test ends the turn itself.
	vi.setSystemTime(Date.now() + 1_000);
	await finishTurn(t, turnId, "Here's the plan");
	expect((await newest()).at(-1)).toBe(replyId);
});

it("keeps a channel's activity through Trash and restore, and deletes it with the channel or the workspace", async () => {
	const { t, owner } = await ownerAndMember();
	const activity = (chatId: Id<"chats">) => t.run((ctx) => ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).unique());
	const chatId = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
	await owner.mutation(api.messages.send, { chatId, text: "Kickoff", mentions: noMentions });
	const kept = await activity(chatId);
	expect(kept).not.toBeNull();
	await owner.mutation(api.trash.move, { kind: "channel", id: chatId });
	await owner.mutation(api.trash.restore, { kind: "channel", id: chatId });
	expect(await activity(chatId)).toEqual(kept);
	expect((await owner.query(api.chats.list))!.channels.find((c) => c._id === chatId)!.lastMessageAt).toBe(kept!.lastMessageAt);
	await owner.mutation(api.trash.move, { kind: "channel", id: chatId });
	await owner.mutation(api.trash.purge, { id: chatId });
	await settle(t);
	expect(await activity(chatId)).toBeNull();
	const general = (await generalOf(owner))._id;
	expect(await activity(general)).not.toBeNull();
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.query("chatActivity").collect())).toEqual([]);
});
