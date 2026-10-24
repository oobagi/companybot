import { type CustomSkillConfig, can, canEditSkill, customSkillError, deniedMessage, skillCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { type Member, checkVersion, getMember, nameOf, newCustomId, requireMember, requirePermission } from "./lib";
import { runningTurn } from "./turns";

// Library skills come from core's catalog and are installed per workspace (owners). Anyone
// can make their own (`skills.create`); those live on their install (`custom`, id "custom-…"),
// are on for the whole workspace, and reach agents the same way (`installedSkills` in lib.ts).
// The maker or an owner can change or delete one (`canEditSkill`).

const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, skillId: string) =>
	ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("skillId", skillId))
		.first();

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const installs = await ctx.db
			.query("skillInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		const custom = await Promise.all(
			installs
				.filter((i) => i.custom)
				.sort((a, b) => b._creationTime - a._creationTime)
				.map(async ({ skillId, custom }) => ({
					canEdit: canEditSkill(member, custom!),
					createdByName: custom!.createdBy ? await nameOf(ctx, custom!.createdBy) : undefined,
					id: skillId,
					name: custom!.name,
					description: custom!.description,
					version: String(custom!.version),
					instructions: custom!.instructions,
					installed: true,
					/** Set for skills people made: who last edited it, and the version a save starts from. */
					custom: { version: custom!.version, updatedByName: await nameOf(ctx, custom!.updatedBy), updatedAt: custom!.updatedAt },
				})),
		);
		const installed = new Set(installs.filter((i) => !i.custom).map((i) => i.skillId));
		const library = skillCatalog.map(({ id, name, description, version, instructions }) => ({
			id,
			name,
			description,
			version,
			instructions,
			installed: installed.has(id),
			canEdit: canEditSkill(member, {}),
			createdByName: undefined,
			custom: null,
		}));
		return [...custom, ...library];
	},
});

const customConfig = v.object({ name: v.string(), description: v.string(), instructions: v.string() });

const trimmed = (config: CustomSkillConfig): CustomSkillConfig => ({
	name: config.name.trim(),
	description: config.description.trim(),
	instructions: config.instructions.trim(),
});

/** Makes a skill for the workspace, as `member`. Throws a ConvexError with the problem. */
async function createSkill(ctx: MutationCtx, member: Member, config: CustomSkillConfig) {
	if (!can(member, "skills.create")) throw new ConvexError(deniedMessage("skills.create"));
	const problem = customSkillError(config);
	if (problem) throw new ConvexError(problem);
	const skillId = newCustomId();
	await ctx.db.insert("skillInstalls", {
		workspaceId: member.workspaceId,
		skillId,
		custom: { ...trimmed(config), createdBy: member.userId, version: 1, updatedBy: member.userId, updatedAt: Date.now() },
	});
	return skillId;
}

/** Someone makes their own skill, on for the workspace. Returns its id. */
export const create = mutation({
	args: { config: customConfig },
	handler: async (ctx, { config }) => createSkill(ctx, await requireMember(ctx), config),
});

/** A skill someone made, if `member` can change it. */
async function editableSkill(ctx: QueryCtx, member: Member, skillId: string) {
	const install = await installOf(ctx, member.workspaceId, skillId);
	if (!install?.custom) throw new ConvexError("Skill not found.");
	if (!canEditSkill(member, install.custom)) throw new ConvexError("Only the person who made this skill or an owner can change it.");
	return install as Doc<"skillInstalls"> & { custom: NonNullable<Doc<"skillInstalls">["custom"]> };
}

/** Saves a skill someone made. Refused if someone saved since `expectedVersion`. */
export const save = mutation({
	args: { skillId: v.string(), config: customConfig, expectedVersion: v.number() },
	handler: async (ctx, { skillId, config, expectedVersion }) => {
		const member = await requireMember(ctx);
		const install = await editableSkill(ctx, member, skillId);
		checkVersion(install.custom.version, expectedVersion);
		const problem = customSkillError(config);
		if (problem) throw new ConvexError(problem);
		await ctx.db.patch(install._id, {
			custom: { ...install.custom, ...trimmed(config), version: install.custom.version + 1, updatedBy: member.userId, updatedAt: Date.now() },
		});
	},
});

export const setInstalled = mutation({
	args: { skillId: v.string(), installed: v.boolean() },
	handler: async (ctx, { skillId, installed }) => {
		// Removing a skill someone made deletes it: it lives only on its install.
		if (skillId.startsWith("custom-")) {
			if (installed) throw new ConvexError("Skills people make are always on.");
			const install = await editableSkill(ctx, await requireMember(ctx), skillId);
			await ctx.db.delete(install._id);
			return;
		}
		const { workspaceId } = await requirePermission(ctx, "skills.manage");
		const existing = await installOf(ctx, workspaceId, skillId);
		if (!installed) {
			if (existing) await ctx.db.delete(existing._id);
			return;
		}
		if (existing) return;
		if (!skillCatalog.some((s) => s.id === skillId)) throw new ConvexError("Unknown skill.");
		await ctx.db.insert("skillInstalls", { workspaceId, skillId });
	},
});

/** `skills.create` from chat: makes a skill as the person the agent is helping. */
export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), config: customConfig },
	handler: async (ctx, { turnId, config }) => {
		const { member } = await runningTurn(ctx, turnId);
		try {
			const created = await createSkill(ctx, member, config);
			return { created, name: config.name.trim() };
		} catch (e) {
			if (e instanceof ConvexError) return { error: String(e.data) };
			throw e;
		}
	},
});
