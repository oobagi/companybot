import { modules, settle } from "./helpers";
import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pinLegacyWorkspace } from "../convex/lib";
import schema from "../convex/schema";
import { person } from "./person";

// Apps from before workspace switching (alpha.5) name no workspace: they act in the pinned first
// one (lib.ts legacyMemberOf), never another the person is in. Edge cases from security review.
// COMPAT(0.1.0-alpha.7): delete with legacyMemberOf.

const UPDATE = "Update Companybot to open your workspaces";

/** Someone who started A on an old app, with a second owner (deputy). `unpinned`: from before pinning. */
async function setup(unpinned = false) {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	const userId = await t.run((ctx) => ctx.db.insert("users", { email: "target@co.com" }));
	const old = person(t.withIdentity({ subject: `${userId}|session` }));
	await old.mutation(api.workspace.ensure);
	const a = (await old.query(api.workspace.me))!.workspaceId!;
	const deputyId = await t.run(async (ctx) => {
		const id = await ctx.db.insert("users", { email: "deputy@co.com" });
		await ctx.db.insert("members", { userId: id, workspaceId: a, role: "owner" });
		if (unpinned) for (const pin of await ctx.db.query("legacyWorkspaces").collect()) await ctx.db.delete(pin._id);
		return id;
	});
	const deputy = person(t.withIdentity({ subject: `${deputyId}|session` })).in(a);
	/** The deputy removes them from A. */
	const remove = async () => {
		const row = await t.run((ctx) =>
			ctx.db
				.query("members")
				.withIndex("by_user", (q) => q.eq("userId", userId).eq("workspaceId", a))
				.first(),
		);
		await deputy.mutation(api.workspace.removeMember, { id: row!._id });
	};
	const pins = () => t.run((ctx) => ctx.db.query("legacyWorkspaces").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
	const inviteTo = (name: string, role: "owner" | "member" = "member") =>
		t.run(async (ctx) => {
			const workspaceId = await ctx.db.insert("workspaces", { name, version: 1 });
			await ctx.db.insert("members", { workspaceId, userId: await ctx.db.insert("users", {}), role: "owner" });
			const id = await ctx.db.insert("invites", { workspaceId, email: "target@co.com", role });
			return { workspaceId, id };
		});
	return { t, userId, old, a, deputy, remove, pins, inviteTo };
}

async function migrate(t: ReturnType<typeof convexTest>) {
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
}

it("works for a sole workspace, pinned or not, before and after the (idempotent) backfill", async () => {
	for (const unpinned of [false, true]) {
		const { t, old, a, pins } = await setup(unpinned);
		expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
		await old.mutation(api.workspace.updateSettings, { name: "legitimate", expectedVersion: 1 });
		await migrate(t);
		const pinned = await pins();
		await migrate(t);
		expect(await pins()).toEqual(pinned);
		expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
	}
});

it("pins before a removal, so someone unpinned can't be moved into the next workspace they join", async () => {
	const { t, old, a, remove, pins, inviteTo } = await setup(true);
	const draft = (await old.query(api.workspace.settings))!;
	await remove();
	expect(await pins()).toMatchObject([{ workspaceId: a }]);
	const b = await inviteTo("Company B", "owner");
	await expect(old.mutation(api.workspace.ensure)).resolves.toBeNull();
	// In B now, but old apps stay pinned to A, which they've left: they say to update.
	expect((await old.query(api.workspace.mine))!.workspaces.map((w) => w.id)).toEqual([b.workspaceId]);
	expect((await old.query(api.workspace.me))!.role).toBeNull();
	await expect(old.mutation(api.workspace.ensure)).rejects.toThrow(UPDATE);
	await expect(old.mutation(api.workspace.updateSettings, { name: "Stale A draft", expectedVersion: draft.version })).rejects.toThrow(
		"Sign in to a workspace first",
	);
	expect((await old.in(b.workspaceId).query(api.workspace.settings))!.name).toBe("Company B");
	await migrate(t);
	expect((await old.query(api.workspace.me))!.role).toBeNull();
});

it("pins before leaving too", async () => {
	const { old, a, pins } = await setup(true);
	await old.in(a).mutation(api.workspace.leave);
	expect(await pins()).toMatchObject([{ workspaceId: a }]);
});

it("re-pins to the fresh workspace someone in none at all gets, so the old app works there", async () => {
	for (const unpinned of [false, true]) {
		const { old, a, remove, pins } = await setup(unpinned);
		await remove();
		await old.mutation(api.workspace.ensure);
		const mine = (await old.query(api.workspace.mine))!;
		expect(mine.workspaces).toHaveLength(1);
		const fresh = mine.workspaces[0]!.id;
		expect(fresh).not.toBe(a);
		expect(await pins()).toMatchObject([{ workspaceId: fresh }]);
		expect(await old.query(api.workspace.me)).toMatchObject({ workspaceId: fresh, role: "owner" });
		await old.mutation(api.chats.createChannel, { name: "works", private: false });
	}
});

it("keeps the A pin through joining B, leaving A and rejoining A", async () => {
	const { t, old, a, deputy, inviteTo } = await setup();
	await old.mutation(api.workspace.acceptInvite, { id: (await inviteTo("B")).id });
	await old.in(a).mutation(api.workspace.leave);
	await settle(t);
	expect((await old.query(api.workspace.me))!.role).toBeNull();
	await expect(old.mutation(api.workspace.ensure)).rejects.toThrow(UPDATE);
	await deputy.mutation(api.workspace.invite, { email: "target@co.com", role: "member" });
	await old.mutation(api.workspace.acceptInvite, { id: (await old.query(api.workspace.mine))!.invitations[0]!.id });
	expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
});

it("fails closed when the first workspace is deleted, despite a membership in B", async () => {
	const { t, old, a, inviteTo } = await setup();
	await old.mutation(api.workspace.acceptInvite, { id: (await inviteTo("B")).id });
	await t.run(async (ctx) => {
		for (const row of await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", a))
			.collect())
			await ctx.db.delete(row._id);
		await ctx.db.delete(a);
	});
	expect((await old.query(api.workspace.me))!.role).toBeNull();
	expect((await old.query(api.workspace.mine))!.workspaces).toHaveLength(1);
	await expect(old.mutation(api.workspace.ensure)).rejects.toThrow(UPDATE);
});

it("gives someone new with two invites the first, after the backfill", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	await migrate(t);
	const userId = await t.run(async (ctx) => {
		const id = await ctx.db.insert("users", { email: "new@co.com" });
		for (const name of ["A", "B"]) {
			const workspaceId = await ctx.db.insert("workspaces", { name, version: 1 });
			await ctx.db.insert("members", { workspaceId, userId: await ctx.db.insert("users", {}), role: "owner" });
			await ctx.db.insert("invites", { workspaceId, email: "new@co.com", role: "member" });
		}
		return id;
	});
	const old = person(t.withIdentity({ subject: `${userId}|session` }));
	await old.mutation(api.workspace.ensure);
	expect((await old.query(api.workspace.mine))!.workspaces).toHaveLength(2);
	expect((await old.query(api.workspace.me))!.workspace).toBe("A");
	await old.mutation(api.chats.createChannel, { name: "works", private: false });
});

it("backfills the earliest membership, and pinning again never moves it", async () => {
	const { t, userId, old, a, pins } = await setup(true);
	await t.run(async (ctx) => {
		const b = await ctx.db.insert("workspaces", { name: "B", version: 1 });
		await ctx.db.insert("members", { userId, workspaceId: b, role: "owner" });
	});
	expect((await old.query(api.workspace.me))!.role).toBeNull();
	await migrate(t);
	expect((await old.query(api.workspace.me))!.workspaceId).toBe(a);
	const before = await pins();
	await t.run((ctx) => pinLegacyWorkspace(ctx, userId));
	await t.run((ctx) => pinLegacyWorkspace(ctx, userId));
	expect(await pins()).toEqual(before);
});

// The reviewer's independent check of reads, restores and nested ids the main sweep
// (workspaces.test.ts) left out.
it("pins the workspace joined first, not the oldest workspace", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const userId = await t.run(async (ctx) => {
		const older = await ctx.db.insert("workspaces", { name: "Older", version: 1 });
		const newer = await ctx.db.insert("workspaces", { name: "Newer", version: 1 });
		const userId = await ctx.db.insert("users", { email: "p@co.com" });
		await ctx.db.insert("members", { workspaceId: newer, userId, role: "member" });
		await ctx.db.insert("members", { workspaceId: older, userId, role: "member" });
		await pinLegacyWorkspace(ctx, userId);
		return userId;
	});
	const pin = await t.run((ctx) => ctx.db.query("legacyWorkspaces").first());
	expect(await t.run(async (ctx) => (await ctx.db.get(pin!.workspaceId))?.name)).toBe("Newer");
	expect(pin?.userId).toBe(userId);
});

it("refuses ids from the other workspace in reads, restores and nested ids", async () => {
	const { t, userId, old, a } = await setup();
	const A = old.in(a);
	const b = await t.run(async (ctx) => {
		const id = await ctx.db.insert("workspaces", { name: "B", version: 1 });
		await ctx.db.insert("members", { userId, workspaceId: id, role: "owner" });
		return id;
	});
	const B = old.in(b);
	const chat = (await A.query(api.chats.list))!.channels[0]!._id;
	const agent = (await A.query(api.agents.list))[0]!;
	const message = await A.mutation(api.messages.send, { chatId: chat, text: "secret", mentions: { userIds: [], agentIds: [] } });
	const type = (await A.query(api.recordTypes.list))[0]!._id;
	const field = (await A.mutation(api.fields.create, { typeId: type, label: "Review", kind: "text" }))._id;
	const record = await A.mutation(api.records.create, { typeId: type, values: { name: "review secret" } });
	const page = { numItems: 10, cursor: null };

	expect(await B.query(api.chats.place, { chatId: chat })).toBeNull();
	expect(await B.query(api.activity.forReply, { replyId: message })).toEqual([]);
	expect(await B.query(api.activity.list, { agentId: agent._id })).toEqual([]);
	expect(await B.query(api.approvals.forReply, { replyId: message })).toEqual([]);
	expect((await B.query(api.records.list, { typeId: type, paginationOpts: page })).page).toEqual([]);
	expect((await B.query(api.records.history, { recordId: record, paginationOpts: page })).page).toEqual([]);
	expect((await B.query(api.records.linked, { recordId: record, fieldId: field, paginationOpts: page })).page).toEqual([]);
	expect(await B.query(api.records.search, { query: "review", typeId: type })).toEqual([]);
	expect(await B.query(api.records.discussion, { recordId: record })).toEqual([]);
	expect(await B.query(api.records.refs, { ids: [record] })).toEqual({});

	await expect(B.mutation(api.records.restore, { recordId: record })).rejects.toThrow("Record not found");
	await expect(B.mutation(api.fields.restore, { fieldId: field })).rejects.toThrow("Field not found");
	await expect(B.mutation(api.agents.restore, { agentId: agent._id, version: 1, expectedVersion: agent.version })).rejects.toThrow(
		"Agent not found",
	);
	await expect(B.mutation(api.chats.openDm, { userIds: [], agentIds: [agent._id] })).rejects.toThrow(/available/);

	const bChat = await B.mutation(api.chats.createChannel, { name: "b-chat", private: false });
	expect(await B.query(api.messages.list, { chatId: bChat, threadId: message })).toEqual([]);
	expect(await B.query(api.chats.place, { chatId: bChat, threadId: message })).toBeNull();
	await expect(
		B.mutation(api.messages.send, { chatId: bChat, threadId: message, text: "x", mentions: { userIds: [], agentIds: [] } }),
	).rejects.toThrow("thread doesn't exist");
	const bType: Id<"recordTypes"> = (await B.query(api.recordTypes.list))[0]?._id ?? (await B.mutation(api.recordTypes.create, { name: "Thing", plural: "Things" }));
	await expect(B.mutation(api.fields.create, { typeId: bType, label: "Leak", kind: "link", linkTypeId: type })).rejects.toThrow(
		"Record type not found",
	);
	await expect(
		B.mutation(api.automations.create, {
			config: { name: "x", prompt: "x", trigger: { type: "event", event: "member.joined" } },
			agentId: agent._id,
			audience: "creator",
			timeZone: "UTC",
		}),
	).rejects.toThrow("Agent not found");
});
