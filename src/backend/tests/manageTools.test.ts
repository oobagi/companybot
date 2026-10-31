import { seedSkill } from "./legacyFixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageTool } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, sideWorkspace } from "./helpers";
import type { Id } from "../convex/_generated/dataModel";

afterEach(() => vi.useRealTimers());

async function ready() {
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
		expect(await call("channels.manage", { action: "delete", chat: other }, true)).toHaveProperty("error");
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
			expect.arrayContaining([expect.objectContaining({ userId: owner.userId, role: "owner" })]),
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
		expect(await call("chat.manage", r)).toEqual({ chatId });
		const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
		const parent = await owner.mutation(api.messages.send, { chatId: chat._id, text: "Parent", mentions: noMentions });
		for (const destination of [{ chat: "#general" }, { chat: chat._id, threadId: parent }, { chat: chatId }]) {
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
		const lines = await owner.query(api.messages.list, { chatId });
		expect(lines.at(-1)!.author.name).toContain("Companybot, for");
		expect(await t.query(internal.chatTools.readFor, { turnId, chat: chatId })).toHaveProperty("messages");
		expect(await call("chat.manage", { action: "send", chat: chatId, threadId: parent, text: "Wrong parent" })).toHaveProperty("error");
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
		const { t, call, member, companybot, scribe, chat } = await ready();
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

	it("denies another maker's edits and even an owner's read of a creator-only automation", async () => {
		const { call, owner, member, companybot, t } = await ready();
		const id = await owner.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
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

	it("denies another maker's skill changes, nonowner install/removal and settings writes", async () => {
		const { call, owner } = await ready();
		const id = await owner.mutation(api.skills.create, { config: skill });
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
		expect(invite.role).toBe("member");
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
