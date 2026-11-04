import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { settle, signIn, newTest, workspaceOf, identityOf } from "./helpers";
import { person } from "./person";

// Deleting a workspace bigger than one transaction may write (16,000), with a message whose
// reactions alone span several runs: every run must stay under Convex's limits.

it("deletes a workspace with 17,000 messages and 2,500 reactions on one without exceeding transaction limits", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const chatId = (await owner.query(api.chats.list))!.channels[0]!._id;
	const message = { chatId, workspaceId, authorUserId: owner.userId, text: "hi", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" as const };
	for (let start = 0; start < 17_000; start += 2_000) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 2_000; i++) await ctx.db.insert("chatMessages", message);
		});
	}
	await t.run(async (ctx) => {
		const messageId = (await ctx.db.query("chatMessages").first())!._id;
		for (let i = 0; i < 2_500; i++) await ctx.db.insert("reactions", { messageId, chatId, emoji: `e${i}`, userId: owner.userId });
	});
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(workspaceId))).toBeNull();
	for (const table of ["chatMessages", "reactions", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first())).toBeNull();
});

// Removing someone takes one small transaction however much was theirs alone: the rest is the cascade's.
it("removes a member at once when their just-me automation has 16,000 subscribers and grants, then deletes them in batches", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	const agentId = (await member.query(api.agents.list))[0]!._id;
	await member.mutation(api.automations.create, { config: { name: "Mine", prompt: "p", trigger: { type: "webhook" } }, agentId, audience: "creator", timeZone: "UTC" });
	const install = (await t.run((ctx) => ctx.db.query("automationInstalls").first()))!;
	for (let start = 0; start < 16_000; start += 2_000) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 2_000; i++) {
				await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: owner.userId });
				await ctx.db.insert("permissionRules", { workspaceId: install.workspaceId, userId: owner.userId, action: `crm.a${i}`, automationInstallId: install._id, setting: "always", setAt: 0 });
			}
		});
	}
	const row = (await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first()))!;
	await owner.mutation(api.workspace.removeMember, { id: row._id });
	expect(await member.query(api.workspace.me)).toMatchObject({ workspaceId: null, role: null });
	await settle(t);
	for (const table of ["automationInstalls", "automationSubscriptions", "permissionRules", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first()), table).toBeNull();
});

// Rows are up to 1 MiB each: a run budgets the bytes it reads, not the rows, so big ones span runs.
it("deletes a workspace whose fields and records are near Convex's 1 MiB document limit without exceeding 16 MiB reads", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const label = "x".repeat(600_000);
	for (let type = 0; type < 3; type++) {
		await t.run(async (ctx) => {
			const at = { createdBy: owner.userId, updatedAt: 0, archived: false };
			const typeId = await ctx.db.insert("recordTypes", { workspaceId, key: `big${type}`, name: "Big", plural: "Bigs", ...at });
			for (let i = 0; i < 10; i++)
				await ctx.db.insert("recordFields", { workspaceId, typeId, key: `f${i}`, label: "Choice", kind: "choice", position: i, options: [{ id: "a", label }], ...at });
		});
	}
	const typeId = (await t.run((ctx) => ctx.db.query("recordTypes").first()))!._id;
	for (let start = 0; start < 30; start += 10) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 10; i++)
				await ctx.db.insert("records", { workspaceId, typeId, title: "Big", values: {}, searchText: "y".repeat(900_000), archived: false, createdBy: owner.userId, updatedAt: 0, updatedBy: owner.userId });
		});
	}
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(workspaceId))).toBeNull();
	for (const table of ["recordTypes", "recordFields", "records", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first()), table).toBeNull();
});

// Deleting a workspace ends access in one small transaction, however many members it has.
it("deletes a workspace with 4,100 members at once, and old apps of those also elsewhere act nowhere", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const elsewhere = await t.run((ctx) => ctx.db.insert("workspaces", { name: "Elsewhere", version: 1 }));
	const users = await t.run(async (ctx) => {
		const ids = [];
		for (let i = 0; i < 4_100; i++) {
			const userId = await ctx.db.insert("users", { email: `p${i}@co.com` });
			// Joined here first, then elsewhere, before old apps' pins existed: their first workspace is this one.
			await ctx.db.insert("members", { workspaceId, userId, role: "member" });
			if (i < 50) await ctx.db.insert("members", { workspaceId: elsewhere, userId, role: "member" });
			ids.push(userId);
		}
		return ids;
	});
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	const old = person(identityOf(t, users[0]!));
	expect(await old.query(api.workspace.me)).toMatchObject({ workspaceId: null });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(workspaceId))).toBeNull();
	// Still in Elsewhere, but an app that sends no workspace acts nowhere, never there.
	expect(await old.in(elsewhere).query(api.workspace.me)).toMatchObject({ workspaceId: elsewhere });
	expect(await old.query(api.workspace.me)).toMatchObject({ workspaceId: null });
	expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();
});

// Rows an edge skips stay in its range: when deciding takes big reads, a run that runs out of
// room must still move past them, never read the same ones again forever.
it("removes a member subscribed to many near-1 MiB automations elsewhere without rereading them forever", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	const here = await workspaceOf(owner);
	const { elsewhere, agentId } = await t.run(async (ctx) => {
		const elsewhere = await ctx.db.insert("workspaces", { name: "Elsewhere", version: 1 });
		await ctx.db.insert("members", { workspaceId: elsewhere, userId: member.userId, role: "owner" });
		const config = { name: "A", description: "", instructions: "", model: "m", tools: [] };
		const agentId = await ctx.db.insert("agents", { workspaceId: elsewhere, ...config, archived: false, version: 1, updatedAt: 0, updatedBy: member.userId });
		return { elsewhere, agentId };
	});
	const prompt = "p".repeat(900_000);
	for (let start = 0; start < 24; start += 8) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 8; i++) {
				const installId = await ctx.db.insert("automationInstalls", {
					workspaceId: elsewhere, agentId, enabled: false, timeZone: "UTC", automationId: `custom-${i}`, installedBy: member.userId, audience: "subscribers",
					custom: { name: "Big", prompt, trigger: { type: "webhook" }, version: 1, updatedBy: member.userId, updatedAt: 0 },
				});
				await ctx.db.insert("automationSubscriptions", { installId, userId: member.userId });
			}
		});
	}
	const row = (await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId).eq("workspaceId", here)).first()))!;
	await owner.mutation(api.workspace.removeMember, { id: row._id });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();
	// Their opt-ins elsewhere stay.
	expect(await t.run((ctx) => ctx.db.query("automationSubscriptions").collect())).toHaveLength(24);
});

// Someone in hundreds of 100-person workspaces: erasing them starts in a few reads per workspace,
// and deleting a workspace whose members are each in hundreds stays within limits.
it("erases an account in 331 workspaces of 100 people, then deletes one whose members are each in 331", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const A = await workspaceOf(owner);
	const users = await t.run(async (ctx) => {
		const ids = [];
		for (let i = 0; i < 100; i++) {
			const userId = await ctx.db.insert("users", { email: `p${i}@co.com` });
			await ctx.db.insert("members", { workspaceId: A, userId, role: "member" });
			ids.push(userId);
		}
		return ids;
	});
	const others = await t.run(async (ctx) => {
		const ids = [];
		for (let i = 0; i < 330; i++) ids.push(await ctx.db.insert("workspaces", { name: `W${i}`, version: 1 }));
		return ids;
	});
	for (let start = 0; start < users.length; start += 10)
		await t.run(async (ctx) => {
			for (const userId of users.slice(start, start + 10)) for (const workspaceId of others) await ctx.db.insert("members", { workspaceId, userId, role: "member" });
		});
	const erased = person(identityOf(t, users[0]!));
	await erased.mutation(api.workspace.eraseAccount);
	await settle(t);
	expect(await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", users[0]!)).first())).toBeNull();
	expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();

	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(A))).toBeNull();
	expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();
});
