import {
	type CustomSkillConfig,
	canEditMade,
	customSkillError,
	madeEditDenied,
	normalizeCustomSkill,
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
	skillOf,
} from "./lib";
import { toggleTrash, trashInfo } from "./trashOps";
import { runningTurn } from "./turns";

// Skills people make live on their install and are shared with the workspace.
// Retired library installs read stored definitions, with a fallback until migration finishes.

/** A skill's install, unless it's in Trash. */
export const installOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, skillId: string) => {
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
		const rows = [];
		for (const install of installs.sort((a, b) => b._creationTime - a._creationTime)) {
			const skill = skillOf(install);
			if (!skill) continue;
			const custom = install.custom;
			rows.push({
				...skill,
				installed: true,
				canEdit: canEditMade(member, "skills.manage", custom?.createdBy),
				createdByName: custom?.createdBy ? await nameOf(ctx, custom.createdBy) : undefined,
				custom: custom ? { version: custom.version, updatedByName: await nameOf(ctx, custom.updatedBy), updatedAt: custom.updatedAt } : null,
				trash: install.archived ? await trashInfo(ctx, member, install._id) : null,
			});
		}
		return rows;
	},
});

const customConfig = v.object({ name: v.string(), description: v.string(), instructions: v.string() });

/** Makes a skill for the workspace, as `member`. Throws a ConvexError with the problem. */
async function createSkill(ctx: MutationCtx, member: Member, config: CustomSkillConfig) {
	checkPermission(member, "skills.create");
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

/** Moves a skill to Trash. Retained library installs have the same 30-day recovery. */
export async function removeSkill(ctx: MutationCtx, who: Who, skillId: string) {
	const { member } = who;
	const install = await installOf(ctx, member.workspaceId, skillId);
	if (!install && skillId.startsWith("custom-")) throw new ConvexError("Skill not found.");
	if (!install) return void checkPermission(member, "skills.manage");
	await setSkillTrashed(ctx, who, install._id, true);
}

export const remove = mutation({
	args: { skillId: v.string() },
	handler: async (ctx, { skillId }) => removeSkill(ctx, { member: await requireMember(ctx) }, skillId),
});

/** Moves a skill to Trash, or back: the maker or an owner. In Trash, agents don't see it. */
export async function setSkillTrashed(ctx: MutationCtx, who: Who, installId: Id<"skillInstalls">, archived: boolean) {
	const install = await ctx.db.get(installId);
	if (!install || install.workspaceId !== who.member.workspaceId) throw new ConvexError("Skill not found.");
	if (!install.custom) checkPermission(who.member, "skills.manage");
	else if (!canEditMade(who.member, "skills.manage", install.custom.createdBy)) throw new ConvexError(madeEditDenied);
	if (!!install.archived === archived) return;
	await toggleTrash(ctx, who, archived, { kind: "skill", id: installId, name: skillOf(install)?.name ?? install.skillId });
	await ctx.db.patch(installId, { archived });
}

// COMPAT(0.1.0-alpha.8): old desktops may request installation; keep the endpoint until they update.
export const setInstalled = mutation({
	args: { skillId: v.string(), installed: v.literal(true) },
	handler: async (ctx, { skillId }) => {
		const member = await requireMember(ctx);
		if (skillId.startsWith("custom-")) throw new ConvexError("Skills people make are always on.");
		const { workspaceId } = checkPermission(member, "skills.manage");
		if (await installOf(ctx, workspaceId, skillId)) return;
		throw new ConvexError("The skill library has retired. Create your own skill in Customize → Skills.");
	},
});

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
