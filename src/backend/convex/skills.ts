import { skillCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getMember, installedSkills, requirePermission } from "./lib";

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const installed = new Set((await installedSkills(ctx, member.workspaceId)).map((s) => s.id));
		return skillCatalog.map(({ id, name, description, version, instructions }) => ({
			id,
			name,
			description,
			version,
			instructions,
			installed: installed.has(id),
		}));
	},
});

export const setInstalled = mutation({
	args: { skillId: v.string(), installed: v.boolean() },
	handler: async (ctx, { skillId, installed }) => {
		const { workspaceId } = await requirePermission(ctx, "skills.manage");
		if (!skillCatalog.some((s) => s.id === skillId)) throw new ConvexError("Unknown skill.");
		const existing = await ctx.db
			.query("skillInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("skillId", skillId))
			.first();
		if (installed && !existing) await ctx.db.insert("skillInstalls", { workspaceId, skillId });
		if (!installed && existing) await ctx.db.delete(existing._id);
	},
});
