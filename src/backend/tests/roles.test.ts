import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { memberDefaults } from "@companybot/core";
import { rolesOf } from "../convex/lib";
import { type As, agentTurn, agentsOf, newTest, ownerAndMember, settle, signIn, workspaceOf } from "./helpers";

type Person = As & { userId: Id<"users"> };
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

/** Owner, member, and the workspace's roles by name. */
async function setup() {
	const ctx = await ownerAndMember();
	const roles = async () => (await ctx.owner.query(api.roles.list))!;
	const id = async (name: string) => (await roles()).find((r) => r.name === name)!.id;
	const membership = async (as: Person) => (await ctx.owner.query(api.workspace.team))!.members.find((m) => m.userId === as.userId)!;
	return { ...ctx, roles, id, membership };
}

describe("roles", () => {
	it("gives Owner and Member to every workspace, and new roles only from owners", async () => {
		const { owner, member, roles } = await setup();
		expect((await roles()).map((r) => [r.name, r.builtIn, r.people])).toEqual([
			["Owner", "owner", 1],
			["Member", "member", 1],
		]);
		await expect(member.mutation(api.roles.create, { name: "Office" })).rejects.toThrow("Only people with the Owner role can change roles.");
		await owner.mutation(api.roles.create, { name: " Office " });
		await expect(owner.mutation(api.roles.create, { name: "office" })).rejects.toThrow("already a role called office");
		expect((await member.query(api.roles.list))!.map((r) => r.name)).toEqual(["Owner", "Member", "Office"]);
	});

	it("gives someone every switch any of their roles has", async () => {
		const { owner, member, id, membership } = await setup();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.roles.setPermission, { id: office, permission: "usage.view", on: true });
		expect((await member.query(api.workspace.me))!.access).toMatchObject({ owner: false });
		expect((await member.query(api.workspace.me))!.access!.permissions).not.toContain("usage.view");
		await owner.mutation(api.workspace.setRoles, { id: (await membership(member)).id, roles: [await id("Member"), office] });
		const { access } = (await member.query(api.workspace.me))!;
		expect(access!.permissions).toEqual(expect.arrayContaining(["usage.view", "records.edit", "skills.edit"]));
		expect((await member.query(api.usage.report, {}))!.scope).toBe("workspace");
		// Member alone is the default for new people: it has no say over the workspace.
		await owner.mutation(api.roles.setPermission, { id: office, permission: "usage.view", on: false });
		expect((await member.query(api.usage.report, {}))!.scope).toBe("mine");
	});

	it("stores only what an owner changed on Member, so its defaults (and new permissions') apply as they are", async () => {
		const { t, owner, member, id } = await setup();
		const stored = async (name: string) => {
			const roleId = await id(name);
			return t.run(async (ctx) => (await ctx.db.get(roleId))!.switches);
		};
		const memberRole = await id("Member");
		const flip = (roleId: Id<"roles">, permission: "records.edit" | "usage.view", on: boolean) => owner.mutation(api.roles.setPermission, { id: roleId, permission, on });
		expect(await stored("Member")).toEqual([]);
		expect((await member.query(api.workspace.me))!.access!.permissions).toEqual(memberDefaults);
		await flip(memberRole, "records.edit", false);
		await flip(memberRole, "usage.view", true);
		expect(await stored("Member")).toEqual([
			{ permission: "records.edit", on: false },
			{ permission: "usage.view", on: true },
		]);
		expect((await member.query(api.workspace.me))!.access!.permissions).not.toContain("records.edit");
		// Back to the default: nothing stored, so the default rules again.
		await flip(memberRole, "records.edit", true);
		await flip(memberRole, "usage.view", false);
		expect(await stored("Member")).toEqual([]);
		// A custom role stores what's on; anything new starts off.
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await flip(office, "records.edit", true);
		expect(await stored("Office")).toEqual([{ permission: "records.edit", on: true }]);
		expect((await owner.query(api.roles.list))!.find((r) => r.name === "Office")!.permissions).toEqual(["records.edit"]);
	});

	it("refuses a member without the switch, naming the roles that have it", async () => {
		const { owner, member } = await setup();
		await expect(member.mutation(api.workspace.updateSettings, { name: "X", expectedVersion: 1 })).rejects.toThrow(
			"Only people with the Owner role can change workspace settings. Ask someone who has it.",
		);
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.roles.setPermission, { id: office, permission: "workspace.manage", on: true });
		await expect(member.mutation(api.workspace.updateSettings, { name: "X", expectedVersion: 1 })).rejects.toThrow(
			"Only people with the Office or Owner role can change workspace settings. Ask someone who has one of them.",
		);
	});

	it("keeps Owner as it is, and Member as the default that can't be deleted", async () => {
		const { owner, id } = await setup();
		const ownerRole = await id("Owner");
		await expect(owner.mutation(api.roles.rename, { id: ownerRole, name: "Boss" })).rejects.toThrow("can't be changed");
		await expect(owner.mutation(api.roles.setPermission, { id: ownerRole, permission: "records.edit", on: false })).rejects.toThrow("can't be changed");
		await expect(owner.mutation(api.roles.remove, { id: ownerRole })).rejects.toThrow("can't be changed");
		await owner.mutation(api.roles.rename, { id: await id("Member"), name: "Crew" });
		await expect(owner.mutation(api.roles.remove, { id: await id("Crew") })).rejects.toThrow("can't be deleted");
		await expect(owner.mutation(api.roles.setPermission, { id: await id("Crew"), permission: "workspace.delete", on: true })).rejects.toThrow("isn't a switch");
	});

	it("never takes Owner from the last owner, and only owners give or take it", async () => {
		const { t, owner, member, id, membership } = await setup();
		const [ownerRole, memberRole] = [await id("Owner"), await id("Member")];
		const me = await membership(owner);
		await expect(owner.mutation(api.workspace.setRoles, { id: me.id, roles: [memberRole] })).rejects.toThrow("at least one owner");
		await expect(owner.mutation(api.workspace.leave, {})).rejects.toThrow("only owner");
		// Someone who manages members can't make anyone an owner, or touch an owner.
		const admins = await owner.mutation(api.roles.create, { name: "Admins" });
		await owner.mutation(api.roles.setPermission, { id: admins, permission: "members.manage", on: true });
		const them = await membership(member);
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [memberRole, admins] });
		await expect(member.mutation(api.workspace.setRoles, { id: them.id, roles: [ownerRole] })).rejects.toThrow("Only owners can make someone an owner.");
		await expect(member.mutation(api.workspace.setRoles, { id: me.id, roles: [memberRole] })).rejects.toThrow("Only owners can change an owner's roles.");
		await expect(member.mutation(api.workspace.removeMember, { id: me.id })).rejects.toThrow("Only owners can remove an owner.");
		await expect(member.mutation(api.workspace.invite, { email: "boss@co.com", roles: [ownerRole] })).rejects.toThrow("Only owners can make someone an owner.");
		await member.mutation(api.workspace.invite, { email: "crew@co.com", roles: [admins] });
		expect((await membership(owner)).roles).toEqual([ownerRole]);
		// With a second owner, the first can step down.
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [ownerRole] });
		await owner.mutation(api.workspace.setRoles, { id: me.id, roles: [memberRole] });
		expect((await owner.query(api.workspace.me))!.access).toMatchObject({ owner: false });
		await expect(member.mutation(api.workspace.setRoles, { id: them.id, roles: [] })).rejects.toThrow("Pick at least one role.");
		const crew = await signIn(t, "crew@co.com");
		expect((await crew.query(api.workspace.me))!.access!.roles).toEqual([admins]);
	});

	it("moves people and invites off a deleted role, without granting a replacement, and stops connectors allowing it", async () => {
		const { t, owner, member, id, membership } = await setup();
		const [office, crew] = [await owner.mutation(api.roles.create, { name: "Office" }), await owner.mutation(api.roles.create, { name: "Crew" })];
		const them = await membership(member);
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [office] });
		await owner.mutation(api.workspace.setRoles, { id: (await membership(owner)).id, roles: [await id("Owner"), office, crew] });
		await owner.mutation(api.workspace.invite, { email: "new@co.com", roles: [office] });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office, crew] });
		await owner.mutation(api.roles.remove, { id: office });
		expect((await membership(member)).roles).toEqual([]);
		expect((await membership(owner)).roles).toEqual([await id("Owner"), crew]);
		expect((await owner.query(api.workspace.team))!.invites[0]!.roles).toEqual([]);
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roles).toEqual([crew]);
		expect((await owner.query(api.roles.list))!.map((r) => r.name)).toEqual(["Owner", "Member", "Crew"]);
		expect((await member.query(api.workspace.me))!.access!.permissions).toEqual([]);
		await settle(t);
		expect((await member.query(api.workspace.me))!.access!.permissions).toEqual([]);
		expect(await t.run(async (ctx) => (await ctx.db.get(them.id))!.roles)).toEqual([]);
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [await id("Member")] });
	});

	it("keeps channels and pages restricted to Owners before and after scrubbing their only role", async () => {
		const { t, owner, member } = await setup();
		const workspaceId = await workspaceOf(owner);
		const role = await owner.mutation(api.roles.create, { name: "Temporary" });
		const chatId = await owner.mutation(api.chats.createChannel, { name: "restricted", private: false });
		await owner.mutation(api.chats.setAccess, { chatId, access: [{ role, level: "edit" }] });
		const pageId = await t.run((ctx) => ctx.db.insert("pages", { workspaceId, title: "Restricted", archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: 0, access: [{ role, level: "edit" }] }));
		await owner.mutation(api.roles.remove, { id: role });
		for (const scrubbed of [false, true]) {
			if (scrubbed) await settle(t);
			expect(await member.query(api.pages.get, { pageId })).toBeNull();
			expect(await owner.query(api.pages.get, { pageId })).not.toBeNull();
			expect((await member.query(api.chats.list))!.channels.some((c) => c._id === chatId)).toBe(false);
			expect((await owner.query(api.chats.list))!.channels.some((c) => c._id === chatId)).toBe(true);
		}
		expect(await t.run(async (ctx) => (await ctx.db.get(chatId))!.access)).toEqual([]);
		expect(await t.run(async (ctx) => (await ctx.db.get(pageId))!.access)).toEqual([]);
	});

	it("lets connectors be used by the roles picked for them; owners always", async () => {
		const { t, owner, member, id, membership } = await setup();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		const workspaceId = (await owner.query(api.workspace.me))!.workspaceId!;
		const usable = (as: Person) => t.query(internal.connectors.forTurn, { userId: as.userId, workspaceId, connectorIds: ["crm"] });
		const canUse = async (as: As) => (await as.query(api.connectors.list)).find((c) => c.id === "crm")!.canUse;
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roles).toEqual([await id("Member")]);
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office] });
		expect([await canUse(member), await usable(member)]).toEqual([false, []]);
		expect(await canUse(owner)).toBe(true);
		expect(await usable(owner)).toHaveLength(1);
		await owner.mutation(api.workspace.setRoles, { id: (await membership(member)).id, roles: [await id("Member"), office] });
		expect(await canUse(member)).toBe(true);
		expect(await usable(member)).toHaveLength(1);
		const elsewhere = await newTest().run(async (ctx) => ctx.db.insert("roles", { workspaceId: (await ctx.db.insert("workspaces", { name: "x", version: 1 })), name: "x", switches: [] }));
		await expect(owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [elsewhere as Id<"roles">] })).rejects.toThrow();
	});

	it("tells the agent which roles can, when the person it acts for can't", async () => {
		const { t, owner, member, id } = await setup();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.roles.setPermission, { id: office, permission: "fields.edit", on: true });
		await owner.mutation(api.roles.setPermission, { id: await id("Member"), permission: "fields.edit", on: false });
		const { companybot } = await agentsOf(member);
		const dm = (as: As) => as.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const turnId = await agentTurn(t, member, await dm(member), companybot._id);
		expect(await t.mutation(internal.permissions.check, { turnId, action: "records.save_database", risk: "inside" })).toEqual({
			decision: {
				type: "deny",
				by: "role",
				message: "Only people with the Office or Owner role can add and change databases and fields. Ask someone who has one of them.",
			},
		});
		// The same refusal comes back from the call itself, whatever path it takes.
		expect(await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { name: "Deals 2" } })).toEqual({
			error: "Only people with the Office or Owner role can add and change databases and fields. Ask someone who has one of them.",
		});
		const ownerTurn = await agentTurn(t, owner, await dm(owner), companybot._id);
		expect((await t.mutation(internal.permissions.check, { turnId: ownerTurn, action: "records.save_database", risk: "inside" })).decision.type).toBe("run");
	});

	it("keeps older apps' owner/member calls working on top of roles", async () => {
		const { owner, member, id, membership } = await setup();
		expect(await member.query(api.workspace.me)).toMatchObject({ role: "member" });
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const them = await membership(member);
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [await id("Member"), office] });
		await owner.mutation(api.workspace.setRole, { id: them.id, role: "owner" });
		expect((await membership(member)).roles).toEqual([await id("Owner"), await id("Member"), office]);
		expect(await member.query(api.workspace.me)).toMatchObject({ role: "owner" });
		await owner.mutation(api.workspace.setRole, { id: them.id, role: "member" });
		expect((await membership(member)).roles).toEqual([await id("Member"), office]);
		await owner.mutation(api.workspace.invite, { email: "old@co.com", role: "owner" });
		expect((await owner.query(api.workspace.team))!.invites).toMatchObject([{ email: "old@co.com", role: "owner", roles: [await id("Owner")] }]);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: ["owner", "member"] });
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roles).toEqual([await id("Member")]);
	});
});

describe("while the custom roles migration runs", () => {
	/**
	 * Turns the workspace back into one from before custom roles: memberships carry the old `role`,
	 * and, unless `seeded`, it has no roles yet (migrations.customRoles hasn't reached it).
	 */
	async function legacy(seeded: boolean) {
		const ctx = await ownerAndMember();
		const workspaceId = await workspaceOf(ctx.owner);
		await ctx.t.run(async (db) => {
			for (const row of await db.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect())
				await db.db.patch(row._id, { roles: undefined, role: row.userId === ctx.owner.userId ? "owner" : "member" });
			if (!seeded) for (const r of await rolesOf(db, workspaceId)) await db.db.delete(r._id);
		});
		return { ...ctx, workspaceId };
	}

	for (const seeded of [false, true])
		describe(seeded ? "roles seeded, people not moved yet" : "before the workspace has roles", () => {
			it("reads old owners and members as Owner and Member", async () => {
				const { owner, member } = await legacy(seeded);
				expect((await owner.query(api.workspace.me))!.access).toMatchObject({ owner: true });
				expect((await member.query(api.workspace.me))!.access).toMatchObject({ owner: false, permissions: memberDefaults });
				expect((await owner.query(api.workspace.mine))!.workspaces).toMatchObject([{ owner: true, role: "owner" }]);
				expect((await owner.query(api.workspace.team))!.members.map((m) => m.role)).toEqual(["owner", "member"]);
			});

			it("keeps a shared workspace when an ordinary member erases their account", async () => {
				const { t, owner, member, workspaceId } = await legacy(seeded);
				await member.mutation(api.workspace.eraseAccount);
				await settle(t);
				expect(await t.run((ctx) => ctx.db.get(workspaceId))).toMatchObject({ name: "My company" });
				expect((await owner.query(api.workspace.team))!.members.map((m) => m.email)).toEqual(["owner@co.com"]);
			});

			it("won't let the only owner leave or erase their account", async () => {
				const { owner } = await legacy(seeded);
				await expect(owner.mutation(api.workspace.leave, {})).rejects.toThrow("only owner");
				await expect(owner.mutation(api.workspace.eraseAccount)).rejects.toThrow("only owner of My company");
			});

			it("makes an owner from an Owner invite sent before the migration", async () => {
				const { t, owner, workspaceId } = await legacy(seeded);
				await t.run((ctx) => ctx.db.insert("invites", { workspaceId, email: "boss@co.com", role: "owner", invitedBy: owner.userId }));
				expect((await owner.query(api.workspace.team))!.invites).toMatchObject([{ email: "boss@co.com", role: "owner" }]);
				const boss = await signIn(t, "boss@co.com");
				expect((await boss.query(api.workspace.me))!.access).toMatchObject({ owner: true });
				// Two owners now, so the first can go.
				await owner.mutation(api.workspace.leave, {});
			});

			it("keeps an old member's use of a connector that lists \"member\"", async () => {
				const { t, owner, member, workspaceId } = await legacy(true);
				await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
				await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
				await t.run(async (ctx) => {
					const install = (await ctx.db.query("connectorInstalls").collect())[0]!;
					await ctx.db.patch(install._id, { roles: ["owner", "member"] });
					if (!seeded) for (const r of await rolesOf(ctx, workspaceId)) await ctx.db.delete(r._id);
				});
				expect((await member.query(api.connectors.list)).find((c) => c.id === "crm")).toMatchObject({ canUse: true });
				expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId, connectorIds: ["crm"] })).toHaveLength(1);
			});
		});

	it("still treats an old owner as one after someone else's roles moved", async () => {
		const { t, owner, member, workspaceId } = await legacy(true);
		const memberRole = (await t.run((ctx) => rolesOf(ctx, workspaceId))).find((r) => r.builtIn === "member")!._id;
		await t.run(async (ctx) => {
			const row = (await ctx.db.query("members").collect()).find((m) => m.userId === member.userId)!;
			await ctx.db.patch(row._id, { role: undefined, roles: [memberRole] });
		});
		const ownerRow = (await owner.query(api.workspace.team))!.members.find((m) => m.userId === owner.userId)!;
		await expect(owner.mutation(api.workspace.setRoles, { id: ownerRow.id, roles: [memberRole] })).rejects.toThrow("at least one owner");
		await expect(member.mutation(api.workspace.removeMember, { id: ownerRow.id })).rejects.toThrow();
		await expect(owner.mutation(api.workspace.leave, {})).rejects.toThrow("only owner");
	});

	it("lets Member's people use a connector that still lists \"member\"", async () => {
		const { t, owner, member, id } = await setup();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		await t.run(async (ctx) => {
			const install = (await ctx.db.query("connectorInstalls").collect())[0]!;
			await ctx.db.patch(install._id, { roles: ["owner", "member"] });
		});
		const workspaceId = await workspaceOf(owner);
		expect((await member.query(api.connectors.list)).find((c) => c.id === "crm")).toMatchObject({ canUse: true, roles: [await id("Member")] });
		expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId, connectorIds: ["crm"] })).toHaveLength(1);
	});
});

describe("the custom roles migration", () => {
	it("gives old workspaces Owner and Member, moves people, invites and connectors to them, and clears the old field", async () => {
		const t = newTest();
		migrationsTest.register(t);
		const { workspaceId, ownerId, memberId } = await t.run(async (ctx) => {
			const workspaceId = await ctx.db.insert("workspaces", { name: "Old Co", version: 1 });
			const ownerId = await ctx.db.insert("users", { email: "owner@old.co" });
			const memberId = await ctx.db.insert("users", { email: "member@old.co" });
			await ctx.db.insert("members", { workspaceId, userId: ownerId, role: "owner", email: "owner@old.co" });
			await ctx.db.insert("members", { workspaceId, userId: memberId, role: "member", email: "member@old.co" });
			await ctx.db.insert("invites", { workspaceId, email: "next@old.co", role: "owner", invitedBy: ownerId });
			await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "crm", roles: ["owner", "member"], installedBy: ownerId });
			await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "notes", roles: ["owner"], installedBy: ownerId });
			return { workspaceId, ownerId, memberId };
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			// Safe to run again: nothing changes.
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({
			roles: await ctx.db.query("roles").collect(),
			members: await ctx.db.query("members").collect(),
			invites: await ctx.db.query("invites").collect(),
			installs: await ctx.db.query("connectorInstalls").collect(),
		}));
		const role = (which: string) => after.roles.find((r) => r.builtIn === which)!._id;
		expect(after.roles.map((r) => [r.workspaceId, r.name, r.builtIn])).toEqual([
			[workspaceId, "Owner", "owner"],
			[workspaceId, "Member", "member"],
		]);
		expect(after.members.map((m) => [m.userId, m.roles, m.role])).toEqual([
			[ownerId, [role("owner")], undefined],
			[memberId, [role("member")], undefined],
		]);
		expect(after.invites.map((i) => [i.roles, i.role])).toEqual([[[role("owner")], undefined]]);
		expect(after.installs.map((i) => [i.connectorId, i.roles])).toEqual([
			["crm", [role("member")]],
			["notes", []],
		]);
	});
});
