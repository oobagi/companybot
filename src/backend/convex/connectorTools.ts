import { type Risk, builtinTools, toolGroup, toolRisk } from "@companybot/core";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation } from "./_generated/server";
import { liveWorkspace } from "./lib";
import { risk } from "./schema";

/** An action's risk from its definition: built-ins in code, connector tools as their server last listed them (unlisted ones ask). */
export async function riskOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, action: string): Promise<Risk> {
	const builtin = builtinTools.find((t) => t.id === action);
	if (builtin) return toolRisk(builtin);
	const listed = await toolsOf(ctx, workspaceId, toolGroup(action));
	return listed.find((t) => `${toolGroup(action)}.${t.name}` === action)?.risk ?? "outside";
}

export const toolsOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string) =>
	(
		await ctx.db
			.query("connectorTools")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("connectorId", connectorId))
			.first()
	)?.tools ?? [];

/** The title an action's server gave it, if any (built-ins carry their own). Use with `actionLabel`. */
export async function titleOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, action: string) {
	const builtin = builtinTools.find((t) => t.id === action);
	if (builtin) return builtin.title;
	return (await toolsOf(ctx, workspaceId, toolGroup(action))).find((t) => `${toolGroup(action)}.${t.name}` === action)?.title;
}

/**
 * Records the tools a connector's server listed, when they changed. Display only. Only while
 * the install that listed them is still there: listing takes a while, and a row saved after
 * an uninstall or the workspace's deletion would outlive its cascade.
 */
export const saveTools = internalMutation({
	args: {
		workspaceId: v.id("workspaces"),
		connectorId: v.string(),
		installId: v.id("connectorInstalls"),
		tools: v.array(v.object({ name: v.string(), title: v.optional(v.string()), description: v.string(), risk })),
	},
	handler: async (ctx, { workspaceId, connectorId, installId, tools }) => {
		const install = await ctx.db.get(installId);
		if (install?.workspaceId !== workspaceId || install.connectorId !== connectorId || !(await liveWorkspace(ctx, workspaceId))) return;
		const row = await ctx.db
			.query("connectorTools")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("connectorId", connectorId))
			.first();
		if (!row) await ctx.db.insert("connectorTools", { workspaceId, connectorId, tools });
		else if (JSON.stringify(row.tools) !== JSON.stringify(tools)) await ctx.db.patch(row._id, { tools });
	},
});

