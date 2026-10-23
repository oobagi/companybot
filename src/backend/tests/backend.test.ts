import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { decrypt } from "../convex/crypto";
import { definePlugin, pluginCatalog } from "@companybot/core";

// A test plugin, so plugin flows can run without a real connector in the catalog.
const notes = definePlugin({
	id: "notes",
	name: "Notes",
	description: "Test plugin",
	version: "1.0.0",
	publisher: "Test",
	mcp: { url: "https://example.com/mcp", transport: "http" },
	connection: "personal",
	auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
});
const crm = definePlugin({ ...notes, id: "crm", name: "CRM", connection: "workspace" });
pluginCatalog.push(notes, crm);
process.env.CONNECTIONS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** A signed-in person. Convex Auth reads the user id from the token subject. */
async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const as = t.withIdentity({ subject: `${userId}|session` });
	await as.mutation(api.workspace.ensure);
	return as;
}

/** The workspace's agents by name. */
async function agentsOf(as: Awaited<ReturnType<typeof signIn>>) {
	const list = await as.query(api.agents.list);
	const byName = (name: string) => list.find((a) => a.name === name)!;
	return { list, companybot: byName("Companybot"), scribe: byName("Scribe") };
}

async function ownerAndMember() {
	const t = convexTest(schema, modules);
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "Member@Co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	return { t, owner, member };
}

describe("workspaces", () => {
	it("makes the first person owner and lets invited people join as members", async () => {
		const { owner, member } = await ownerAndMember();
		expect((await owner.query(api.workspace.me))?.role).toBe("owner");
		expect((await member.query(api.workspace.me))?.role).toBe("member");
		expect((await owner.query(api.workspace.team))?.members).toHaveLength(2);
	});

	it("only lets owners invite", async () => {
		const { member } = await ownerAndMember();
		await expect(member.mutation(api.workspace.invite, { email: "x@co.com", role: "member" })).rejects.toThrow(
			"permission",
		);
	});

	it("doesn't invite people who are already in", async () => {
		const { owner } = await ownerAndMember();
		await expect(owner.mutation(api.workspace.invite, { email: "MEMBER@co.com", role: "owner" })).rejects.toThrow(
			"already a member",
		);
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await expect(owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" })).rejects.toThrow(
			"already has an invite",
		);
	});
});

describe("memory", () => {
	it("enforces team vs personal permissions", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "We close at 5pm." });
		await expect(member.mutation(api.memory.create, { agentId, scope: "workspace", content: "x" })).rejects.toThrow(
			"permission",
		);
		await member.mutation(api.memory.create, { agentId, scope: "personal", content: "I like mornings." });

		const third = await (async () => {
			await owner.mutation(api.workspace.invite, { email: "third@co.com", role: "member" });
			return signIn(t, "third@co.com");
		})();

		const team = (await member.query(api.memory.list)).find((m) => m.scope === "workspace")!;
		expect(team.canEdit).toBe(false);
		expect((await third.query(api.memory.list)).map((m) => m.content)).toEqual(["We close at 5pm."]);
		expect(await owner.query(api.memory.list)).toHaveLength(2);
	});

	it("keeps each agent's memories separate", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "workspace", content: "Companybot fact" });
		await owner.mutation(api.memory.create, { agentId: scribe._id, scope: "workspace", content: "Scribe fact" });
		const userId = companybot.updatedBy;
		const seen = await t.query(internal.memory.listFor, { userId, agentId: scribe._id });
		expect(seen.map((m) => m.content)).toEqual(["Scribe fact"]);
	});

	it("lets agents fix and forget only what the person could", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const team = await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "Office is in Austin." });
		const memberId = (await member.query(api.workspace.me))!.userId;
		const id = team.id as never;
		await expect(t.mutation(internal.memory.removeFor, { userId: memberId, agentId, id })).rejects.toThrow("can't change");
		await expect(
			t.mutation(internal.memory.updateFor, { userId: memberId, agentId: (await agentsOf(owner)).scribe._id, id, content: "x" }),
		).rejects.toThrow("not found");
	});

	it("refuses an edit made against an old version", async () => {
		const { owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const memory = await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "v1" });
		await owner.mutation(api.memory.update, { id: memory.id as never, content: "v2", expectedVersion: 1 });
		await expect(
			owner.mutation(api.memory.update, { id: memory.id as never, content: "stale", expectedVersion: 1 }),
		).rejects.toThrow();
		expect((await owner.query(api.memory.list))[0].content).toBe("v2");
	});

	it("cuts off an agent's access as soon as its person is removed", async () => {
		const { t, owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const team = (await owner.query(api.workspace.team))!;
		const row = team.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await expect(t.query(internal.memory.listFor, { userId: row.userId, agentId })).rejects.toThrow("no longer");
	});
});

describe("agents", () => {
	it("gives new workspaces the default agents", async () => {
		const { owner } = await ownerAndMember();
		expect((await agentsOf(owner)).list.map((a) => a.name)).toEqual(["Companybot", "Scribe"]);
	});

	it("versions every save and restores old versions", async () => {
		const { owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: scribe.name, description: scribe.description, instructions: "Be terse.", model: scribe.model, tools: scribe.tools };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });
		await owner.mutation(api.agents.restore, { agentId: scribe._id, version: 1, expectedVersion: 2 });
		const history = await owner.query(api.agents.history, { agentId: scribe._id });
		expect(history.map((h) => [h.version, h.config.instructions.slice(0, 10)])).toEqual([
			[3, "You are Sc"],
			[2, "Be terse."],
			[1, "You are Sc"],
		]);
	});

	it("refuses a save when someone else saved first", async () => {
		const { owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: "A", description: "", instructions: "", model: scribe.model, tools: [] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });
		await expect(
			owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config: { ...config, name: "B" } }),
		).rejects.toThrow();
	});

	it("lets only owners edit, and rejects unknown tools", async () => {
		const { owner, member } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: "X", description: "", instructions: "", model: scribe.model, tools: [] as string[] };
		await expect(member.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config })).rejects.toThrow(
			"permission",
		);
		await expect(
			owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config: { ...config, tools: ["x.y"] } }),
		).rejects.toThrow("Unknown tool");
	});

	it("archives agents but keeps at least one", async () => {
		const { owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		await expect(owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] })).rejects.toThrow(
			"isn't available",
		);
		await expect(owner.mutation(api.agents.setArchived, { agentId: companybot._id, archived: true })).rejects.toThrow(
			"at least one",
		);
	});
});

describe("settings", () => {
	it("keeps at least one owner and applies role changes at once", async () => {
		const { owner, member } = await ownerAndMember();
		const team = (await owner.query(api.workspace.team))!;
		const me = team.members.find((m) => m.isYou)!;
		const them = team.members.find((m) => !m.isYou)!;
		await expect(owner.mutation(api.workspace.setRole, { id: me.id, role: "member" })).rejects.toThrow("at least one owner");
		await owner.mutation(api.workspace.setRole, { id: them.id, role: "owner" });
		expect((await member.query(api.workspace.me))?.role).toBe("owner");
	});

	it("refuses a stale workspace rename", async () => {
		const { owner } = await ownerAndMember();
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		await expect(owner.mutation(api.workspace.updateSettings, { name: "Other", expectedVersion: 1 })).rejects.toThrow();
		expect((await owner.query(api.workspace.settings))?.name).toBe("Acme");
	});

	it("keeps preferences personal", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden", sendWith: "mod-enter" });
		expect(await owner.query(api.preferences.get)).toEqual({ displayName: "Jaden", sendWith: "mod-enter" });
		expect((await member.query(api.preferences.get)).displayName).toBe("");
		expect((await member.query(api.workspace.team))?.members.map((m) => m.name)).toContain("Jaden");
	});
});

describe("customize", () => {
	it("lets only owners install skills", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow(
			"permission",
		);
		await owner.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true });
		expect((await member.query(api.skills.list)).find((s) => s.id === "meeting-notes")?.installed).toBe(true);
	});

	it("hides owner-only tools from members", async () => {
		const { owner, member } = await ownerAndMember();
		const tool = async (as: typeof owner) =>
			(await agentsOf(as)).companybot.access.find((x) => x.id === "memory.remember_for_team");
		expect((await tool(owner))?.visible).toBe(true);
		expect((await tool(member))?.visible).toBe(false);
	});
});

type As = Awaited<ReturnType<typeof signIn>>;
const noMentions = { userIds: [], agentIds: [] };
/** Read times are in ms; let the clock move so "after" means after. */
const tick = () => new Promise((r) => setTimeout(r, 3));
const meOf = async (as: As) => (await as.query(api.workspace.me))!.userId;
const generalOf = async (as: As) => (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
const turnsOf = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("agentTurns").collect());
const usage = (costUsd: number) => ({
	model: "anthropic/claude-haiku-5.5",
	steps: 1,
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 20,
	contextTokens: 120,
	costUsd,
	durationMs: 900,
});

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

describe("agent turns", () => {
	it("replies to mentions in channels, adding the agent to the channel", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "no mention", mentions: noMentions });
		expect(await turnsOf(t)).toHaveLength(0);
		const trigger = await owner.mutation(api.messages.send, {
			chatId,
			text: "@Companybot hi",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn).toMatchObject({ status: "running", triggerId: trigger, agentId: companybot._id });
		expect((await generalOf(owner)).members.some((m) => m.id === companybot._id)).toBe(true);
		const messages = await owner.query(api.messages.list, { chatId });
		expect(messages.at(-1)).toMatchObject({ _id: turn!.replyId, author: { type: "agent", name: "Companybot" }, status: "streaming" });
	});

	it("answers every message in an agent DM, one at a time", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		let turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["running", "queued"]);

		await t.mutation(internal.turns.finishReply, { turnId: turns[0]!._id, usage: usage(0.01) });
		turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["done", "running"]);
		await t.mutation(internal.turns.finishReply, { turnId: turns[1]!._id, usage: usage(0.02) });
		const stats = (await owner.query(api.messages.list, { chatId })).flatMap((m) => (m.stats ? [m.stats.conversationCostUsd] : []));
		expect(stats).toEqual([0.01, 0.03]);
		expect((await owner.query(api.chats.place, { chatId }))?.costUsd).toBeCloseTo(0.03);
	});

	it("never lets agents trigger agents, and drops mentions of archived agents", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.turns.updateReply, { replyId: turn!.replyId!, text: "@Scribe help", parts: [{ type: "text", text: "@Scribe help" }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect((await turnsOf(t)).map((x) => x.agentId)).toEqual([companybot._id]);

		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		await owner.mutation(api.messages.send, { chatId, text: "@Scribe", mentions: { userIds: [], agentIds: [scribe._id] } });
		expect(await turnsOf(t)).toHaveLength(1);
	});

	it("fails a turn stuck over 5 minutes and moves the queue on", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		const [stuck] = await turnsOf(t);
		await t.run((ctx) => ctx.db.patch(stuck!._id, { startedAt: Date.now() - 6 * 60_000 }));
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["error", "running"]);
		const reply = await t.run((ctx) => ctx.db.get(stuck!.replyId!));
		expect(reply).toMatchObject({ status: "error", error: "Reply timed out." });
	});

	it("replies in the thread it was mentioned in", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan", mentions: noMentions });
		await owner.mutation(api.messages.send, {
			chatId,
			threadId: parent,
			text: "@Companybot thoughts?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn?.threadId).toBe(parent);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.author.type)).toEqual([
			"user",
			"user",
			"agent",
		]);
		const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.place.thread).toMatchObject({ first: true, parent: { text: "Plan" } });
		expect(context.memory).toBe("team");
	});

	it("feeds new messages since the last reply and replays past turns as sent", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "first", mentions: noMentions });
		let [turn] = await turnsOf(t);
		let context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.memory).toBe("personal");
		expect(context.messages.map((m) => m.text)).toEqual(["first"]);
		await t.mutation(internal.turns.savePrompt, { turnId: turn!._id, prompt: "PROMPT 1" });
		await t.mutation(internal.turns.updateReply, {
			replyId: turn!.replyId!,
			text: "answer",
			parts: [
				{ type: "tool", id: "c1", name: "chat_react", status: "done" },
				{ type: "text", text: "answer" },
			],
		});
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });

		await owner.mutation(api.messages.send, { chatId, text: "second", mentions: noMentions });
		turn = (await turnsOf(t))[1];
		context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		// Tools it used replay too, so later it knows it really acted.
		expect(context.session.turns).toEqual([{ prompt: "PROMPT 1", reply: "answer\n[Tools you used: chat_react (done)]" }]);
		expect(context.messages.map((m) => m.text)).toEqual(["second"]);
		expect(context.triggerId).toBe(context.messages[0]!.id);
	});

	it("compacts a session's older turns, keeping a recent tail", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		for (const text of ["a", "b", "c"]) {
			await owner.mutation(api.messages.send, { chatId, text, mentions: noMentions });
			const turn = (await turnsOf(t)).at(-1)!;
			await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: `prompt ${text}`.repeat(10) });
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, usage: usage(0.01) });
		}
		const sessionId = (await turnsOf(t))[0]!.sessionId!;
		const input = await t.mutation(internal.turns.startCompaction, { sessionId, keepTokens: 1 });
		expect(input?.turns).toHaveLength(2);
		expect((await owner.query(api.chats.place, { chatId }))?.compacting).toBe(true);
		expect(await t.mutation(internal.turns.startCompaction, { sessionId })).toBeNull();
		await t.mutation(internal.turns.finishCompaction, { sessionId, result: { summary: "- Said a, b", upTo: input!.upTo, costUsd: 0.005 } });
		const place = await owner.query(api.chats.place, { chatId });
		expect(place).toMatchObject({ summary: "- Said a, b", summarizedUpTo: input!.upTo, compacting: false });
		expect(place?.costUsd).toBeCloseTo(0.035);

		await owner.mutation(api.messages.send, { chatId, text: "d", mentions: noMentions });
		const context = await t.query(internal.turns.turnContext, { turnId: (await turnsOf(t)).at(-1)!._id });
		expect(context.session.summary).toBe("- Said a, b");
		expect(context.session.turns.map((x) => x.prompt.slice(0, 8))).toEqual(["prompt c"]);
	});

	it("lets chat tools see only what the person can, and react to the trigger", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const chatId = (await generalOf(member))._id;
		const trigger = await member.mutation(api.messages.send, {
			chatId,
			text: "@Companybot what's on #board?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(await t.query(internal.turns.readFor, { turnId: turn!._id, chat: "#board" })).toEqual({
			error: 'No channel "#board" you can see.',
		});
		const here = await t.query(internal.turns.readFor, { turnId: turn!._id });
		expect("messages" in here && here.messages.map((m) => [m.chat, m.author, m.text])).toEqual([
			["#general", "member@co.com", "@Companybot what's on #board?"],
		]);
		expect(await t.mutation(internal.turns.reactFor, { turnId: turn!._id, emoji: "👀" })).toEqual({ reacted: true });
		const [m] = (await member.query(api.messages.list, { chatId })).filter((x) => x._id === trigger);
		expect(m!.reactions).toEqual([{ emoji: "👀", count: 1, mine: false, names: ["Companybot"] }]);
		const after = await t.query(internal.turns.readFor, { turnId: turn!._id });
		expect("messages" in after && after.messages[0]?.reactions).toEqual([{ emoji: "👀", by: ["Companybot"] }]);
	});
});

describe("memory in shared chats", () => {
	it("refuses personal memories when 2+ people can read the chat", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const agentId = companybot._id;
		const mine = await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "I'm vegan." });
		await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "We close at 5." });
		const userId = await meOf(owner);
		const shared = { userId, agentId, teamOnly: true };
		expect((await t.query(internal.memory.listFor, shared)).map((m) => m.content)).toEqual(["We close at 5."]);
		await expect(t.mutation(internal.memory.createFor, { ...shared, scope: "personal", content: "x" })).rejects.toThrow(
			"Personal memories are off",
		);
		await expect(t.mutation(internal.memory.removeFor, { ...shared, id: mine.id as Id<"memories"> })).rejects.toThrow(
			"Personal memories are off",
		);
		expect(await t.query(internal.memory.listFor, { userId, agentId })).toHaveLength(2);
	});
});

describe("legacy chat API (apps before team chat)", () => {
	it("reads and writes the person's agent DM, so old and new apps see one conversation", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		expect(await owner.query(api.chat.messages, { agentId: companybot._id })).toEqual([]);
		await owner.mutation(api.chat.send, { agentId: companybot._id, text: "hi from the old app" });
		const [turn] = await turnsOf(t);
		expect(turn).toMatchObject({ agentId: companybot._id, status: "running" });
		const old = await owner.query(api.chat.messages, { agentId: companybot._id });
		expect(old.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hi from the old app", "done"],
			["assistant", "", "streaming"],
		]);
		const dmId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		expect((await owner.query(api.messages.list, { chatId: dmId })).map((m) => m.text)).toEqual(["hi from the old app", ""]);
	});
});

describe("migration", () => {
	it("copies legacy conversations into agent DMs once, and grants chat tools once", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const userId = await meOf(owner);
		await t.run(async (ctx) => {
			const workspaceId = (await ctx.db.get(companybot._id))!.workspaceId;
			const tools = ["memory.search"];
			await ctx.db.patch(companybot._id, { tools });
			// A pre-chat workspace: no #general yet.
			for (const c of await ctx.db.query("chatMembers").collect()) await ctx.db.delete(c._id);
			for (const c of await ctx.db.query("chats").collect()) await ctx.db.delete(c._id);
			const conversationId = await ctx.db.insert("conversations", {
				workspaceId,
				userId,
				agentId: companybot._id,
				busy: false,
				summary: "- Old stuff",
				costUsd: 0.5,
			});
			for (const [role, text] of [["user", "hi"], ["assistant", "hello"], ["user", "bye"]] as const) {
				await ctx.db.insert("messages", { conversationId, role, text, parts: [{ type: "text", text }], status: "done" });
			}
		});
		const first = await t.mutation(internal.migrations.conversationsToChats, {});
		const second = await t.mutation(internal.migrations.conversationsToChats, {});
		expect(first).toMatchObject({ conversations: 1, messages: 3 });
		expect(second).toMatchObject({ conversations: 0, messages: 0, agents: 0 });

		const list = (await owner.query(api.chats.list))!;
		expect(list.channels.map((c) => c.name)).toEqual(["general"]);
		const dmId = list.agents.find((a) => a._id === companybot._id)!.dmId!;
		const messages = await owner.query(api.messages.list, { chatId: dmId });
		expect(messages.map((m) => [m.author.type, m.text])).toEqual([
			["user", "hi"],
			["agent", "hello"],
			["user", "bye"],
		]);
		expect(await owner.query(api.chats.place, { chatId: dmId })).toMatchObject({ summary: "- Old stuff", costUsd: 0.5 });
		const agent = (await agentsOf(owner)).companybot;
		expect(agent.tools).toEqual(["chat.*", "memory.search"]);
		expect(agent.version).toBe(2);
	});
});

describe("plugins", () => {
	it("lets only owners install, and members connect their own account", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(member.mutation(api.plugins.setInstalled, { pluginId: "notes", installed: true })).rejects.toThrow(
			"permission",
		);
		await expect(
			member.action(api.plugins.connect, { pluginId: "notes", credentials: { type: "api_key", key: "k" } }),
		).rejects.toThrow("Install the plugin first");
		await owner.mutation(api.plugins.setInstalled, { pluginId: "notes", installed: true });
		await member.action(api.plugins.connect, { pluginId: "notes", credentials: { type: "api_key", key: "secret-1" } });

		const mine = (await member.query(api.plugins.list)).find((p) => p.id === "notes")!;
		expect(mine).toMatchObject({ installed: true, connected: true, canUse: true });
		expect(JSON.stringify(mine)).not.toContain("secret-1");
		// Personal: the owner hasn't connected their own account.
		expect((await owner.query(api.plugins.list)).find((p) => p.id === "notes")?.connected).toBe(false);

		const stored = await t.run((ctx) => ctx.db.query("pluginConnections").first());
		expect(stored?.credentials).not.toContain("secret-1");
		expect(await decrypt(stored!.credentials)).toEqual({ type: "api_key", key: "secret-1" });
	});

	it("needs an owner to connect a workspace account", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		const creds = { type: "api_key" as const, key: "k" };
		await expect(member.action(api.plugins.connect, { pluginId: "crm", credentials: creds })).rejects.toThrow("permission");
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: creds });
		// One shared connection covers everyone.
		expect((await member.query(api.plugins.list)).find((p) => p.id === "crm")?.connected).toBe(true);
	});

	it("gives agents plugin tools only for allowed roles, read fresh each turn", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: { type: "api_key", key: "k" } });
		const { scribe } = await agentsOf(owner);
		const config = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: ["crm.*"] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });

		const memberId = (await member.query(api.workspace.me))!.userId;
		const forTurn = () => t.query(internal.plugins.forTurn, { userId: memberId, pluginIds: ["crm"] });
		expect(await forTurn()).toHaveLength(1);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: true }]);

		await owner.mutation(api.plugins.setRoles, { pluginId: "crm", roles: ["owner"] });
		expect(await forTurn()).toHaveLength(0);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: false, reason: "role" }]);
	});

	it("forgets connections when uninstalled", async () => {
		const { t, owner } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: { type: "api_key", key: "k" } });
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: false });
		expect(await t.run((ctx) => ctx.db.query("pluginConnections").collect())).toHaveLength(0);
	});
});

describe("automations", () => {
	const tz = "America/Los_Angeles";
	/** Who wrote each message in this person's DM with the agent, and which automation sent it. */
	const dmWith = async (as: Awaited<ReturnType<typeof signIn>>, agentId: Id<"agents">) => {
		const dmId = (await as.query(api.chats.list))?.agents.find((a) => a._id === agentId)?.dmId;
		const messages = dmId ? await as.query(api.messages.list, { chatId: dmId }) : [];
		return messages.map((m) => [m.author.type, m.automation?.name ?? null]);
	};

	it("lets only owners install, and needs required plugins first", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(
			member.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz }),
		).rejects.toThrow("permission");
		await expect(
			owner.mutation(api.automations.setInstalled, { automationId: "after-call-summary", installed: true, timeZone: tz }),
		).rejects.toThrow("Install the Night Owl plugin first");
		await owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz });
		const brief = (await member.query(api.automations.list)).find((a) => a.id === "morning-brief")!;
		expect([brief.installed, brief.enabled, brief.agentName, brief.trigger]).toEqual([
			true,
			true,
			"Companybot",
			"Weekdays at 8:00 AM",
		]);
	});

	it("runs a schedule for everyone once a day, marked as the automation's", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz });
		// Pretend it last ran long ago, then let the tick find it due (on a weekday after 8am).
		await t.run(async (ctx) => {
			const install = (await ctx.db.query("automationInstalls").first())!;
			await ctx.db.patch(install._id, { lastRunDate: "2000-01-01" });
		});
		vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 16), toFake: ["Date"] }); // Thu 9am in LA
		try {
			await t.mutation(internal.automations.tick);
			await t.mutation(internal.automations.tick);
		} finally {
			vi.useRealTimers();
		}
		const { companybot } = await agentsOf(member);
		expect(await dmWith(member, companybot._id)).toEqual([
			["user", "Morning brief"],
			["agent", null],
		]);
		const brief = (await owner.query(api.automations.list)).find((a) => a.id === "morning-brief")!;
		expect(brief.lastResult).toBe("Sent to 2 people.");
	});

	it("skips turned-off automations and runs now for the owner alone", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz });
		await owner.mutation(api.automations.update, { automationId: "morning-brief", enabled: false });
		await owner.mutation(api.automations.runNow, { automationId: "morning-brief" });
		const { companybot } = await agentsOf(owner);
		expect(await dmWith(owner, companybot._id)).toHaveLength(2);
		expect(await dmWith(member, companybot._id)).toHaveLength(0);
		await expect(member.mutation(api.automations.runNow, { automationId: "morning-brief" })).rejects.toThrow("permission");
	});
});
