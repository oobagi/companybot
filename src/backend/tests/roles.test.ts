import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { memberDefaults } from "@companybot/core";
import { builtInRoleOf, type As, agentTurn, agentsOf, newTest, ownerAndMember, settle, signIn, workspaceOf } from "./helpers";

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

	it("lets a fresh Member make personal skills and automations, but not team ones, databases or fields", async () => {
		const { member } = await setup();
		const skill = { name: "Quote follow-up", description: "Chase a quote nobody answered.", instructions: "Write one short reminder." };
		const { companybot } = await agentsOf(member);
		const automation = { config: { name: "Standup", prompt: "Ask for updates.", trigger: { type: "webhook" as const } }, agentId: companybot._id, timeZone: "UTC" };
		const client = (await member.query(api.recordTypes.list)).find((x) => x.key === "client")!;
		await expect(member.mutation(api.skills.create, { config: skill, audience: "team" })).rejects.toThrow("can make and change team skills");
		await expect(member.mutation(api.automations.create, { ...automation, audience: "subscribers" })).rejects.toThrow("can make and change team automations");
		await expect(member.mutation(api.recordTypes.create, { plural: "Jobs" })).rejects.toThrow("can add and change databases and fields");
		await expect(member.mutation(api.fields.create, { typeId: client._id, label: "Roof", kind: "text" })).rejects.toThrow("can add and change databases and fields");
		await member.mutation(api.skills.create, { config: skill, audience: "personal" });
		await member.mutation(api.automations.create, { ...automation, audience: "creator" });
		expect((await member.query(api.skills.list)).filter((x) => x.custom)).toHaveLength(1);
		expect((await member.query(api.automations.list)).filter((x) => x.custom)).toHaveLength(1);
		// Records stay open: working the data is everyone's job.
		await member.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
	});

	it("gives someone every switch any of their roles has", async () => {
		const { owner, member, id, membership } = await setup();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.roles.setPermission, { id: office, permission: "usage.view", on: true });
		expect((await member.query(api.workspace.me))!.access).toMatchObject({ owner: false });
		expect((await member.query(api.workspace.me))!.access!.permissions).not.toContain("usage.view");
		await owner.mutation(api.workspace.setRoles, { id: (await membership(member)).id, roles: [await id("Member"), office] });
		const { access } = (await member.query(api.workspace.me))!;
		expect(access!.permissions).toEqual(expect.arrayContaining(["usage.view", "records.edit", "channels.edit"]));
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
		await expect(member.mutation(api.workspace.setRoles, { id: them.id, roles: [ownerRole] })).rejects.toThrow("You can't change your own roles.");
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

	it("lets someone who hands out roles give or take only Member and roles they have, and never their own", async () => {
		const { t, owner, member, id, membership } = await setup();
		const memberRole = await id("Member");
		const admins = await owner.mutation(api.roles.create, { name: "Admins" });
		await owner.mutation(api.roles.setPermission, { id: admins, permission: "members.manage", on: true });
		// Office has only switches the member has too: holding the switches isn't enough, they must have the role.
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		await owner.mutation(api.roles.setPermission, { id: office, permission: "members.manage", on: true });
		await owner.mutation(api.workspace.setRoles, { id: (await membership(member)).id, roles: [memberRole, admins] });
		await owner.mutation(api.workspace.invite, { email: "dana@co.com", roles: [memberRole] });
		const dana = await signIn(t, "dana@co.com");
		const self = (await membership(member)).id;
		const them = (await membership(dana)).id;
		// Not to themselves.
		await expect(member.mutation(api.workspace.setRoles, { id: self, roles: [memberRole, admins, office] })).rejects.toThrow("You can't change your own roles.");
		await expect(member.mutation(api.workspace.setRoles, { id: self, roles: [memberRole] })).rejects.toThrow("You can't change your own roles.");
		// Nor a role they don't have, to anyone, by invite either; nor taking one away.
		await expect(member.mutation(api.workspace.setRoles, { id: them, roles: [memberRole, office] })).rejects.toThrow("Only Owners and people who have Office");
		await expect(member.mutation(api.workspace.invite, { email: "new@co.com", roles: [office] })).rejects.toThrow("Office");
		await owner.mutation(api.workspace.setRoles, { id: them, roles: [memberRole, office] });
		await expect(member.mutation(api.workspace.setRoles, { id: them, roles: [memberRole] })).rejects.toThrow("Office");
		// Roles they have, and Member, are fine; keeping Office as it is too.
		await member.mutation(api.workspace.setRoles, { id: them, roles: [memberRole, office, admins] });
		await member.mutation(api.workspace.invite, { email: "old@co.com", roles: [await builtInRoleOf(member, "member")] });
		expect([...(await membership(dana)).roles].sort()).toEqual([memberRole, office, admins].sort());
		expect((await membership(member)).roles).toEqual([memberRole, admins]);
	});

	describe("someone who hands out roles but isn't in Finance (Deals is Finance-only)", () => {
		async function managed() {
			const ctx = await setup();
			const { owner, member, id, membership } = ctx;
			const managers = await owner.mutation(api.roles.create, { name: "Managers" });
			await owner.mutation(api.roles.setPermission, { id: managers, permission: "members.manage", on: true });
			await owner.mutation(api.workspace.setRoles, { id: (await membership(member)).id, roles: [await id("Member"), managers] });
			// Finance has no switches: it only opens places.
			const finance = await owner.mutation(api.roles.create, { name: "Finance" });
			const deals = (await owner.query(api.recordTypes.list)).find((x) => x.key === "deal")!._id;
			await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [{ role: finance, level: "edit" }] });
			const office = await owner.mutation(api.roles.create, { name: "Office" });
			await owner.mutation(api.roles.setPermission, { id: office, permission: "fields.edit", on: true });
			return { ...ctx, managers, finance, deals, office };
		}
		const typeIds = async (as: As) => (await as.query(api.recordTypes.list)).map((x) => x._id);

		it("can't invite a second account of theirs into Finance to open Deals", async () => {
			const { t, member, finance, deals } = await managed();
			expect(await typeIds(member)).not.toContain(deals);
			await expect(member.mutation(api.workspace.invite, { email: "me.alt@co.com", roles: [finance] })).rejects.toThrow("Only Owners and people who have Finance");
			const alt = await signIn(t, "me.alt@co.com");
			expect(await typeIds(alt)).not.toContain(deals);
		});

		it("can't take a role they don't have by removing the person or cancelling the invite, themselves or through an agent", async () => {
			const { t, owner, member, id, membership, office } = await managed();
			await owner.mutation(api.workspace.invite, { email: "dana@co.com", roles: [await id("Member"), office] });
			const dana = await signIn(t, "dana@co.com");
			await expect(member.mutation(api.workspace.removeMember, { id: (await membership(dana)).id })).rejects.toThrow("Only Owners and people who have Office can remove someone who has it.");
			await owner.mutation(api.workspace.invite, { email: "erin@co.com", roles: [office] });
			const invite = (await owner.query(api.workspace.team))!.invites.find((i) => i.email === "erin@co.com")!;
			await expect(member.mutation(api.workspace.cancelInvite, { id: invite.id })).rejects.toThrow("Only Owners and people who have Office can cancel an invite with it.");
			// The agent's tools go through the same checks.
			const { companybot } = await agentsOf(member);
			await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [...companybot.tools, "members.invite", "members.remove"] }));
			const turnId = await agentTurn(t, member, (await member.query(api.chats.list))!.channels.find((c) => c.isDefault)!._id, companybot._id);
			const manage = (tool: string, request: object) => t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
			expect(await manage("members.remove", { action: "remove", email: "dana@co.com" })).toMatchObject({ error: expect.stringContaining("people who have Office") });
			expect(await manage("members.invite", { action: "cancel", email: "erin@co.com" })).toMatchObject({ error: expect.stringContaining("people who have Office") });
			vi.useRealTimers();
			expect((await owner.query(api.workspace.team))!.invites.some((i) => i.email === "erin@co.com")).toBe(true);
			expect((await membership(dana)).roles).toContain(office);
			// Member-only people and invites are theirs to remove.
			await member.mutation(api.workspace.invite, { email: "fay@co.com", roles: [await builtInRoleOf(member, "member")] });
			const fay = (await owner.query(api.workspace.team))!.invites.find((i) => i.email === "fay@co.com")!;
			await member.mutation(api.workspace.cancelInvite, { id: fay.id });
			await owner.mutation(api.workspace.setRoles, { id: (await membership(dana)).id, roles: [await id("Member")] });
			await member.mutation(api.workspace.removeMember, { id: (await membership(dana)).id });
		});

		it("joins someone they invited with a role they can't give as Member instead; an Owner's invite keeps it", async () => {
			const { t, owner, member, id, office } = await managed();
			const workspaceId = await workspaceOf(owner);
			// As an invite made before the rule, or before the inviter lost the role.
			await t.run(async (ctx) => {
				await ctx.db.insert("invites", { workspaceId, email: "old@co.com", roles: [office], invitedBy: member.userId });
				await ctx.db.insert("invites", { workspaceId, email: "boss@co.com", roles: [office], invitedBy: owner.userId });
			});
			const old = await signIn(t, "old@co.com");
			expect((await old.query(api.workspace.me))!.access!.roles).toEqual([await id("Member")]);
			const boss = await signIn(t, "boss@co.com");
			expect((await boss.query(api.workspace.me))!.access!.roles).toEqual([office]);
		});
	});

	it("moves people and invites off a deleted role, invites left with none to Member, and stops connectors allowing it", async () => {
		const { t, owner, member, id, membership } = await setup();
		const [office, crew] = [await owner.mutation(api.roles.create, { name: "Office" }), await owner.mutation(api.roles.create, { name: "Crew" })];
		const them = await membership(member);
		await owner.mutation(api.workspace.setRoles, { id: them.id, roles: [office] });
		await owner.mutation(api.workspace.setRoles, { id: (await membership(owner)).id, roles: [await id("Owner"), office, crew] });
		await owner.mutation(api.workspace.invite, { email: "new@co.com", roles: [office] });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office, crew] });
		await owner.mutation(api.workspace.invite, { email: "both@co.com", roles: [office, crew] });
		// The confirmation counts invites that give it, not just people.
		expect((await owner.query(api.roles.list))!.find((r) => r.id === office)).toMatchObject({ people: 2, invited: 2 });
		await owner.mutation(api.roles.remove, { id: office });
		await settle(t);
		expect((await membership(member)).roles).toEqual([]);
		expect((await membership(owner)).roles).toEqual([await id("Owner"), crew]);
		// An invite it was the only role of joins as Member, as one sent without a role does; others keep the rest.
		const invites = (await owner.query(api.workspace.team))!.invites;
		expect(invites.find((i) => i.email === "new@co.com")!.roles).toEqual([await id("Member")]);
		expect(invites.find((i) => i.email === "both@co.com")!.roles).toEqual([crew]);
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roleIds).toEqual([crew]);
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

	it("replaces a connector's roles with the ids the app saves", async () => {
		const { owner, id } = await setup();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const roleIds = async () => (await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roleIds;
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [await id("Member"), office] });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office] });
		expect(await roleIds()).toEqual([office]);
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [] });
		expect(await roleIds()).toEqual([]);
	});

	it("lets connectors be used by the roles picked for them; owners always", async () => {
		const { t, owner, member, id, membership } = await setup();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		const workspaceId = (await owner.query(api.workspace.me))!.workspaceId!;
		const usable = (as: Person) => t.query(internal.connectors.forTurn, { userId: as.userId, workspaceId, connectorIds: ["crm"] });
		const canUse = async (as: As) => (await as.query(api.connectors.list)).find((c) => c.id === "crm")!.canUse;
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")!.roleIds).toEqual([await id("Member")]);
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
			risk: "inside",
		});
		// The same refusal comes back from the call itself, whatever path it takes.
		expect(await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { name: "Deals 2" } })).toEqual({
			error: "Only people with the Office or Owner role can add and change databases and fields. Ask someone who has one of them.",
		});
		const ownerTurn = await agentTurn(t, owner, await dm(owner), companybot._id);
		expect((await t.mutation(internal.permissions.check, { turnId: ownerTurn, action: "records.save_database", risk: "inside" })).decision.type).toBe("run");
	});
});
