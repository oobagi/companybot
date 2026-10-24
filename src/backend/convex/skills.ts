import { type CustomSkillConfig, customSkillError, skillCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { checkVersion, getMember, nameOf, requirePermission } from "./lib";

// Library skills come from core's catalog and are installed per workspace. Ones owners
// make live on their install (`custom`, id "custom-…"), are always installed, and reach
// agents the same way (`installedSkills` in lib.ts).

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
					id: skillId,
					name: custom!.name,
					description: custom!.description,
					version: String(custom!.version),
					instructions: custom!.instructions,
					installed: true,
					/** Set for skills an owner made: who last edited it, and the version a save starts from. */
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

function newSkillId() {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return `custom-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An owner makes their own skill, installed for the workspace. Returns its id. */
export const create = mutation({
	args: { config: customConfig },
	handler: async (ctx, { config }) => {
		const owner = await requirePermission(ctx, "skills.manage");
		const problem = customSkillError(config);
		if (problem) throw new ConvexError(problem);
		const skillId = newSkillId();
		await ctx.db.insert("skillInstalls", {
			workspaceId: owner.workspaceId,
			skillId,
			custom: { ...trimmed(config), version: 1, updatedBy: owner.userId, updatedAt: Date.now() },
		});
		return skillId;
	},
});

/** Saves an owner-made skill. Refused if someone saved since `expectedVersion`. */
export const save = mutation({
	args: { skillId: v.string(), config: customConfig, expectedVersion: v.number() },
	handler: async (ctx, { skillId, config, expectedVersion }) => {
		const owner = await requirePermission(ctx, "skills.manage");
		const install = await installOf(ctx, owner.workspaceId, skillId);
		if (!install?.custom) throw new ConvexError("Skill not found.");
		checkVersion(install.custom.version, expectedVersion);
		const problem = customSkillError(config);
		if (problem) throw new ConvexError(problem);
		await ctx.db.patch(install._id, {
			custom: { ...trimmed(config), version: install.custom.version + 1, updatedBy: owner.userId, updatedAt: Date.now() },
		});
	},
});

export const setInstalled = mutation({
	args: { skillId: v.string(), installed: v.boolean() },
	handler: async (ctx, { skillId, installed }) => {
		const { workspaceId } = await requirePermission(ctx, "skills.manage");
		const existing = await installOf(ctx, workspaceId, skillId);
		// Removing also deletes skills owners made: they live only on their install.
		if (!installed) {
			if (existing) await ctx.db.delete(existing._id);
			return;
		}
		if (existing) return;
		if (!skillCatalog.some((s) => s.id === skillId)) throw new ConvexError("Unknown skill.");
		await ctx.db.insert("skillInstalls", { workspaceId, skillId });
	},
});
