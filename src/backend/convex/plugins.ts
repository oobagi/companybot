import { pluginCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getMember, requireOwner } from "./lib";

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const installs = await ctx.db
			.query("pluginInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		const installed = new Set(installs.map((i) => i.pluginId));
		return pluginCatalog.map(({ id, name, description, version, publisher }) => ({
			id,
			name,
			description,
			version,
			publisher,
			installed: installed.has(id),
		}));
	},
});

export const setInstalled = mutation({
	args: { pluginId: v.string(), installed: v.boolean() },
	handler: async (ctx, { pluginId, installed }) => {
		const { workspaceId } = await requireOwner(ctx);
		if (!pluginCatalog.some((p) => p.id === pluginId)) throw new ConvexError("Unknown plugin.");
		const existing = await ctx.db
			.query("pluginInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("pluginId", pluginId))
			.first();
		if (installed && !existing) await ctx.db.insert("pluginInstalls", { workspaceId, pluginId });
		if (!installed && existing) await ctx.db.delete(existing._id);
	},
});
