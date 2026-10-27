import { seedLegacyRecords } from "./legacyFixtures";
import { modules } from "./helpers";
import migrationsTest from "@convex-dev/migrations/test";
import { connectorCatalog, defineConnector } from "@companybot/core";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { person } from "./person";

// One person in two workspaces, A and B: every request acts in the workspace it names, an id
// from the other one looks like it doesn't exist, and apps that name no workspace stay in the
// first one they joined. See wiki/architecture.md (Workspaces).

connectorCatalog.push(
	defineConnector({
		id: "twoworkspacecrm",
		name: "Two-workspace CRM",
		description: "For tests",
		version: "1",
		publisher: "test",
		mcp: { url: "https://example.com/mcp", transport: "http" },
		connection: "workspace",
		auth: { type: "none" },
	}),
);
const CONNECTOR = "twoworkspacecrm";

/** Someone who started A (on an app that names no workspace: `old`), then got B. */
async function setup() {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const userId = await t.run((ctx) => ctx.db.insert("users", { email: "two@co.com" }));
	const old = person(t.withIdentity({ subject: `${userId}|session` }));
	await old.mutation(api.workspace.ensure);
	const a = (await old.query(api.workspace.me))!.workspaceId!;
	await t.run((ctx) => seedLegacyRecords(ctx, a, userId));
	const b = await t.run(async (ctx) => {
		const id = await ctx.db.insert("workspaces", { name: "B", version: 1 });
		await ctx.db.insert("members", { userId, workspaceId: id, role: "owner" });
		return id;
	});
	return { t, userId, old, a, b, A: old.in(a), B: old.in(b) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Takes them out of A directly, as an owner removing them would, keeping their chat seats. */
const removeFromA = ({ t, userId, a }: Setup) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", userId).eq("workspaceId", a))
			.first();
		await ctx.db.delete(row!._id);
	});

/** A second owner, so the person can leave A. */
const deputyIn = ({ t }: Setup, workspaceId: Id<"workspaces">) =>
	t.run(async (ctx) => {
		const deputy = await ctx.db.insert("users", { email: "deputy@co.com" });
		await ctx.db.insert("members", { userId: deputy, workspaceId, role: "owner" });
	});

describe("apps that name no workspace", () => {
	it("stay in the first workspace after leaving it, and act nowhere rather than in another", async () => {
		const s = await setup();
		const { old, a, A, B } = s;
		const settings = (await old.query(api.workspace.settings))!;
		expect(settings.name).toBe((await A.query(api.workspace.settings))!.name);
		await deputyIn(s, a);
		await A.mutation(api.workspace.leave);

		await expect(old.mutation(api.workspace.updateSettings, { name: "Draft for A", expectedVersion: settings.version })).rejects.toThrow(
			"Sign in to a workspace first",
		);
		expect((await B.query(api.workspace.settings))!.name).toBe("B");
		expect(await old.query(api.workspace.settings)).toBeNull();
	});

	it("keep the first workspace pinned, however memberships change after", async () => {
		const s = await setup();
		const { t, userId, old, a } = s;
		expect(await t.run((ctx) => ctx.db.query("legacyWorkspaces").collect())).toMatchObject([{ userId, workspaceId: a }]);
		// Joining more workspaces later never moves it.
		await t.run(async (ctx) => {
			const c = await ctx.db.insert("workspaces", { name: "C", version: 1 });
			await ctx.db.insert("members", { workspaceId: c, userId: await ctx.db.insert("users", {}), role: "owner" });
			await ctx.db.insert("invites", { workspaceId: c, email: "two@co.com", role: "member" });
		});
		const [invite] = (await old.query(api.workspace.mine))!.invitations;
		await old.mutation(api.workspace.acceptInvite, { id: invite!.id });
		expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
	});

	it("are backfilled: someone from before pinning keeps their only workspace", async () => {
		const s = await setup();
		const { t, userId, old, a } = s;
		migrationsTest.register(t);
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("legacyWorkspaces").collect()) await ctx.db.delete(row._id);
		});
		// Unpinned with two workspaces is ambiguous, so it fails closed.
		expect(await old.query(api.workspace.me)).toMatchObject({ workspaceId: null });
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		expect(await t.run((ctx) => ctx.db.query("legacyWorkspaces").collect())).toMatchObject([{ userId, workspaceId: a }]);
		expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
	});
});

describe("requests naming a workspace", () => {
	it("can't mark a chat in another workspace read, even one they were in", async () => {
		const s = await setup();
		const { t, userId, A, B } = s;
		const chatId = await A.mutation(api.chats.openDm, { userIds: [], agentIds: [] });
		await removeFromA(s);
		const seat = () =>
			t.run(async (ctx) =>
				ctx.db
					.query("chatMembers")
					.withIndex("by_user", (q) => q.eq("userId", userId).eq("chatId", chatId))
					.first(),
			);
		const seatId = (await seat())!._id;
		await t.run(async (ctx) => ctx.db.patch(seatId, { lastReadAt: 0 }));
		await expect(B.mutation(api.chats.markRead, { chatId })).rejects.toThrow("Chat not found");
		expect((await seat())!.lastReadAt).toBe(0);
	});

	it("can't remove a permission rule from another workspace", async () => {
		const { t, A, B } = await setup();
		await A.mutation(api.connectors.setInstalled, { connectorId: CONNECTOR, installed: true });
		await A.mutation(api.permissions.set, { action: `${CONNECTOR}.send`, setting: "never" });
		const [rule] = (await A.query(api.permissions.mine))!;
		await expect(B.mutation(api.permissions.remove, { ruleId: rule!._id })).rejects.toThrow("Rule not found");
		expect(await t.run((ctx) => ctx.db.get(rule!._id))).not.toBeNull();
		await A.mutation(api.permissions.remove, { ruleId: rule!._id });
		expect(await t.run((ctx) => ctx.db.get(rule!._id))).toBeNull();
	});

	// The sweep: each public function that takes an id refuses one from the workspace the
	// request doesn't name, even though the person is an owner of both.
	it("refuse every id from the other workspace", async () => {
		const s = await setup();
		const { t, A, B } = s;
		await A.mutation(api.workspace.invite, { email: "someone@co.com", role: "member" });
		await deputyIn(s, s.a);
		const team = (await A.query(api.workspace.team))!;
		const deputy = team.members.find((m) => m.email === "deputy@co.com")!;
		const invite = team.invites[0]!;
		const chats = (await A.query(api.chats.list))!;
		const general = chats.channels.find((c) => c.isDefault)!._id;
		const agentId = chats.agents.find((a) => a.name === "Companybot")!._id;
		const messageId = await A.mutation(api.messages.send, { chatId: general, text: "hi", mentions: { userIds: [], agentIds: [] } });
		const task = (await A.query(api.recordTypes.list)).find((type) => type.key === "task")!;
		const recordId = await A.mutation(api.records.create, { typeId: task._id, values: { name: "A's task" } });
		const fieldId = (await A.mutation(api.fields.create, { typeId: task._id, label: "Notes", kind: "text" }))._id;
		const memoryId = (await A.mutation(api.memory.create, { agentId, scope: "workspace", content: "A's fact" })).id as Id<"memories">;
		const [historyId] = (await A.query(api.records.history, { recordId, paginationOpts: { numItems: 1, cursor: null } })).page.map((e) => e._id);
		const agent = (await A.query(api.agents.list)).find((a) => a._id === agentId)!;

		const refused: [string, () => Promise<unknown>][] = [
			["chats.updateChannel", () => B.mutation(api.chats.updateChannel, { chatId: general, topic: "x" })],
			["chats.join", () => B.mutation(api.chats.join, { chatId: general })],
			["chats.leave", () => B.mutation(api.chats.leave, { chatId: general })],
			["chats.addMembers", () => B.mutation(api.chats.addMembers, { chatId: general, userIds: [], agentIds: [] })],
			["chats.markRead", () => B.mutation(api.chats.markRead, { chatId: general })],
			["messages.send", () => B.mutation(api.messages.send, { chatId: general, text: "x", mentions: { userIds: [], agentIds: [] } })],
			["messages.edit", () => B.mutation(api.messages.edit, { messageId, text: "x" })],
			["messages.remove", () => B.mutation(api.messages.remove, { messageId })],
			["messages.react", () => B.mutation(api.messages.react, { messageId, emoji: "👍" })],
			["records.update", () => B.mutation(api.records.update, { recordId, values: { name: "x" } })],
			["records.archive", () => B.mutation(api.records.archive, { recordId })],
			["records.undo", () => B.mutation(api.records.undo, { historyId: historyId! })],
			["records.create", () => B.mutation(api.records.create, { typeId: task._id, values: { name: "x" } })],
			["fields.create", () => B.mutation(api.fields.create, { typeId: task._id, label: "x", kind: "text" })],
			["fields.update", () => B.mutation(api.fields.update, { fieldId, label: "x" })],
			["fields.archive", () => B.mutation(api.fields.archive, { fieldId })],
			["memory.create", () => B.mutation(api.memory.create, { agentId, scope: "workspace", content: "x" })],
			["memory.update", () => B.mutation(api.memory.update, { id: memoryId, content: "x", expectedVersion: 1 })],
			["memory.remove", () => B.mutation(api.memory.remove, { id: memoryId })],
			["agents.update", () => B.mutation(api.agents.update, { agentId, expectedVersion: agent.version, config: { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: agent.tools } })],
			["agents.setArchived", () => B.mutation(api.agents.setArchived, { agentId, archived: true })],
			["workspace.resendInvite", () => B.mutation(api.workspace.resendInvite, { id: invite.id })],
			["workspace.setRole", () => B.mutation(api.workspace.setRole, { id: deputy.id, role: "member" })],
		];
		for (const [name, call] of refused) {
			await expect(call(), name).rejects.toThrow(/not found|isn't available|can't/i);
		}
		// These quietly do nothing.
		await B.mutation(api.workspace.cancelInvite, { id: invite.id });
		await B.mutation(api.workspace.removeMember, { id: deputy.id });
		const after = (await A.query(api.workspace.team))!;
		expect(after.invites.map((i) => i.id)).toEqual([invite.id]);
		expect(after.members.map((m) => m.id)).toContain(deputy.id);
		// Reads show nothing.
		expect(await B.query(api.chats.get, { chatId: general })).toBeNull();
		expect(await B.query(api.messages.list, { chatId: general })).toEqual([]);
		expect(await B.query(api.records.get, { recordId })).toBeNull();
		await expect(B.query(api.agents.history, { agentId })).rejects.toThrow("Agent not found");
		// And nothing in A changed.
		expect(await t.run((ctx) => ctx.db.get(messageId))).toMatchObject({ text: "hi" });
		expect(await A.query(api.records.get, { recordId })).toMatchObject({ archived: false });
	});
});

describe("unread mentions", () => {
	it("go once they leave the private chat or the workspace", async () => {
		const { t, userId, a, A, B } = await setup();
		const otherId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("users", { email: "other@co.com" });
			await ctx.db.insert("members", { userId: id, workspaceId: a, role: "owner" });
			return id;
		});
		const other = person(t.withIdentity({ subject: `${otherId}|session` })).in(a);
		const chatId = await other.mutation(api.chats.createChannel, { name: "private", private: true });
		await other.mutation(api.chats.addMembers, { chatId, userIds: [userId], agentIds: [] });
		await t.run(async (ctx) => {
			const seat = await ctx.db
				.query("chatMembers")
				.withIndex("by_user", (q) => q.eq("userId", userId).eq("chatId", chatId))
				.first();
			await ctx.db.patch(seat!._id, { lastReadAt: 0 });
		});
		await other.mutation(api.messages.send, { chatId, text: "@you secret", mentions: { userIds: [userId], agentIds: [] } });
		expect(await A.query(api.chats.alerts)).toHaveLength(1);

		await A.mutation(api.chats.leave, { chatId });
		expect(await A.query(api.chats.alerts)).toEqual([]);
		expect(await A.query(api.chats.get, { chatId })).toBeNull();
		expect(await A.query(api.messages.list, { chatId })).toEqual([]);
		await A.mutation(api.workspace.leave);
		expect(await A.query(api.chats.alerts)).toBeNull();
		expect(await B.query(api.chats.alerts)).toEqual([]);
	});
});
