import { seedSkill } from "./legacyFixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageTool } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import { builtInRoleOf, agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, sideWorkspace, setMemberSwitch, messagesIn, signIn } from "./helpers";
import type { Id } from "../convex/_generated/dataModel";

afterEach(() => vi.useRealTimers());

async function ready() {
	vi.useFakeTimers();
	const { t, owner, member } = await ownerAndMember();
	const { companybot, scribe } = await agentsOf(owner);
	const chat = await generalOf(owner);
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const memberDm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const turnId = await agentTurn(t, owner, dm, companybot._id);
	const memberTurn = await agentTurn(t, member, memberDm, companybot._id);
	const call = (tool: ManageTool, request: unknown, asMember = false): Promise<any> =>
		t.mutation(internal.manageTools.runFor, { turnId: asMember ? memberTurn : turnId, tool, input: { request } });
	return { t, owner, member, companybot, scribe, chat, turnId, memberTurn, call };
}

const config = { name: "Review", prompt: "Review work", trigger: { type: "schedule" as const, cron: "0 8 * * 1" } };
const skill = { name: "Procedure", description: "Use for work", instructions: "Review it." };

describe("messaging and channels as the person", () => {
	it("trashes channels as their manager, with agent attribution, never DMs or general", async () => {
		const { t, call, owner, member, chat } = await ready();
		const id = await member.mutation(api.chats.createChannel, { name: "disposable", private: false });
		expect(await call("channels.manage", { action: "delete", chat: id }, true)).toMatchObject({ done: "delete", chatId: id });
		expect((await member.query(api.trash.list, { paginationOpts: { numItems: 50, cursor: null } })).page[0]).toMatchObject({ itemId: id, agent: "Companybot" });
		const other = await owner.mutation(api.chats.createChannel, { name: "owner-channel", private: false });
		await setMemberSwitch(owner, "channels.edit", false);
		expect(await call("channels.manage", { action: "delete", chat: other }, true)).toMatchObject({ error: expect.stringContaining("Only people with the Owner role") });
		await setMemberSwitch(owner, "channels.edit", true);
		expect(await call("channels.manage", { action: "delete", chat: chat._id })).toHaveProperty("error");
		const dm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [] });
		expect(await call("channels.manage", { action: "delete", chat: dm }, true)).toHaveProperty("error");
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ archived: true });
		expect(await call("channels.manage", { action: "restore", chat: id }, true)).toMatchObject({ done: "restore" });
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ archived: false });
		await call("channels.manage", { action: "delete", chat: id }, true);
		const replacement = await member.mutation(api.chats.createChannel, { name: "disposable", private: false });
		expect(await call("channels.manage", { action: "get", chat: "#disposable" }, true)).toMatchObject({ id: replacement });
	});

	it("discovers people/agents/invites, chats and channel metadata with paging", async () => {
		const { call, owner, companybot, chat } = await ready();
		expect((await call("chat.manage", { action: "find_people" })).page).toEqual(
			expect.arrayContaining([expect.objectContaining({ userId: owner.userId, roles: ["Owner"] })]),
		);
		expect((await call("chat.manage", { action: "find_people", kind: "agents" })).page).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: companybot._id })]),
		);
		expect((await call("chat.manage", { action: "find_people", kind: "invites" })).page).toEqual([]);
		expect(await call("chat.manage", { action: "find_people", kind: "invites" }, true)).toHaveProperty("error");
		expect((await call("chat.manage", { action: "list_chats" })).page).toEqual(expect.arrayContaining([expect.objectContaining({ id: chat._id })]));
		expect((await call("channels.manage", { action: "list" })).page).toEqual(expect.arrayContaining([expect.objectContaining({ id: chat._id })]));
		expect(await call("channels.manage", { action: "get", chat: chat._id })).toMatchObject({ name: "general", page: expect.any(Array), isDone: true });
	});

	it("opens a deterministic DM and sends to a channel, thread or DM with agent attribution, without triggering turns", async () => {
		const { t, call, owner, member, companybot, chat, turnId } = await ready();
		const r = { action: "open_dm", userIds: [member.userId], agentIds: [] };
		const { chatId } = await call("chat.manage", r);
		expect(await call("chat.manage", r)).toMatchObject({ chatId, note: "Opened owner@co.com's DM with member@co.com. What you send there shows as from you, for them." });
		const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
		const parent = await owner.mutation(api.messages.send, { chatId: chat._id, text: "Parent", mentions: noMentions });
		// A write names its chat by id or "here", never by #name: a rename can hand a name to another channel.
		expect(await call("chat.manage", { action: "send", chat: "#general", text: "Delivered" })).toEqual({ error: expect.stringContaining("by its id or \"here\"") });
		for (const destination of [{ chat: chat._id }, { chat: chat._id, threadId: parent }, { chat: chatId }]) {
			const { messageId } = await call("chat.manage", {
				action: "send",
				...destination,
				text: "Delivered",
				agentIds: [companybot._id],
				userIds: [member.userId],
			});
			expect(await t.run((ctx) => ctx.db.get(messageId as Id<"chatMessages">))).toMatchObject({
				authorAgentId: companybot._id,
				actingFor: owner.userId,
				text: "Delivered",
			});
		}
		expect(await t.run((ctx) => ctx.db.query("agentTurns").collect())).toHaveLength(before.length);
		const lines = await messagesIn(owner, { chatId });
		expect(lines.at(-1)!.author).toMatchObject({ name: "Companybot", for: { type: "user", id: owner.userId } });
		// "DM me": with nobody but the person, it's the agent's own DM with them, not a DM with themselves.
		for (const userIds of [[], [owner.userId]]) {
			const own = await call("chat.manage", { action: "open_dm", userIds, agentIds: [] });
			expect(await t.run((ctx) => ctx.db.get(own.chatId as Id<"chats">))).toMatchObject({ dmKey: `a:${companybot._id},u:${owner.userId}` });
		}
		// To the person alone, it's the agent talking, not the agent as them; it can still edit what it wrote.
		const own = await call("chat.manage", { action: "open_dm", userIds: [], agentIds: [] });
		// From a turn in #general: the DM's own turn replies instead (it can't send where it's replying).
		const elsewhere = await agentTurn(t, owner, chat._id, companybot._id);
		const fromGeneral = (request: unknown): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId: elsewhere, tool: "chat.manage", input: { request } });
		const { messageId: toYou } = await fromGeneral({ action: "send", chat: own.chatId, text: "Surprise" });
		expect(await fromGeneral({ action: "send", chat: own.chatId, text: "Again" })).toMatchObject({ chatId: own.chatId, messageId: expect.any(String) });
		const sent = await t.run((ctx) => ctx.db.get(toYou as Id<"chatMessages">));
		expect(sent).toMatchObject({ authorAgentId: companybot._id, text: "Surprise" });
		expect(sent!.actingFor).toBeUndefined();
		expect(await fromGeneral({ action: "edit", messageId: toYou, text: "Surprise!" })).toMatchObject({ done: "edit" });
		expect((await messagesIn(owner, { chatId: own.chatId as Id<"chats"> })).at(-1)!.author).toEqual(expect.not.objectContaining({ for: expect.anything() }));
		expect(await t.mutation(internal.chatTools.readFor, { turnId, chat: chatId })).toHaveProperty("messages");
		expect(await call("chat.manage", { action: "send", chat: chatId, threadId: parent, text: "Wrong parent" })).toHaveProperty("error");
	});

	it("posts for the person where the turn is replying, and says so, so the reply doesn't repeat it", async () => {
		const { t, call, owner, turnId } = await ready();
		const { chatId } = (await t.run((ctx) => ctx.db.get(turnId as Id<"agentTurns">)))!;
		const sent = await call("chat.manage", { action: "send", chat: chatId, text: "Here" });
		expect(sent).toMatchObject({ messageId: expect.any(String), note: expect.stringContaining("Don't repeat") });
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Parent", mentions: noMentions });
		expect(await call("chat.manage", { action: "send", chat: chatId, threadId: parent, text: "In its thread" })).not.toHaveProperty("note");
	});

	// #table-1: asked to deal private hands to Pip, Marlowe and Roxy, Companybot opened the person's DM with each
	// agent and posted there as itself: no agent saw a card, and the person read every hand.
	it("never opens or posts in a person's DM with another agent, and says where each DM and post went", async () => {
		const { t, call, owner, member, companybot, scribe, chat } = await ready();
		const turn = await agentTurn(t, owner, chat._id, companybot._id);
		const fromGeneral = (request: unknown): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId: turn, tool: "chat.manage", input: { request } });
		for (const r of [{ userIds: [], agentIds: [scribe._id] }, { userIds: [member.userId], agentIds: [scribe._id] }, { userIds: [], agentIds: [companybot._id, scribe._id] }]) {
			expect(await fromGeneral({ action: "open_dm", ...r })).toEqual({ error: expect.stringContaining("Agents don't have DMs with each other") });
		}
		// Not by id either: the person's DM with Scribe, and a group DM Scribe is in, are Scribe's.
		const scribeDm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		const scribeGroup = await owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [scribe._id] });
		for (const id of [scribeDm, scribeGroup]) {
			expect(await fromGeneral({ action: "send", chat: id, text: "Your hand: 5♦ 4♦" })).toEqual({ error: expect.stringContaining("chat_ask_agent") });
			expect(await messagesIn(owner, { chatId: id })).toEqual([]);
		}
		// Its own DMs and the person's DMs with people still work, and each result says where it went.
		const own = await fromGeneral({ action: "open_dm", userIds: [], agentIds: [companybot._id] });
		expect(own.note).toBe("Opened your own DM with owner@co.com: what you send there is from you.");
		expect(await fromGeneral({ action: "send", chat: own.chatId, text: "Your hand" })).toMatchObject({ posted: "Posted in your own DM with owner@co.com." });
		const people = await fromGeneral({ action: "open_dm", userIds: [member.userId], agentIds: [] });
		expect(await fromGeneral({ action: "send", chat: people.chatId, text: "Hi" })).toMatchObject({ posted: "Posted in owner@co.com's DM with member@co.com, as you for them." });
		const group = await fromGeneral({ action: "open_dm", userIds: [member.userId], agentIds: [companybot._id] });
		expect(group.note).toBe("Opened a group DM with owner@co.com, member@co.com and you. What you send there shows as from you, for them.");
		expect(await fromGeneral({ action: "send", chat: group.chatId, text: "Hi all" })).toMatchObject({ posted: "Posted in a group DM with owner@co.com, member@co.com and you, as you for them." });
		const other = await owner.mutation(api.chats.createChannel, { name: "table-1", private: false });
		expect(await fromGeneral({ action: "send", chat: other, text: "Flop" })).toMatchObject({ posted: "Posted in #table-1, as you for them." });
	});

	it("posting or opening a DM isn't reading it: only a read makes the reply private", async () => {
		const { t, owner, member, companybot, chat } = await ready();
		const turn = await agentTurn(t, owner, chat._id, companybot._id);
		const fromGeneral = (request: unknown): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId: turn, tool: "chat.manage", input: { request } });
		const replyId = (await t.run((ctx) => ctx.db.get(turn as Id<"agentTurns">)))!.replyId!;
		const ops = await owner.mutation(api.chats.createChannel, { name: "ops", private: true });
		const own = await fromGeneral({ action: "open_dm", userIds: [], agentIds: [] });
		const people = await fromGeneral({ action: "open_dm", userIds: [member.userId], agentIds: [] });
		const sent: string[] = [];
		for (const id of [own.chatId, people.chatId, ops]) sent.push((await fromGeneral({ action: "send", chat: id, text: "Dealt" })).messageId);
		expect((await t.run((ctx) => ctx.db.get(replyId as Id<"chatMessages">)))!.usedPlaces ?? []).toEqual([]);
		// What it posted carries only what the turn read (nothing private), not the places it posted in.
		for (const id of sent) expect((await t.run((ctx) => ctx.db.get(id as Id<"chatMessages">)))!.usedPlaces).toBeUndefined();
		await t.mutation(internal.turns.updateReply, { turnId: turn, text: "Dealt everyone in.", parts: [{ type: "text", text: "Dealt everyone in." }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn });
		expect((await messagesIn(member, { chatId: chat._id })).find((m) => m._id === replyId)).toMatchObject({ text: "Dealt everyone in.", privacy: null });

		// Reading still counts: a DM and a private channel it reads make its next reply private.
		const next = await agentTurn(t, owner, chat._id, companybot._id);
		const nextReply = (await t.run((ctx) => ctx.db.get(next as Id<"agentTurns">)))!.replyId!;
		await t.mutation(internal.chatTools.readFor, { turnId: next, chat: people.chatId });
		await t.mutation(internal.chatTools.readFor, { turnId: next, chat: ops });
		expect((await t.run((ctx) => ctx.db.get(nextReply as Id<"chatMessages">)))!.usedPlaces).toEqual(expect.arrayContaining([people.chatId, ops]));
		await t.mutation(internal.turns.updateReply, { turnId: next, text: "Secret", parts: [{ type: "text", text: "Secret" }] });
		await t.mutation(internal.turns.finishReply, { turnId: next });
		expect((await messagesIn(member, { chatId: chat._id })).find((m) => m._id === nextReply)).toMatchObject({ privacy: { hidden: true } });
	});

	it("names a private reply's audience once, and shows no lock where everyone can already see its sources", async () => {
		const { t, owner, member, companybot, scribe, chat, turnId } = await ready();
		const read = async (turnId: Id<"agentTurns">, chatIds: Id<"chats">[]) => {
			for (const id of chatIds) await t.mutation(internal.chatTools.readFor, { turnId, chat: id });
			await t.mutation(internal.turns.updateReply, { turnId, text: "Read", parts: [{ type: "text", text: "Read" }] });
			await t.mutation(internal.turns.finishReply, { turnId });
			return (await t.run((ctx) => ctx.db.get(turnId)))!.replyId!;
		};
		const own = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const scribeDm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		await owner.mutation(api.messages.send, { chatId: scribeDm, text: "Mine", mentions: noMentions });
		// Two of the owner's one-person DMs, read in #general: one name, not "owner and owner".
		const inGeneral = await read(await agentTurn(t, owner, chat._id, companybot._id), [own, scribeDm]);
		const shown = (await messagesIn(owner, { chatId: chat._id })).find((m) => m._id === inGeneral)!;
		expect(shown.privacy).toMatchObject({ hidden: false, label: "Only owner@co.com can see this", share: expect.any(String) });
		expect(shown.privacy!.why).toBe("Uses a private conversation");
		// In their own DM, they're the only one who can see it either way: no lock, no Share.
		const inOwn = await read(turnId, [scribeDm]);
		expect((await messagesIn(owner, { chatId: own })).find((m) => m._id === inOwn)!.privacy).toBeNull();
		// With someone else in the chat, it stays locked to them.
		const group = await owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [companybot._id] });
		const inGroup = await read(await agentTurn(t, owner, group, companybot._id), [scribeDm]);
		expect((await messagesIn(owner, { chatId: group })).find((m) => m._id === inGroup)!.privacy).toMatchObject({ hidden: false, label: "Only owner@co.com can see this" });
		expect((await messagesIn(member, { chatId: group })).find((m) => m._id === inGroup)!.privacy).toMatchObject({ hidden: true });
	});

	it("says where a sent message went to whoever can see that chat, and nothing more to anyone else", async () => {
		const { t, owner, member, companybot, chat } = await ready();
		await owner.mutation(api.workspace.invite, { email: "dana@co.com", roles: [await builtInRoleOf(owner, "member")] });
		const dana = await signIn(t, "dana@co.com");
		const turn = await agentTurn(t, owner, chat._id, companybot._id);
		const fromGeneral = (request: unknown): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId: turn, tool: "chat.manage", input: { request } });
		const people = await fromGeneral({ action: "open_dm", userIds: [member.userId], agentIds: [] });
		const own = await fromGeneral({ action: "open_dm", userIds: [], agentIds: [] });
		const places = [people.chatId, own.chatId, chat._id];
		const sends: { messageId: Id<"chatMessages"> }[] = [];
		for (const id of places) sends.push(await fromGeneral({ action: "send", chat: id, text: "Dealt" }));
		const line = (i: number) => ({ type: "tool" as const, id: `c${i}`, name: "chat_manage", label: "Post in a chat", status: "done" as const, opens: { chatId: places[i]!, messageId: sends[i]!.messageId, kind: "message" as const } });
		const parts = [line(0), line(1), line(2), { type: "text" as const, text: "Dealt." }];
		await t.mutation(internal.turns.updateReply, { turnId: turn, text: "Dealt.", parts });
		await t.mutation(internal.turns.finishReply, { turnId: turn });
		const replyId = (await t.run((ctx) => ctx.db.get(turn as Id<"agentTurns">)))!.replyId!;
		const labels = async (as: typeof owner) => (await messagesIn(as, { chatId: chat._id })).find((m) => m._id === replyId)!.parts.flatMap((p) => (p.type === "tool" ? [p.label] : []));
		expect(await labels(owner)).toEqual(["Post in your DM with member@co.com", "Send you a DM", "Post in #general"]);
		expect(await labels(member)).toEqual(["Post in your DM with owner@co.com", "Post in a chat", "Post in #general"]);
		expect(await labels(dana)).toEqual(["Post in a chat", "Post in a chat", "Post in #general"]);
	});

	it("creates, renames, clears topic, adds/removes members and joins/leaves via the UI's rules", async () => {
		const { call, member, owner } = await ready();
		const { chatId } = await call("channels.manage", { action: "create", name: "Project room", topic: "Plans", private: false }, true);
		expect(await call("channels.manage", { action: "rename", chat: chatId, name: "plans" }, true)).toMatchObject({ done: "rename" });
		await call("channels.manage", { action: "set_topic", chat: chatId, topic: "" }, true);
		await call("channels.manage", { action: "add_members", chat: chatId, userIds: [owner.userId], agentIds: [] }, true);
		expect((await call("channels.manage", { action: "get", chat: chatId })).page).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: owner.userId })]),
		);
		await call("channels.manage", { action: "remove_member", chat: chatId, userId: owner.userId }, true);
		await call("channels.manage", { action: "join", chat: chatId });
		await call("channels.manage", { action: "leave", chat: chatId });
		expect((await call("channels.manage", { action: "get", chat: chatId })).page).toEqual([expect.objectContaining({ id: member.userId })]);
	});

	it("denies non-managers, private chats, cross-workspace ids, default removal and bad participants", async () => {
		const { t, call, owner, member, chat } = await ready();
		const privateId = await owner.mutation(api.chats.createChannel, { name: "secret", private: true });
		const publicId = await owner.mutation(api.chats.createChannel, { name: "public", private: false });
		await setMemberSwitch(owner, "channels.edit", false);
		for (const request of [
			{ action: "get" },
			{ action: "join" },
			{ action: "leave" },
			{ action: "rename", name: "leak" },
			{ action: "set_topic", topic: "leak" },
			{ action: "add_members", userIds: [], agentIds: [] },
			{ action: "remove_member", userId: owner.userId },
		]) {
			expect(await call("channels.manage", { ...request, chat: privateId }, true), request.action).toHaveProperty("error");
		}
		for (const r of [
			{ action: "rename", name: "hijack" },
			{ action: "set_topic", topic: "hijack" },
			{ action: "remove_member", userId: owner.userId },
			{ action: "add_members", userIds: [member.userId], agentIds: [] },
		])
			expect(await call("channels.manage", { ...r, chat: publicId }, true)).toHaveProperty("error");
		expect(await call("chat.manage", { action: "send", chat: privateId, text: "no" }, true)).toHaveProperty("error");
		for (const action of ["leave", "remove_member"])
			expect(await call("channels.manage", { action, chat: chat._id, ...(action === "remove_member" && { userId: member.userId }) })).toHaveProperty("error");
		const side = await sideWorkspace(t, "owner@co.com");
		const foreign = await owner.in(side.workspaceId).mutation(api.chats.createChannel, { name: "foreign", private: false });
		expect(await call("channels.manage", { action: "get", chat: foreign })).toHaveProperty("error");
		expect(await call("chat.manage", { action: "open_dm", userIds: [side.workspaceId], agentIds: [] })).toHaveProperty("error");
	});
});

describe("automation management", () => {
	it("lists/reads, edits with versions, pauses/resumes, reassigns, changes audience and deletes", async () => {
		const { t, owner, call, member, companybot, scribe, chat } = await ready();
		await setMemberSwitch(owner, "automations.edit", true);
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		expect((await call("automations.manage", { action: "list" }, true)).page).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
		expect(await call("automations.manage", { action: "get", id }, true)).toMatchObject({ config: { version: 1 }, enabled: true });
		await call("automations.manage", { action: "edit", id, expectedVersion: 1, config: { ...config, name: "Friday review" } }, true);
		expect(await call("automations.manage", { action: "edit", id, expectedVersion: 1, config }, true)).toHaveProperty("error");
		await call("automations.manage", { action: "pause", id }, true);
		expect(await call("automations.manage", { action: "get", id }, true)).toMatchObject({ enabled: false, config: { name: "Friday review", version: 2 } });
		await call("automations.manage", { action: "resume", id }, true);
		await call("automations.manage", { action: "set_agent", id, agentId: scribe._id }, true);
		await call("automations.manage", { action: "set_audience", id, audience: "channel", channelId: chat._id }, true);
		expect(await call("automations.manage", { action: "get", id }, true)).toMatchObject({ enabled: true, audience: "channel", agentId: scribe._id });
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
		await call("automations.remove", { action: "delete", id }, true);
		expect(await call("automations.manage", { action: "get", id }, true)).toHaveProperty("error");
	});

	it("denies team automation edits without the switch, and even an owner's read of a creator-only automation", async () => {
		const { call, owner, member, companybot, t } = await ready();
		const id = await owner.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await setMemberSwitch(owner, "automations.edit", false);
		for (const r of [
			{ action: "edit", expectedVersion: 1, config },
			{ action: "pause" },
			{ action: "resume" },
			{ action: "set_agent", agentId: companybot._id },
			{ action: "set_audience", audience: "creator" },
		])
			expect(await call("automations.manage", { ...r, id }, true), r.action).toHaveProperty("error");
		expect(await call("automations.remove", { action: "delete", id }, true)).toHaveProperty("error");
		const hidden = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		expect(await call("automations.manage", { action: "get", id: hidden })).toHaveProperty("error");
		expect((await call("automations.manage", { action: "list" })).page.some((i: { id: string }) => i.id === hidden)).toBe(false);
		await t.run(async (ctx) => {
			const rows = await ctx.db.query("automationInstalls").collect();
			await ctx.db.patch(rows.find((i) => i.automationId === id)!._id, { webhookToken: "SECRET" });
		});
		expect(JSON.stringify(await call("automations.manage", { action: "get", id }))).not.toContain("SECRET");
	});
});

describe("skills, members and settings", () => {
	it("lists and reads existing skills, edits versioned instructions and removes", async () => {
		const { t, owner, call, member } = await ready();
		await setMemberSwitch(owner, "skills.edit", true);
		await seedSkill(t, owner, "meeting-notes");
		const id = await member.mutation(api.skills.create, { config: skill });
		expect((await call("skills.manage", { action: "list" })).page).toHaveLength(2);
		expect(await call("skills.manage", { action: "get", id })).toMatchObject({ name: skill.name, version: 1 });
		expect(await call("skills.edit", { action: "edit", id, expectedVersion: 1, config: { ...skill, instructions: "Updated." } }, true)).toMatchObject({
			done: "edit",
		});
		expect(await call("skills.edit", { action: "edit", id, expectedVersion: 1, config: skill }, true)).toHaveProperty("error");
		expect(await call("skills.manage", { action: "get", id: "meeting-notes" })).toHaveProperty("instructions");
		expect(await call("skills.manage", { action: "get", id: "meeting-notes" })).toMatchObject({ installed: true });
		await call("skills.remove", { action: "delete", id: "meeting-notes" });
		await call("skills.remove", { action: "delete", id }, true);
		expect(await call("skills.manage", { action: "get", id }, true)).toHaveProperty("error");
	});

	it("denies skill changes and removal without the switch, and settings writes", async () => {
		const { call, owner } = await ready();
		const id = await owner.mutation(api.skills.create, { config: skill });
		await setMemberSwitch(owner, "skills.edit", false);
		expect(await call("skills.edit", { action: "edit", id, expectedVersion: 1, config: skill }, true)).toHaveProperty("error");
		expect(await call("skills.remove", { action: "delete", id }, true)).toHaveProperty("error");
		expect(await call("skills.remove", { action: "delete", id: "meeting-notes" }, true)).toHaveProperty("error");
		const w = await call("workspace.settings", { action: "get" }, true);
		expect(await call("workspace.settings", { action: "update", expectedVersion: w.version, name: "No" }, true)).toHaveProperty("error");
		await call("workspace.settings", { action: "update", expectedVersion: w.version, name: "New", currency: "EUR", memory: false });
		expect(await call("workspace.settings", { action: "get" })).toMatchObject({ name: "New", currency: "EUR", memory: false, version: w.version + 1 });
		expect(await call("workspace.settings", { action: "update", expectedVersion: w.version, name: "Stale" })).toHaveProperty("error");
	});

	it("invites only members, respects email rate limits, cancels/resends and removes members with immediate revocation", async () => {
		const { t, call, owner, memberTurn } = await ready();
		expect(await call("members.invite", { action: "invite", email: "next@co.com" })).toMatchObject({ emailed: true });
		const invite = (await owner.query(api.workspace.team))!.invites[0]!;
		expect(invite.roles).toEqual([await builtInRoleOf(owner, "member")]);
		expect(await call("members.invite", { action: "resend", email: invite.email })).toHaveProperty("error");
		await t.run(async (ctx) => {
			for (const i of await ctx.db.query("inviteEmails").collect()) await ctx.db.delete(i._id);
		});
		expect(await call("members.invite", { action: "resend", email: invite.email })).toMatchObject({ done: "resend" });
		expect(await call("members.invite", { action: "cancel", email: invite.email })).toMatchObject({ done: "cancel" });
		for (const request of [
			{ action: "invite", email: "no@co.com" },
			{ action: "resend", email: invite.email },
			{ action: "cancel", email: invite.email },
		])
			expect(await call("members.invite", request, true)).toHaveProperty("error");
		expect(await call("members.remove", { action: "remove", email: "owner@co.com" })).toHaveProperty("error");
		expect(await call("members.remove", { action: "remove", email: "owner@co.com" }, true)).toHaveProperty("error");
		expect(await call("members.remove", { action: "remove", email: "Member@Co.com" })).toHaveProperty("removed");
		await expect(
			t.mutation(internal.manageTools.runFor, { turnId: memberTurn, tool: "workspace.settings", input: { request: { action: "get" } } }),
		).rejects.toThrow("no longer in the workspace");
	});

	it("rechecks agent grants and running status at every call", async () => {
		const { t, call, companybot, turnId } = await ready();
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [] }));
		await expect(call("channels.manage", { action: "list" })).rejects.toThrow("no longer has that tool");
		await t.run((ctx) => ctx.db.patch(turnId, { status: "done" }));
		await expect(call("workspace.settings", { action: "get" })).rejects.toThrow("stopped");
	});
});
