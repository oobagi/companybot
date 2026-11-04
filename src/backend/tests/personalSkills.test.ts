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
	const [entry] = (await member.query(api.trash.list, args)).page;
	await expect(owner.mutation(api.trash.restore, { kind: "skill", id: entry!.itemId })).rejects.toThrow();
	await expect(owner.mutation(api.trash.purge, { id: entry!.itemId })).rejects.toThrow();
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
	const chatId = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const turnId = await agentTurn(t, member, chatId, companybot._id);
	expect(await t.mutation(internal.skills.createFor, { turnId, config, audience: "team" })).toMatchObject({ audience: "personal", note: expect.stringContaining("Saved as Just me") });
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

// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it and its test, and make audience required.
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

it("refuses personal skill writes in shared chats and keeps approval and Activity inputs private", async () => {
	const { t, owner, member } = await ownerAndMember();
	const id = await member.mutation(api.skills.create, { config, audience: "personal" });
	const { companybot } = await agentsOf(member);
	const turnId = await agentTurn(t, member, (await generalOf(member))._id, companybot._id);
	const turn = await t.run(ctx => ctx.db.query("agentTurns").filter(q => q.eq(q.field("_id"), turnId)).first());
	const denied = { error: expect.stringContaining("DM with the agent, or in Settings") };
	expect(await t.mutation(internal.skills.createFor, { turnId, config, audience: "personal" })).toMatchObject(denied);
	const input = { request: { action: "edit", id, config, expectedVersion: 1 } };
	expect(await t.mutation(internal.manageTools.runFor, { turnId, tool: "skills.edit", input })).toMatchObject(denied);
	await setMemberSwitch(owner, "skills.edit", false);
	// A Team request that would be downgraded must also be refused here.
	expect(await t.mutation(internal.skills.createFor, { turnId, config, audience: "team" })).toMatchObject(denied);
	for (const [tool, proposal] of [["skills.create", { ...config, audience: "personal" }], ["skills.edit", input]] as const) {
		await t.mutation(internal.approvals.request, { turnId, callId: tool, tool, input: JSON.stringify(proposal), risk: "outside" });
		await t.mutation(internal.activity.log, { turnId, callId: tool, tool, input: JSON.stringify(proposal), changes: true });
	}
	const replyId = turn!.replyId!;
	const cards = await owner.query(api.approvals.forReply, { replyId });
	expect(cards).toHaveLength(2);
	expect(JSON.stringify(cards)).not.toContain(config.instructions);
	expect(JSON.stringify(await owner.query(api.activity.forReply, { replyId }))).not.toContain(config.instructions);
	expect(JSON.stringify(await owner.query(api.activity.list, {}))).not.toContain(config.instructions);
	expect(JSON.stringify(await member.query(api.approvals.forReply, { replyId }))).toContain(config.instructions);
	expect(JSON.stringify(await member.query(api.activity.forReply, { replyId }))).toContain(config.instructions);
	expect((await member.query(api.skills.list))[0]).toMatchObject({ instructions: config.instructions, custom: { version: 1 } });
});

it("filters skill mentions by the sender and keeps steering scoped to the actor", async () => {
	const { t, owner, member } = await ownerAndMember();
	const personal = await member.mutation(api.skills.create, { config, audience: "personal" });
	const team = await member.mutation(api.skills.create, { config: { ...config, name: "Team process" }, audience: "team" });
	const { companybot } = await agentsOf(member);
	const dm = (as: typeof member) => as.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const memberChat = await dm(member);
	const ownerChat = await dm(owner);
	const mine = await agentTurn(t, member, memberChat, companybot._id);
	const theirs = await agentTurn(t, owner, ownerChat, companybot._id);
	vi.setSystemTime(Date.now() + 1);
	const send = (as: typeof member) => as.mutation(api.messages.send, { chatId: as === member ? memberChat : ownerChat, text: "Use these skills", mentions: { userIds: [], agentIds: [companybot._id], skillIds: [personal, team] } });
	const memberMessage = await send(member);
	const ownerMessage = await send(owner);
	expect((await t.run(ctx => ctx.db.get(memberMessage)))!.mentions?.skillIds).toEqual([personal, team]);
	expect((await t.run(ctx => ctx.db.get(ownerMessage)))!.mentions?.skillIds).toEqual([team]);
	// Old or forged stored references must also be filtered when building steering context.
	await t.run(async ctx => { const m = await ctx.db.get(ownerMessage); if (m) await ctx.db.patch(ownerMessage, { mentions: { ...m.mentions, skillIds: [personal, team] } }); });
	const mineNote = await t.mutation(internal.turns.steer, { turnId: mine });
	const theirNote = await t.mutation(internal.turns.steer, { turnId: theirs });
	expect(mineNote?.note).toContain(config.name);
	expect(theirNote?.note).not.toContain(config.name);
	expect(theirNote?.note).toContain("Team process");
});
