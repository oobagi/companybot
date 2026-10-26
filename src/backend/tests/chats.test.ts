import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

import { agentsOf, setup as ownerAndMember, noMentions, tick, meOf, generalOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("chats", () => {
	it("puts everyone in #general, which can't be left", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		expect(general).toMatchObject({ name: "general", title: "general", private: false, agentId: null });
		expect(general.members.map((m) => m.type)).toEqual(["user", "user"]);
		expect((await generalOf(member))._id).toBe(general._id);
		await expect(member.mutation(api.chats.leave, { chatId: general._id })).rejects.toThrow("Everyone stays");
	});

	it("shows public channels to everyone and private ones to members only", async () => {
		const { owner, member } = await ownerAndMember();
		const open = await owner.mutation(api.chats.createChannel, { name: "  Sales Team!", private: false });
		const secret = await owner.mutation(api.chats.createChannel, { name: "#Board", private: true });
		expect((await owner.query(api.chats.get, { chatId: open }))?.name).toBe("sales-team");
		expect((await member.query(api.chats.browse)).map((c) => c.name)).toEqual(["sales-team"]);
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();
		await owner.mutation(api.messages.send, { chatId: secret, text: "Q4 numbers", mentions: noMentions });
		expect(await member.query(api.messages.list, { chatId: secret })).toEqual([]);
		await expect(member.mutation(api.messages.send, { chatId: secret, text: "hi", mentions: noMentions })).rejects.toThrow(
			"not found",
		);
		await expect(member.mutation(api.chats.join, { chatId: secret })).rejects.toThrow("not found");

		// Posting in a public channel joins it.
		await member.mutation(api.messages.send, { chatId: open, text: "hello", mentions: noMentions });
		expect((await member.query(api.chats.list))!.channels.map((c) => c.name)).toEqual(["general", "sales-team"]);
		await expect(owner.mutation(api.chats.createChannel, { name: "sales team", private: false })).rejects.toThrow(
			"already exists",
		);
	});

	it("lets members manage only channels they created", async () => {
		const { owner, member } = await ownerAndMember();
		const theirs = await member.mutation(api.chats.createChannel, { name: "design", private: false });
		const ours = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		await member.mutation(api.chats.updateChannel, { chatId: theirs, topic: "Pixels" });
		expect((await member.query(api.chats.get, { chatId: theirs }))?.canManage).toBe(true);
		expect((await member.query(api.chats.get, { chatId: ours }))?.canManage).toBe(false);
		await expect(member.mutation(api.chats.updateChannel, { chatId: ours, name: "x" })).rejects.toThrow("creator or an owner");
		await owner.mutation(api.chats.updateChannel, { chatId: theirs, name: "Design Team" });
		expect(await member.query(api.chats.get, { chatId: theirs })).toMatchObject({ name: "design-team", topic: "Pixels" });
	});

	it("finds an existing DM instead of making another", async () => {
		const { owner, member } = await ownerAndMember();
		const memberId = await meOf(member);
		const ownerId = await meOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		expect(await member.mutation(api.chats.openDm, { userIds: [ownerId, memberId], agentIds: [] })).toBe(dm);
		expect((await member.query(api.chats.get, { chatId: dm }))?.title).toBe("owner@co.com");

		const { companybot } = await agentsOf(owner);
		const agentDm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const list = (await owner.query(api.chats.list))!;
		expect(list.me).toBe(ownerId);
		expect(list.dms.find((d) => d._id === agentDm)).toMatchObject({ agentId: companybot._id, title: "Companybot" });
		expect(list.agents.find((a) => a._id === companybot._id)?.dmId).toBe(agentDm);
		expect(list.agents.find((a) => a.name === "Scribe")?.dmId).toBeNull();
		expect(await member.query(api.chats.get, { chatId: agentDm })).toBeNull();
	});

	it("tracks unread and mentions, and clears them on read", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		await tick();
		await owner.mutation(api.messages.send, { chatId: general._id, text: "hi all", mentions: noMentions });
		expect(await generalOf(member)).toMatchObject({ unread: true, mentioned: false });
		expect(await generalOf(owner)).toMatchObject({ unread: false });
		const memberId = await meOf(member);
		await owner.mutation(api.messages.send, { chatId: general._id, text: "@member look", mentions: { userIds: [memberId], agentIds: [] } });
		expect(await generalOf(member)).toMatchObject({ unread: true, mentioned: true });
		await tick();
		await member.mutation(api.chats.markRead, { chatId: general._id });
		expect(await generalOf(member)).toMatchObject({ unread: false, mentioned: false });
	});

	it("alerts people to unread DMs and mentions, by their notification setting", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden" });
		const general = await generalOf(owner);
		const memberId = await meOf(member);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		await tick();
		await owner.mutation(api.messages.send, { chatId: general._id, text: "hi all", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId: dm, text: "got a sec?", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId: general._id, text: "@member look", mentions: { userIds: [memberId], agentIds: [] } });
		// Plain channel chatter doesn't alert; your own messages never do.
		expect((await member.query(api.chats.alerts))!.map((a) => [a.title, a.text]).sort()).toEqual([
			["Jaden in #general", "@member look"],
			["Jaden", "got a sec?"],
		]);
		expect(await owner.query(api.chats.alerts)).toEqual([]);

		expect((await member.query(api.preferences.get)).notify).toBe("all");
		await member.mutation(api.preferences.update, { notify: "mentions" });
		expect((await member.query(api.chats.alerts))!.map((a) => a.text)).toEqual(["@member look"]);
		await member.mutation(api.preferences.update, { notify: "off" });
		expect(await member.query(api.chats.alerts)).toEqual([]);

		await member.mutation(api.preferences.update, { notify: "all" });
		await tick();
		await member.mutation(api.chats.markRead, { chatId: dm });
		expect((await member.query(api.chats.alerts))!.map((a) => a.text)).toEqual(["@member look"]);
	});

	it("keeps an unread mention, in the dock and the sidebar, however much is said after it", async () => {
		const { t, owner, member } = await ownerAndMember();
		await member.mutation(api.preferences.update, { notify: "mentions" });
		const general = await generalOf(owner);
		const memberId = await meOf(member);
		await tick();
		const mention = await owner.mutation(api.messages.send, {
			chatId: general._id,
			text: "@member look",
			mentions: { userIds: [memberId], agentIds: [] },
		});
		for (let i = 0; i < 60; i++) await owner.mutation(api.messages.send, { chatId: general._id, text: `chatter ${i}`, mentions: noMentions });
		const workspaceId = await t.run(async (ctx) => (await ctx.db.get(general._id))!.workspaceId);
		expect(await member.query(api.chats.alerts)).toEqual([
			{ workspaceId, chatId: general._id, messageId: mention, title: "owner@co.com in #general", text: "@member look" },
		]);
		expect((await generalOf(member)).mentioned).toBe(true);

		// A deleted mention is gone from both.
		await owner.mutation(api.messages.remove, { messageId: mention });
		expect(await member.query(api.chats.alerts)).toEqual([]);
		expect((await generalOf(member)).mentioned).toBe(false);
	});
});

describe("messages", () => {
	it("threads, edits, deletes, and toggles reactions", async () => {
		const { owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan?", mentions: noMentions });
		await member.mutation(api.messages.send, { chatId, threadId: parent, text: "Yes", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, threadId: parent, text: "Good", mentions: noMentions });
		const [top] = await owner.query(api.messages.list, { chatId });
		expect(top).toMatchObject({ text: "Plan?", replyCount: 2, mine: true });
		expect(top!.replyAuthors.map((a) => a.name)).toEqual(["owner@co.com", "member@co.com"]);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.text)).toEqual([
			"Plan?",
			"Yes",
			"Good",
		]);

		await owner.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		await member.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		let [m] = await member.query(api.messages.list, { chatId });
		expect(m!.reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["owner@co.com", "member@co.com"] }]);
		await member.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		[m] = await member.query(api.messages.list, { chatId });
		expect(m!.reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["owner@co.com"] }]);

		await expect(member.mutation(api.messages.edit, { messageId: parent, text: "x" })).rejects.toThrow("your own");
		await owner.mutation(api.messages.edit, { messageId: parent, text: "Plan!" });
		expect((await owner.query(api.messages.list, { chatId }))[0]?.editedAt).not.toBeNull();
		await owner.mutation(api.messages.remove, { messageId: parent });
		expect((await owner.query(api.messages.list, { chatId }))[0]).toMatchObject({ deleted: true, text: "", parts: [], replyCount: 2 });
	});
});
