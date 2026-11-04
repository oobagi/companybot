import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { agentTurn, agentsOf, generalOf, modules, ownerAndMember, setMemberSwitch, settle } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const config = { name: "My process", description: "My private process", instructions: "Private instructions" };

it("keeps personal skills private in settings, agent tools, turn context and Archive, even from owners", async () => {
	const { t, owner, member } = await ownerAndMember();
	const id = await member.mutation(api.skills.create, { config, audience: "personal" });
	const { companybot } = await agentsOf(owner);
	const dm = (as: typeof member) => as.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const mine = await agentTurn(t, member, await dm(member), companybot._id);
	const theirs = await agentTurn(t, owner, await dm(owner), companybot._id);
	expect((await t.query(internal.turns.turnContext, { turnId: mine })).skills.map(s => s.id)).toContain(id);
	expect((await t.query(internal.turns.turnContext, { turnId: theirs })).skills.map(s => s.id)).not.toContain(id);
	const call = (turnId: typeof mine, request: unknown) => t.mutation(internal.manageTools.runFor, { turnId, tool: "skills.manage", input: { request } });
	expect(await owner.query(api.skills.list)).toEqual([]);
	expect(await call(theirs, { action: "list" })).toMatchObject({ page: [] });
	expect(await call(theirs, { action: "get", id })).toHaveProperty("error");
	expect(await call(mine, { action: "get", id })).toMatchObject({ instructions: config.instructions, canEdit: true });
	await expect(owner.mutation(api.skills.save, { skillId: id, config, expectedVersion: 1 })).rejects.toThrow("not found");
	await expect(owner.mutation(api.skills.remove, { skillId: id })).rejects.toThrow("not found");
	await member.mutation(api.skills.remove, { skillId: id });
	const args = { kind: "skill" as const, paginationOpts: { numItems: 10, cursor: null } };
	expect((await owner.query(api.trash.list, args)).page).toEqual([]);
	expect((await member.query(api.trash.list, args)).page).toHaveLength(1);
});

it("allows personal creation without a switch, defaults to personal, and requires the switch to share", async () => {
	const { owner, member } = await ownerAndMember();
	await setMemberSwitch(owner, "skills.edit", false);
	const id = await member.mutation(api.skills.create, { config });
	expect(await member.query(api.skills.list)).toMatchObject([{ audience: "personal", canEdit: true }]);
	await member.mutation(api.skills.save, { skillId: id, config, expectedVersion: 1 });
	await expect(member.mutation(api.skills.create, { config, audience: "team" })).rejects.toThrow("Only people");
	await expect(member.mutation(api.skills.share, { skillId: id })).rejects.toThrow("Only people");
	await expect(owner.mutation(api.skills.share, { skillId: id })).rejects.toThrow("not found");
	await setMemberSwitch(owner, "skills.edit", true);
	await member.mutation(api.skills.share, { skillId: id });
	expect(await owner.query(api.skills.list)).toMatchObject([{ audience: "team" }]);
});

it("makes agent-created skills personal when the asker lacks the team switch", async () => {
	const { t, owner, member } = await ownerAndMember();
	await setMemberSwitch(owner, "skills.edit", false);
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, member, (await generalOf(member))._id, companybot._id);
	expect(await t.mutation(internal.skills.createFor, { turnId, config, audience: "team" })).toHaveProperty("created");
	expect(await member.query(api.skills.list)).toMatchObject([{ audience: "personal" }]);
	expect(await owner.query(api.skills.list)).toEqual([]);
});

it.each(["leave", "eraseAccount"] as const)("deletes personal skills and their Archive entries on %s, while keeping team skills", async (action) => {
	const { t, owner, member } = await ownerAndMember();
	const personal = await member.mutation(api.skills.create, { config, audience: "personal" });
	const team = await member.mutation(api.skills.create, { config, audience: "team" });
	await member.mutation(api.skills.remove, { skillId: personal });
	await member.mutation(api.workspace[action], {});
	await settle(t);
	expect(await owner.query(api.skills.list)).toMatchObject([{ id: team }]);
	expect(await t.run(ctx => ctx.db.query("trash").collect())).toEqual([]);
	expect((await t.run(ctx => ctx.db.query("skillInstalls").collect())).map(s => s.skillId)).toEqual([team]);
});

it("migrates existing skills to explicit Team without changing personal rows, idempotently", async () => {
	// The pre-migration schema permits old rows; production reads never interpret an absent audience as Team.
	const oldSchema = defineSchema({ ...schema.tables, skillInstalls: defineTable({ ...schema.tables.skillInstalls.validator.fields, audience: v.optional(v.union(v.literal("team"), v.literal("personal"))) }) });
	const t = convexTest(oldSchema, modules);
	migrationsTest.register(t);
	const { id, personal } = await t.run(async ctx => {
		const workspaceId = await ctx.db.insert("workspaces", { name: "Old", version: 1 });
		const ownerId = await ctx.db.insert("users", { email: "old@example.com" });
		const personal = await ctx.db.insert("skillInstalls", { workspaceId, skillId: "private", audience: "personal", ownerId });
		const id = await ctx.db.insert("skillInstalls", { workspaceId, skillId: "old" });
		return { id, personal };
	});
	await t.mutation(internal.migrations.runAll);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	await t.mutation(internal.migrations.runAll);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ audience: "team" });
	expect(await t.run(ctx => ctx.db.get(personal))).toMatchObject({ audience: "personal" });
});
