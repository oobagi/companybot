import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

import { agentsOf, ownerAndMember, noMentions, tick, generalOf, turnsOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("chats", () => {
	it("puts everyone in #general, which can't be left", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		expect(general).toMatchObject({ name: "general", title: "general", private: false, agentId: null });
		// Companybot joined to welcome the owner.
		expect(general.members.map((m) => m.type)).toEqual(["user", "agent", "user"]);
		expect((await generalOf(member))._id).toBe(general._id);
		await expect(member.mutation(api.chats.leave, { chatId: general._id })).rejects.toThrow("You can't leave");
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

	it("removes people from a channel only for its managers, and never from #general", async () => {
		const { owner, member } = await ownerAndMember();
		const [ownerId, memberId] = [owner.userId, member.userId];
		const ops = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		await member.mutation(api.chats.join, { chatId: ops });
		const theirs = await member.mutation(api.chats.createChannel, { name: "design", private: false });
		await owner.mutation(api.chats.join, { chatId: theirs });
		const people = async (chatId: typeof ops) => (await owner.query(api.chats.get, { chatId }))!.members.map((m) => m.id);
		// Not their channel: refused, and nothing changes.
		await expect(member.mutation(api.chats.removeMember, { chatId: ops, userId: ownerId })).rejects.toThrow("creator or an owner");
		expect(await people(ops)).toContain(ownerId);
		// The creator removes from theirs; owners from any.
		await member.mutation(api.chats.removeMember, { chatId: theirs, userId: ownerId });
		expect(await people(theirs)).not.toContain(ownerId);
		await owner.mutation(api.chats.removeMember, { chatId: ops, userId: memberId });
		expect(await people(ops)).not.toContain(memberId);
		const general = await generalOf(owner);
		await expect(owner.mutation(api.chats.removeMember, { chatId: general._id, userId: memberId })).rejects.toThrow("can't be removed");
	});

	it("finds an existing DM instead of making another", async () => {
		const { owner, member } = await ownerAndMember();
		const memberId = member.userId;
		const ownerId = owner.userId;
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

	it("keeps side chats with an agent under its DM: titled by the first message, renamable, trashable", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const side = await owner.mutation(api.chats.createSideChat, { parentId: dm });
		expect(side).not.toBe(dm);
		// The DM stays the agent's primary chat; the side chat lists under it without a title yet.
		let list = (await owner.query(api.chats.list))!;
		expect(list.agents.find((a) => a._id === companybot._id)?.dmId).toBe(dm);
		expect(list.dms.find((d) => d._id === side)).toMatchObject({ parentId: dm, label: "New chat", agentId: companybot._id, title: "Companybot" });
		expect(await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] })).toBe(dm);
		// Writing in it names it after the first line and starts the agent's turn, as in the DM itself.
		const before = await turnsOf(t);
		await owner.mutation(api.messages.send, { chatId: side, text: "Draft the Q3 plan\nwith three goals", mentions: noMentions });
		expect((await turnsOf(t)).length).toBe(before.length + 1);
		expect((await owner.query(api.chats.list))!.dms.find((d) => d._id === side)?.label).toBe("Draft the Q3 plan");
		await owner.mutation(api.chats.renameChat, { chatId: side, title: "  Q3 plan  " });
		expect((await owner.query(api.chats.get, { chatId: side }))?.label).toBe("Q3 plan");
		await expect(owner.mutation(api.chats.renameChat, { chatId: dm, title: "x" })).rejects.toThrow("side chat");
		// Only under an agent DM, only one level deep, and only yours.
		await expect(owner.mutation(api.chats.createSideChat, { parentId: side })).rejects.toThrow("under a DM");
		await expect(member.mutation(api.chats.createSideChat, { parentId: dm })).rejects.toThrow();
		const peopleDm = await owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [] });
		await expect(owner.mutation(api.chats.createSideChat, { parentId: peopleDm })).rejects.toThrow("under a DM");
		// Trash takes it like a channel, under its title; restoring brings it back under the DM.
		await owner.mutation(api.trash.move, { kind: "channel", id: side });
		list = (await owner.query(api.chats.list))!;
		expect(list.dms.find((d) => d._id === side)).toBeUndefined();
		expect((await owner.query(api.trash.list, { paginationOpts: { numItems: 10, cursor: null } })).page).toContainEqual(expect.objectContaining({ itemId: side, name: "Q3 plan" }));
		await expect(owner.mutation(api.messages.send, { chatId: side, text: "hi", mentions: noMentions })).rejects.toThrow("Archive");
		await owner.mutation(api.trash.restore, { kind: "channel", id: side });
		expect((await owner.query(api.chats.list))!.dms.find((d) => d._id === side)).toMatchObject({ parentId: dm, label: "Q3 plan" });
		// A newer side chat lists after the older one, whatever was written where; DMs come first.
		await tick();
		const later = await owner.mutation(api.chats.createSideChat, { parentId: dm });
		await owner.mutation(api.messages.send, { chatId: side, text: "again", mentions: noMentions });
		expect((await owner.query(api.chats.list))!.dms.map((d) => d._id)).toEqual([peopleDm, dm, side, later]);
	});

	it("tracks unread and mentions, and clears them on read", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		await tick();
		await owner.mutation(api.messages.send, { chatId: general._id, text: "hi all", mentions: noMentions });
		expect(await generalOf(member)).toMatchObject({ unread: true, mentioned: false });
		expect(await generalOf(owner)).toMatchObject({ unread: false });
		const memberId = member.userId;
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
		const memberId = member.userId;
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
		const memberId = member.userId;
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

	it("alerts a mention in a thread, pointing at the thread, and reading the chat clears it", async () => {
		const { owner, member } = await ownerAndMember();
		await member.mutation(api.preferences.update, { notify: "mentions" });
		const general = await generalOf(owner);
		const memberId = member.userId;
		const parent = await owner.mutation(api.messages.send, { chatId: general._id, text: "topic", mentions: noMentions });
		await tick();
		await member.mutation(api.chats.markRead, { chatId: general._id });
		await tick();
		// A thread reply doesn't make the chat unread, but a mention in one still reaches you.
		await owner.mutation(api.messages.send, { chatId: general._id, threadId: parent, text: "plain reply", mentions: noMentions });
		expect(await generalOf(member)).toMatchObject({ unread: false, mentioned: false });
		expect(await member.query(api.chats.alerts)).toEqual([]);
		const reply = await owner.mutation(api.messages.send, {
			chatId: general._id,
			threadId: parent,
			text: "@member in here",
			mentions: { userIds: [memberId], agentIds: [] },
		});
		expect(await generalOf(member)).toMatchObject({ unread: false, mentioned: true });
		expect((await member.query(api.chats.alerts))!.map((a) => [a.messageId, a.threadId, a.text])).toEqual([[reply, parent, "@member in here"]]);
		await tick();
		await member.mutation(api.chats.markRead, { chatId: general._id });
		expect((await generalOf(member)).mentioned).toBe(false);
		expect(await member.query(api.chats.alerts)).toEqual([]);
	});
});

describe("messages", () => {
	it("lists active threads for the sidebar: recent replies by the workspace's window, newest first, parents' first lines", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const quiet = await owner.mutation(api.messages.send, { chatId, text: "No replies here", mentions: noMentions });
		const plan = await owner.mutation(api.messages.send, { chatId, text: "Plan for Q3?\nDetails below", mentions: noMentions });
		const lunch = await member.mutation(api.messages.send, { chatId, text: "Lunch?", mentions: noMentions });
		await member.mutation(api.messages.send, { chatId, threadId: plan, text: "Yes", mentions: noMentions });
		await tick();
		await owner.mutation(api.messages.send, { chatId, threadId: lunch, text: "Sure", mentions: noMentions });
		expect((await member.query(api.chats.activeThreads, { now: Date.now() })).map((x) => [x.messageId, x.title])).toEqual([
			[lunch, "Lunch?"],
			[plan, "Plan for Q3?"],
		]);
		expect(await member.query(api.chats.activeThreads, { now: Date.now() })).not.toContainEqual(expect.objectContaining({ messageId: quiet }));
		// Threads older than the window (3 days until an owner changes it) drop off; a deleted parent keeps its thread listed under a stand-in title.
		await t.run((ctx) => ctx.db.patch(plan, { lastReplyAt: Date.now() - 4 * 24 * 60 * 60 * 1000 }));
		await member.mutation(api.messages.remove, { messageId: lunch });
		expect((await member.query(api.chats.activeThreads, { now: Date.now() })).map((x) => x.title)).toEqual(["Deleted message"]);
		// A week keeps it; an hour drops the other too. Only the listed windows are allowed, and only owners set it.
		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings.threadHours).toBe(72);
		await expect(owner.mutation(api.workspace.updateSettings, { name: settings.name, threadHours: 48, expectedVersion: settings.version })).rejects.toThrow("hours");
		await expect(member.mutation(api.workspace.updateSettings, { name: settings.name, threadHours: 168, expectedVersion: settings.version })).rejects.toThrow();
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, threadHours: 168, expectedVersion: settings.version });
		expect((await member.query(api.chats.activeThreads, { now: Date.now() })).map((x) => x.title)).toEqual(["Deleted message", "Plan for Q3?"]);
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, threadHours: 1, expectedVersion: settings.version + 1 });
		expect(await member.query(api.chats.activeThreads, { now: Date.now() + 2 * 60 * 60 * 1000 })).toEqual([]);
		// Forever keeps every thread that has a reply, however old; one with none still isn't a thread.
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, threadHours: 0, expectedVersion: settings.version + 2 });
		await t.run((ctx) => ctx.db.patch(plan, { lastReplyAt: Date.now() - 400 * 24 * 60 * 60 * 1000 }));
		expect((await member.query(api.chats.activeThreads, { now: Date.now() })).map((x) => x.title)).toEqual(["Deleted message", "Plan for Q3?"]);
	});

	it("threads, edits, deletes, and toggles reactions", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan?", mentions: noMentions });
		await member.mutation(api.messages.send, { chatId, threadId: parent, text: "Yes", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, threadId: parent, text: "Good", mentions: noMentions });
		const [top] = await owner.query(api.messages.list, { chatId });
		expect(top).toMatchObject({ text: "Plan?", replyCount: 2, mine: true });
		expect(top!.replyAuthors.map((a) => a.name)).toEqual(["owner@co.com", "member@co.com"]);
		// A thread from before authors were stored reads its replies, and its next reply stores them all.
		await t.run((ctx) => ctx.db.patch(parent, { replyAuthors: undefined }));
		expect((await owner.query(api.messages.list, { chatId }))[0]!.replyAuthors.map((a) => a.name)).toEqual(["owner@co.com", "member@co.com"]);
		await member.mutation(api.messages.send, { chatId, threadId: parent, text: "Ok", mentions: noMentions });
		expect((await t.run((ctx) => ctx.db.get(parent)))!.replyAuthors).toHaveLength(2);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.text)).toEqual([
			"Plan?",
			"Yes",
			"Good",
			"Ok",
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
		expect((await owner.query(api.messages.list, { chatId }))[0]).toMatchObject({ deleted: true, text: "", parts: [], replyCount: 3 });
	});
});
