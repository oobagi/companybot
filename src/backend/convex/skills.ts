import {
	type CustomSkillConfig,
	can,
	canEditMade,
	customSkillError,
	deniedMessage,
	madeEditDenied,
	normalizeCustomSkill,
	skillCatalog,
} from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import {
	type Member,
	type Who,
	checkPermission,
	asToolResult,
	getMember,
	madeCustom,
	nameOf,
	newCustomId,
	requireMember,
	saveMade,
} from "./lib";
import { putInTrash, takeFromTrash, trashInfo } from "./trashOps";
import { runningTurn } from "./turns";

// Library skills come from core's catalog and are installed per workspace (owners). Anyone
// can make their own (`skills.create`); those live on their install (`custom`, id "custom-…"),
// are on for the whole workspace, and reach agents the same way (`installedSkills` in lib.ts).
// The maker or an owner can change or delete one (`canEditMade`); deleting moves it to Trash.

/** A skill's install, unless it's in Trash. */
const installOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, skillId: string) => {
	const install = await ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("skillId", skillId))
		.first();
	return install?.archived ? null : install;
};

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
				.map(async ({ _id, skillId, custom, archived }) => ({
					canEdit: canEditMade(member, "skills.manage", custom!.createdBy),
					createdByName: custom!.createdBy ? await nameOf(ctx, custom!.createdBy) : undefined,
					id: skillId,
					name: custom!.name,
					description: custom!.description,
					version: String(custom!.version),
					instructions: custom!.instructions,
					installed: true,
					/** Set for skills people made: who last edited it, and the version a save starts from. */
					custom: { version: custom!.version, updatedByName: await nameOf(ctx, custom!.updatedBy), updatedAt: custom!.updatedAt },
					/** Set while it's in Trash. */
					trash: archived ? await trashInfo(ctx, member, _id) : null,
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
			canEdit: canEditMade(member, "skills.manage"),
			createdByName: undefined,
			custom: null,
			trash: null,
		}));
		return [...custom, ...library];
	},
});

const customConfig = v.object({ name: v.string(), description: v.string(), instructions: v.string() });

/** Makes a skill for the workspace, as `member`. Throws a ConvexError with the problem. */
async function createSkill(ctx: MutationCtx, member: Member, config: CustomSkillConfig) {
	if (!can(member, "skills.create")) throw new ConvexError(deniedMessage("skills.create"));
	config = normalizeCustomSkill(config);
	const problem = customSkillError(config);
	if (problem) throw new ConvexError(problem);
	const skillId = newCustomId();
	await ctx.db.insert("skillInstalls", {
		workspaceId: member.workspaceId,
		skillId,
		custom: { ...madeCustom(config, member.userId), createdBy: member.userId },
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
	if (!canEditMade(member, "skills.manage", install.custom.createdBy)) throw new ConvexError(madeEditDenied);
	return install as Doc<"skillInstalls"> & { custom: NonNullable<Doc<"skillInstalls">["custom"]> };
}

/** Saves a skill someone made. Refused if someone saved since `expectedVersion`. */
const saveSkillArgs = v.object({ skillId: v.string(), config: customConfig, expectedVersion: v.number() });

export const save = mutation({
	args: saveSkillArgs.fields,
	handler: async (ctx, args) => saveSkill(ctx, await requireMember(ctx), args),
});

export async function saveSkill(ctx: MutationCtx, member: Member, { skillId, config, expectedVersion }: Infer<typeof saveSkillArgs>) {
	const install = await editableSkill(ctx, member, skillId);
	await saveMade({
		current: install.custom,
		expectedVersion,
		config: normalizeCustomSkill(config),
		userId: member.userId,
		validate: () => {
			const problem = customSkillError(config);
			if (problem) throw new ConvexError(problem);
		},
		patch: (custom) => ctx.db.patch(install._id, { custom }),
	});
}

/** Deletes a skill someone made (to Trash), or uninstalls a library one. */
export async function removeSkill(ctx: MutationCtx, who: Who, skillId: string) {
	const { member } = who;
	if (skillId.startsWith("custom-")) {
		const install = await editableSkill(ctx, member, skillId);
		await setSkillTrashed(ctx, who, install._id, true);
		return;
	}
	const { workspaceId } = checkPermission(member, "skills.manage");
	const install = await installOf(ctx, workspaceId, skillId);
	if (install) await ctx.db.delete(install._id);
}

export const remove = mutation({
	args: { skillId: v.string() },
	handler: async (ctx, { skillId }) => removeSkill(ctx, { member: await requireMember(ctx) }, skillId),
});

/** Moves a skill someone made to Trash, or back: the maker or an owner. In Trash, agents don't see it. */
export async function setSkillTrashed(ctx: MutationCtx, who: Who, installId: Id<"skillInstalls">, archived: boolean) {
	const install = await ctx.db.get(installId);
	if (!install?.custom || install.workspaceId !== who.member.workspaceId) throw new ConvexError("Skill not found.");
	if (!canEditMade(who.member, "skills.manage", install.custom.createdBy)) throw new ConvexError(madeEditDenied);
	if (!!install.archived === archived) return;
	if (archived) await putInTrash(ctx, who, { kind: "skill", id: installId, name: install.custom.name });
	else await takeFromTrash(ctx, who, installId);
	await ctx.db.patch(installId, { archived });
}

const installSkillArgs = v.object({ skillId: v.string(), installed: v.literal(true) });

export const setInstalled = mutation({
	args: installSkillArgs.fields,
	handler: async (ctx, args) => installSkill(ctx, await requireMember(ctx), args),
});

export async function installSkill(ctx: MutationCtx, member: Member, { skillId }: Infer<typeof installSkillArgs>) {
	if (skillId.startsWith("custom-")) throw new ConvexError("Skills people make are always on.");
	const { workspaceId } = checkPermission(member, "skills.manage");
	const existing = await installOf(ctx, workspaceId, skillId);
	if (existing) return;
	if (!skillCatalog.some((s) => s.id === skillId)) throw new ConvexError("Unknown skill.");
	await ctx.db.insert("skillInstalls", { workspaceId, skillId });
}

/** `skills.create` from chat: makes a skill as the person the agent is helping. */
export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), config: customConfig },
	handler: async (ctx, { turnId, config }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const created = await createSkill(ctx, member, config);
			return { created, name: normalizeCustomSkill(config).name };
		});
	},
});
