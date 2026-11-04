import { defaultModel } from "@companybot/core";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ACTIVE_THREADS_PER_CHANNEL } from "../convex/chats";
import { agentTurn, agentsOf, finishTurn, generalOf, noMentions, ownerAndMember, tick } from "./helpers";

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
	const page = (cursor: string | null) => owner.query(api.messages.list, { chatId, threadId: parent, paginationOpts: { numItems: 3, cursor } });
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
