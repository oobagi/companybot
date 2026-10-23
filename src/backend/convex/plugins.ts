import {
	type Plugin,
	type PluginState,
	can,
	deniedMessage,
	findPlugin,
	pluginCatalog,
	pluginRoles,
	startSignIn,
	validateCredentials,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { encrypt } from "./crypto";
import { type Member, getMember, memberOf, requireMember, requirePermission } from "./lib";
import { role } from "./schema";

// Install → choose roles → connect an account → agents granted "<plugin>.*" use it.
// Credentials are encrypted in actions (crypto.ts) and only decrypted by the agent runner.

function requirePlugin(pluginId: string): Plugin {
	const plugin = findPlugin(pluginId);
	if (!plugin) throw new ConvexError("Unknown plugin.");
	return plugin;
}

const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, pluginId: string) =>
	ctx.db
		.query("pluginInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("pluginId", pluginId))
		.first();

/** The connection agents use for this person: the workspace's, or their own for personal plugins. */
async function connectionFor(ctx: QueryCtx, plugin: Plugin, member: Member) {
	const userId = plugin.connection === "personal" ? member.userId : null;
	return ctx.db
		.query("pluginConnections")
		.withIndex("by_workspace", (q) =>
			q.eq("workspaceId", member.workspaceId).eq("pluginId", plugin.id).eq("userId", userId),
		)
		.first();
}

/** Where each installed plugin stands for this person. Feeds `describeToolAccess`. */
export async function pluginStates(ctx: QueryCtx, member: Member): Promise<PluginState[]> {
	const installs = await ctx.db
		.query("pluginInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.collect();
	const states: PluginState[] = [];
	for (const install of installs) {
		const plugin = findPlugin(install.pluginId);
		if (!plugin) continue;
		const connected = plugin.auth.type === "none" || !!(await connectionFor(ctx, plugin, member));
		states.push({ id: plugin.id, roles: install.roles, connected });
	}
	return states;
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const states = await pluginStates(ctx, member);
		return Promise.all(
			pluginCatalog.map(async (plugin) => {
				const state = states.find((s) => s.id === plugin.id);
				const connection = state ? await connectionFor(ctx, plugin, member) : null;
				return {
					id: plugin.id,
					name: plugin.name,
					description: plugin.description,
					version: plugin.version,
					publisher: plugin.publisher,
					connection: plugin.connection,
					server: plugin.mcp.url,
					// Labels only; nothing secret lives in the catalog.
					auth: plugin.auth,
					installed: !!state,
					roles: state?.roles ?? pluginRoles(plugin),
					canUse: !!state && state.roles.includes(member.role),
					connected: state?.connected ?? false,
					error: connection?.error ?? null,
					canConnect:
						plugin.connection === "workspace" ? can(member.role, "plugins.manage") : can(member.role, "plugins.connect"),
				};
			}),
		);
	},
});

export const setInstalled = mutation({
	args: { pluginId: v.string(), installed: v.boolean() },
	handler: async (ctx, { pluginId, installed }) => {
		const member = await requirePermission(ctx, "plugins.manage");
		const plugin = requirePlugin(pluginId);
		const existing = await installOf(ctx, member.workspaceId, pluginId);
		if (installed && !existing) {
			await ctx.db.insert("pluginInstalls", {
				workspaceId: member.workspaceId,
				pluginId,
				roles: pluginRoles(plugin),
				installedBy: member.userId,
			});
		}
		if (!installed && existing) {
			await ctx.db.delete(existing._id);
			// Uninstalling forgets every account connected to it.
			const connections = await ctx.db
				.query("pluginConnections")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("pluginId", pluginId))
				.collect();
			for (const c of connections) await ctx.db.delete(c._id);
		}
	},
});

/** Which roles may use an installed plugin. Applies at once, including mid-reply. */
export const setRoles = mutation({
	args: { pluginId: v.string(), roles: v.array(role) },
	handler: async (ctx, { pluginId, roles }) => {
		const member = await requirePermission(ctx, "plugins.manage");
		const install = await installOf(ctx, member.workspaceId, pluginId);
		if (!install) throw new ConvexError("Install the plugin first.");
		await ctx.db.patch(install._id, { roles: [...new Set(roles)] });
	},
});

const credentials = v.union(v.object({ type: v.literal("none") }), v.object({ type: v.literal("api_key"), key: v.string() }));

/** Where OAuth providers send people back to. Registered with each provider on first sign-in. */
export const oauthRedirectUrl = () => `${process.env.CONVEX_SITE_URL}/oauth/callback`;
const OAUTH_FLOW_MS = 15 * 60_000;

/**
 * Starts signing in to an OAuth plugin. Returns the page to open in the browser;
 * the provider sends the person back to /oauth/callback (oauth.ts), which saves the connection.
 */
export const startOAuth = action({
	args: { pluginId: v.string() },
	handler: async (ctx, { pluginId }): Promise<string> => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const plugin = requirePlugin(pluginId);
		if (plugin.auth.type !== "oauth") throw new ConvexError("This plugin doesn't sign in through the browser.");
		await ctx.runQuery(internal.plugins.connectTarget, { userId, pluginId });
		let started: Awaited<ReturnType<typeof startSignIn>>;
		try {
			started = await startSignIn(plugin, oauthRedirectUrl());
		} catch (e) {
			throw new ConvexError(`Couldn't start signing in to ${plugin.name}: ${e instanceof Error ? e.message : e}`);
		}
		await ctx.runMutation(internal.plugins.saveOAuthFlow, {
			userId,
			pluginId,
			state: started.state.state!,
			data: await encrypt(started.state),
		});
		return started.url;
	},
});

export const saveOAuthFlow = internalMutation({
	args: { userId: v.id("users"), pluginId: v.string(), state: v.string(), data: v.string() },
	handler: async (ctx, args) => {
		// Only the newest sign-in per person counts; drop abandoned ones.
		const old = await ctx.db
			.query("pluginOAuthFlows")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		for (const flow of old) await ctx.db.delete(flow._id);
		await ctx.db.insert("pluginOAuthFlows", { ...args, expiresAt: Date.now() + OAUTH_FLOW_MS });
	},
});

/** Claims a sign-in by its state. One use: a replayed callback finds nothing. */
export const takeOAuthFlow = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, { state }) => {
		const flow = await ctx.db
			.query("pluginOAuthFlows")
			.withIndex("by_state", (q) => q.eq("state", state))
			.first();
		if (!flow) return null;
		await ctx.db.delete(flow._id);
		return flow.expiresAt > Date.now() ? flow : null;
	},
});

/** Saves an account for a plugin. An action, because encryption needs real randomness. */
export const connect = action({
	args: { pluginId: v.string(), credentials },
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const plugin = requirePlugin(args.pluginId);
		const problem = validateCredentials(plugin, args.credentials);
		if (problem) throw new ConvexError(problem);
		// Check permission before encrypting, then again when saving.
		await ctx.runQuery(internal.plugins.connectTarget, { userId, pluginId: plugin.id });
		const sealed = await encrypt(args.credentials);
		await ctx.runMutation(internal.plugins.saveConnection, { userId, pluginId: plugin.id, credentials: sealed });
	},
});

async function requireConnectTarget(ctx: QueryCtx, userId: Id<"users">, pluginId: string) {
	const member = await memberOf(ctx, userId);
	if (!member) throw new ConvexError("Sign in to a workspace first.");
	const plugin = requirePlugin(pluginId);
	const install = await installOf(ctx, member.workspaceId, pluginId);
	if (!install) throw new ConvexError("Install the plugin first.");
	if (!install.roles.includes(member.role)) throw new ConvexError("Your role can't use this plugin.");
	const permission = plugin.connection === "workspace" ? "plugins.manage" : "plugins.connect";
	if (!can(member.role, permission)) throw new ConvexError(deniedMessage(permission));
	return { member, plugin, userId: plugin.connection === "personal" ? member.userId : null };
}

export const connectTarget = internalQuery({
	args: { userId: v.id("users"), pluginId: v.string() },
	handler: async (ctx, { userId, pluginId }) => {
		await requireConnectTarget(ctx, userId, pluginId);
	},
});

/** Replaces stored credentials, e.g. after the runner refreshed an OAuth token. */
export const updateCredentials = internalMutation({
	args: { connectionId: v.id("pluginConnections"), credentials: v.string() },
	handler: async (ctx, { connectionId, credentials }) => {
		if (await ctx.db.get(connectionId)) await ctx.db.patch(connectionId, { credentials, error: undefined });
	},
});

export const saveConnection = internalMutation({
	args: { userId: v.id("users"), pluginId: v.string(), credentials: v.string() },
	handler: async (ctx, args) => {
		const { member, plugin, userId } = await requireConnectTarget(ctx, args.userId, args.pluginId);
		const existing = await connectionFor(ctx, plugin, member);
		if (existing) await ctx.db.delete(existing._id);
		await ctx.db.insert("pluginConnections", {
			workspaceId: member.workspaceId,
			pluginId: plugin.id,
			userId,
			credentials: args.credentials,
			connectedBy: member.userId,
		});
	},
});

export const disconnect = mutation({
	args: { pluginId: v.string() },
	handler: async (ctx, { pluginId }) => {
		const member = await requireMember(ctx);
		const plugin = requirePlugin(pluginId);
		if (plugin.connection === "workspace" && !can(member.role, "plugins.manage")) {
			throw new ConvexError(deniedMessage("plugins.manage"));
		}
		const connection = await connectionFor(ctx, plugin, member);
		if (connection) await ctx.db.delete(connection._id);
	},
});

// ---- Internal: used by the agent runner ----

/**
 * The plugins one turn may load: installed, allowed for the person's role (read
 * fresh), and connected. Credentials stay encrypted until the runner needs them.
 */
export const forTurn = internalQuery({
	args: { userId: v.id("users"), pluginIds: v.array(v.string()) },
	handler: async (ctx, { userId, pluginIds }) => {
		const member = await memberOf(ctx, userId);
		if (!member) return [];
		const usable: { pluginId: string; connectionId: Id<"pluginConnections"> | null; credentials: string | null }[] = [];
		for (const pluginId of pluginIds) {
			const plugin = findPlugin(pluginId);
			const install = plugin && (await installOf(ctx, member.workspaceId, pluginId));
			if (!plugin || !install || !install.roles.includes(member.role)) continue;
			if (plugin.auth.type === "none") {
				usable.push({ pluginId, connectionId: null, credentials: null });
				continue;
			}
			const connection: Doc<"pluginConnections"> | null = await connectionFor(ctx, plugin, member);
			if (connection) usable.push({ pluginId, connectionId: connection._id, credentials: connection.credentials });
		}
		return usable;
	},
});

export const setConnectionError = internalMutation({
	args: { connectionId: v.id("pluginConnections"), error: v.optional(v.string()) },
	handler: async (ctx, { connectionId, error }) => {
		const connection = await ctx.db.get(connectionId);
		if (connection && connection.error !== error) await ctx.db.patch(connectionId, { error });
	},
});
