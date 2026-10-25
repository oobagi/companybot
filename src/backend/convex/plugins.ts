import { v } from "convex/values";
import { api } from "./_generated/api";
import { action, mutation } from "./functions";
import { role } from "./schema";

// Old names for connectors.ts, from before plugins were renamed connectors. Installed
// apps keep calling these until they update (wiki/releases.md: add, don't remove).
// COMPAT(0.1.0-alpha.6): apps before the connectors rename call plugins.*. Delete this file.

export { list } from "./connectors";

export const setInstalled = mutation({
	args: { pluginId: v.string(), installed: v.boolean() },
	handler: async (ctx, { pluginId, installed }): Promise<null> => await ctx.runMutation(api.connectors.setInstalled, { connectorId: pluginId, installed }),
});

export const setRoles = mutation({
	args: { pluginId: v.string(), roles: v.array(role) },
	handler: async (ctx, { pluginId, roles }): Promise<null> => await ctx.runMutation(api.connectors.setRoles, { connectorId: pluginId, roles }),
});

export const startOAuth = action({
	args: { pluginId: v.string() },
	handler: (ctx, { pluginId }): Promise<string> => ctx.runAction(api.connectors.startOAuth, { connectorId: pluginId }),
});

export const connect = action({
	args: {
		pluginId: v.string(),
		credentials: v.union(v.object({ type: v.literal("none") }), v.object({ type: v.literal("api_key"), key: v.string() })),
	},
	handler: async (ctx, { pluginId, credentials }): Promise<null> => await ctx.runAction(api.connectors.connect, { connectorId: pluginId, credentials }),
});

export const disconnect = mutation({
	args: { pluginId: v.string() },
	handler: async (ctx, { pluginId }): Promise<null> => await ctx.runMutation(api.connectors.disconnect, { connectorId: pluginId }),
});
