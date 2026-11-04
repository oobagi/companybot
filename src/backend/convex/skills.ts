import {
	type CustomSkillConfig,
	can,
	customSkillError,
	normalizeCustomSkill,
} from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import {
	canSeeSkill,
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

// Skills live on their install. Personal installs are visible only to their owner.

/** A skill's install, unless it's in Archive. */
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
			if (!skill || !canSeeSkill(member.userId, install)) continue;
			const custom = install.custom;
			rows.push({
				...skill,
				installed: true,
				audience: install.audience,
				canEdit: install.audience === "personal" || can(member, "skills.edit"),
				createdByName: custom?.createdBy ? await nameOf(ctx, custom.createdBy) : undefined,
				custom: custom ? { version: custom.version, updatedByName: await nameOf(ctx, custom.updatedBy), updatedAt: custom.updatedAt } : null,
				trash: install.archived ? await trashInfo(ctx, member, install._id) : null,
			});
		}
		return rows;
	},
});

const audienceArg = v.optional(v.union(v.literal("personal"), v.literal("team")));
const customConfig = v.object({ name: v.string(), description: v.string(), instructions: v.string() });

/** Makes a skill for the workspace, as `member`. Throws a ConvexError with the problem. */
async function createSkill(ctx: MutationCtx, member: Member, config: CustomSkillConfig, audience: "personal" | "team" = can(member, "skills.edit") ? "team" : "personal") {
	if (audience === "team") checkPermission(member, "skills.edit");
	config = normalizeCustomSkill(config);
	const problem = customSkillError(config);
	if (problem) throw new ConvexError(problem);
	const skillId = newCustomId();
	await ctx.db.insert("skillInstalls", {
		workspaceId: member.workspaceId,
		skillId,
		audience,
		...(audience === "personal" && { ownerId: member.userId }),
		custom: { ...madeCustom(config, member.userId), createdBy: member.userId },
	});
	return skillId;
}

/** Makes a personal or team skill. Defaults to Team if the switch permits it. */
export const create = mutation({
	args: { config: customConfig, audience: audienceArg },
	handler: async (ctx, { config, audience }) => createSkill(ctx, await requireMember(ctx), config, audience),
});

/** A skill someone made, if `member` can change skills (`skills.edit`). */
async function editableSkill(ctx: QueryCtx, member: Member, skillId: string) {
	const install = await installOf(ctx, member.workspaceId, skillId);
	if (!install?.custom || !canSeeSkill(member.userId, install)) throw new ConvexError("Skill not found.");
	if (install.audience === "team") checkPermission(member, "skills.edit");
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

/** Moves a skill to Archive. Retained library installs have the same 30-day recovery. */
export async function removeSkill(ctx: MutationCtx, who: Who, skillId: string) {
	const { member } = who;
	const install = await installOf(ctx, member.workspaceId, skillId);
	if (!install && skillId.startsWith("custom-")) throw new ConvexError("Skill not found.");
	if (!install) return void checkPermission(member, "skills.edit");
	await setSkillTrashed(ctx, who, install._id, true);
}

export const remove = mutation({
	args: { skillId: v.string() },
	handler: async (ctx, { skillId }) => removeSkill(ctx, { member: await requireMember(ctx) }, skillId),
});

/** Moves a skill to Archive, or back: whoever can change skills (`skills.edit`). In Trash, agents don't see it. */
export async function setSkillTrashed(ctx: MutationCtx, who: Who, installId: Id<"skillInstalls">, archived: boolean) {
	const install = await ctx.db.get(installId);
	if (!install || install.workspaceId !== who.member.workspaceId || !canSeeSkill(who.member.userId, install)) throw new ConvexError("Skill not found.");
	if (install.audience === "team") checkPermission(who.member, "skills.edit");
	if (!!install.archived === archived) return;
	await toggleTrash(ctx, who, archived, { kind: "skill", id: installId, name: skillOf(install)?.name ?? install.skillId });
	await ctx.db.patch(installId, { archived });
}

/** The `skills.create` tool from chat: makes a skill as the person the agent is helping. */
export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), config: customConfig, audience: audienceArg },
	handler: async (ctx, { turnId, config, audience }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const created = await createSkill(ctx, member, config, can(member, "skills.edit") ? audience : "personal");
			return { created, name: normalizeCustomSkill(config).name };
		});
	},
});

/** The maker explicitly confirms sharing in the app before calling this. */
export const share = mutation({
	args: { skillId: v.string() },
	handler: async (ctx, { skillId }) => {
		const member = await requireMember(ctx);
		const install = await editableSkill(ctx, member, skillId);
		if (install.audience !== "personal" || install.ownerId !== member.userId) throw new ConvexError("Personal skill not found.");
		checkPermission(member, "skills.edit");
		await ctx.db.patch(install._id, { audience: "team", ownerId: undefined });
	},
});
