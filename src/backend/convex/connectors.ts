import {
	type Connector,
	type ConnectorState,
	can,
	deniedMessage,
	findConnector,
	connectorCatalog,
	connectorRoles,
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
import { forgetConnector } from "./permissions";
import { role } from "./schema";

// Install → choose roles → connect an account → agents granted "<connector>.*" use it.
// Credentials are encrypted in actions (crypto.ts) and only decrypted by the agent runner.

function requireConnector(connectorId: string): Connector {
	const connector = findConnector(connectorId);
	if (!connector) throw new ConvexError("Unknown connector.");
	return connector;
}

const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string) =>
	ctx.db
		.query("connectorInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("connectorId", connectorId))
		.first();

/** The connection agents use for this person: the workspace's, or their own for personal connectors. */
async function connectionFor(ctx: QueryCtx, connector: Connector, member: Member) {
	const userId = connector.connection === "personal" ? member.userId : null;
	return ctx.db
		.query("connectorConnections")
		.withIndex("by_workspace", (q) =>
			q.eq("workspaceId", member.workspaceId).eq("connectorId", connector.id).eq("userId", userId),
		)
		.first();
}

/** Where each installed connector stands for this person. Feeds `describeToolAccess`. */
export async function connectorStates(ctx: QueryCtx, member: Member): Promise<ConnectorState[]> {
	const installs = await ctx.db
		.query("connectorInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.collect();
	const states: ConnectorState[] = [];
	for (const install of installs) {
		const connector = findConnector(install.connectorId);
		if (!connector) continue;
		const connected = connector.auth.type === "none" || !!(await connectionFor(ctx, connector, member));
		states.push({ id: connector.id, roles: install.roles, connected });
	}
	return states;
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const states = await connectorStates(ctx, member);
		return Promise.all(
			connectorCatalog.map(async (connector) => {
				const state = states.find((s) => s.id === connector.id);
				const connection = state ? await connectionFor(ctx, connector, member) : null;
				return {
					id: connector.id,
					name: connector.name,
					description: connector.description,
					version: connector.version,
					publisher: connector.publisher,
					connection: connector.connection,
					server: connector.mcp.url,
					// Labels only; nothing secret lives in the catalog.
					auth: connector.auth,
					installed: !!state,
					roles: state?.roles ?? connectorRoles(connector),
					canUse: !!state && state.roles.includes(member.role),
					connected: state?.connected ?? false,
					error: connection?.error ?? null,
					canConnect:
						connector.connection === "workspace" ? can(member.role, "connectors.manage") : can(member.role, "connectors.connect"),
				};
			}),
		);
	},
});

export const setInstalled = mutation({
	args: { connectorId: v.string(), installed: v.boolean() },
	handler: async (ctx, { connectorId, installed }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const connector = requireConnector(connectorId);
		const existing = await installOf(ctx, member.workspaceId, connectorId);
		if (installed && !existing) {
			await ctx.db.insert("connectorInstalls", {
				workspaceId: member.workspaceId,
				connectorId,
				roles: connectorRoles(connector),
				installedBy: member.userId,
			});
		}
		if (!installed && existing) {
			await ctx.db.delete(existing._id);
			// Rules and locks belong to this install: reinstalling starts strict again.
			await forgetConnector(ctx, existing);
			// Uninstalling forgets every account connected to it.
			const connections = await ctx.db
				.query("connectorConnections")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("connectorId", connectorId))
				.collect();
			for (const c of connections) await ctx.db.delete(c._id);
		}
	},
});

/** Which roles may use an installed connector. Applies at once, including mid-reply. */
export const setRoles = mutation({
	args: { connectorId: v.string(), roles: v.array(role) },
	handler: async (ctx, { connectorId, roles }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const install = await installOf(ctx, member.workspaceId, connectorId);
		if (!install) throw new ConvexError("Install the connector first.");
		await ctx.db.patch(install._id, { roles: [...new Set(roles)] });
	},
});

const credentials = v.union(v.object({ type: v.literal("none") }), v.object({ type: v.literal("api_key"), key: v.string() }));

/** Where OAuth providers send people back to. Registered with each provider on first sign-in. */
export const oauthRedirectUrl = () => `${process.env.CONVEX_SITE_URL}/oauth/callback`;
const OAUTH_FLOW_MS = 15 * 60_000;

/**
 * Starts signing in to an OAuth connector. Returns the page to open in the browser;
 * the provider sends the person back to /oauth/callback (oauth.ts), which saves the connection.
 */
export const startOAuth = action({
	args: { connectorId: v.string() },
	handler: async (ctx, { connectorId }): Promise<string> => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const connector = requireConnector(connectorId);
		if (connector.auth.type !== "oauth") throw new ConvexError("This connector doesn't sign in through the browser.");
		await ctx.runQuery(internal.connectors.connectTarget, { userId, connectorId });
		let started: Awaited<ReturnType<typeof startSignIn>>;
		try {
			started = await startSignIn(connector, oauthRedirectUrl());
		} catch (e) {
			throw new ConvexError(`Couldn't start signing in to ${connector.name}: ${e instanceof Error ? e.message : e}`);
		}
		await ctx.runMutation(internal.connectors.saveOAuthFlow, {
			userId,
			connectorId,
			state: started.state.state!,
			data: await encrypt(started.state),
		});
		return started.url;
	},
});

export const saveOAuthFlow = internalMutation({
	args: { userId: v.id("users"), connectorId: v.string(), state: v.string(), data: v.string() },
	handler: async (ctx, args) => {
		// Only the newest sign-in per person counts; drop abandoned ones.
		const old = await ctx.db
			.query("connectorOAuthFlows")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		for (const flow of old) await ctx.db.delete(flow._id);
		await ctx.db.insert("connectorOAuthFlows", { ...args, expiresAt: Date.now() + OAUTH_FLOW_MS });
	},
});

/** Claims a sign-in by its state. One use: a replayed callback finds nothing. */
export const takeOAuthFlow = internalMutation({
	args: { state: v.string() },
	handler: async (ctx, { state }) => {
		const flow = await ctx.db
			.query("connectorOAuthFlows")
			.withIndex("by_state", (q) => q.eq("state", state))
			.first();
		if (!flow) return null;
		await ctx.db.delete(flow._id);
		return flow.expiresAt > Date.now() ? flow : null;
	},
});

/** Saves an account for a connector. An action, because encryption needs real randomness. */
export const connect = action({
	args: { connectorId: v.string(), credentials },
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const connector = requireConnector(args.connectorId);
		const problem = validateCredentials(connector, args.credentials);
		if (problem) throw new ConvexError(problem);
		// Check permission before encrypting, then again when saving.
		await ctx.runQuery(internal.connectors.connectTarget, { userId, connectorId: connector.id });
		const sealed = await encrypt(args.credentials);
		await ctx.runMutation(internal.connectors.saveConnection, { userId, connectorId: connector.id, credentials: sealed });
	},
});

async function requireConnectTarget(ctx: QueryCtx, userId: Id<"users">, connectorId: string) {
	const member = await memberOf(ctx, userId);
	if (!member) throw new ConvexError("Sign in to a workspace first.");
	const connector = requireConnector(connectorId);
	const install = await installOf(ctx, member.workspaceId, connectorId);
	if (!install) throw new ConvexError("Install the connector first.");
	if (!install.roles.includes(member.role)) throw new ConvexError("Your role can't use this connector.");
	const permission = connector.connection === "workspace" ? "connectors.manage" : "connectors.connect";
	if (!can(member.role, permission)) throw new ConvexError(deniedMessage(permission));
	return { member, connector, userId: connector.connection === "personal" ? member.userId : null };
}

export const connectTarget = internalQuery({
	args: { userId: v.id("users"), connectorId: v.string() },
	handler: async (ctx, { userId, connectorId }) => {
		await requireConnectTarget(ctx, userId, connectorId);
	},
});

/** Replaces stored credentials, e.g. after the runner refreshed an OAuth token. */
export const updateCredentials = internalMutation({
	args: { connectionId: v.id("connectorConnections"), credentials: v.string() },
	handler: async (ctx, { connectionId, credentials }) => {
		if (await ctx.db.get(connectionId)) await ctx.db.patch(connectionId, { credentials, error: undefined });
	},
});

export const saveConnection = internalMutation({
	args: { userId: v.id("users"), connectorId: v.string(), credentials: v.string() },
	handler: async (ctx, args) => {
		const { member, connector, userId } = await requireConnectTarget(ctx, args.userId, args.connectorId);
		const existing = await connectionFor(ctx, connector, member);
		if (existing) await ctx.db.delete(existing._id);
		await ctx.db.insert("connectorConnections", {
			workspaceId: member.workspaceId,
			connectorId: connector.id,
			userId,
			credentials: args.credentials,
			connectedBy: member.userId,
		});
	},
});

export const disconnect = mutation({
	args: { connectorId: v.string() },
	handler: async (ctx, { connectorId }) => {
		const member = await requireMember(ctx);
		const connector = requireConnector(connectorId);
		if (connector.connection === "workspace" && !can(member.role, "connectors.manage")) {
			throw new ConvexError(deniedMessage("connectors.manage"));
		}
		const connection = await connectionFor(ctx, connector, member);
		if (connection) await ctx.db.delete(connection._id);
	},
});

// ---- Internal: used by the agent runner ----

/**
 * The connectors one turn may load: installed, allowed for the person's role (read
 * fresh), and connected. Credentials stay encrypted until the runner needs them.
 */
export const forTurn = internalQuery({
	args: { userId: v.id("users"), connectorIds: v.array(v.string()) },
	handler: async (ctx, { userId, connectorIds }) => {
		const member = await memberOf(ctx, userId);
		if (!member) return [];
		const usable: { connectorId: string; connectionId: Id<"connectorConnections"> | null; credentials: string | null }[] = [];
		for (const connectorId of connectorIds) {
			const connector = findConnector(connectorId);
			const install = connector && (await installOf(ctx, member.workspaceId, connectorId));
			if (!connector || !install || !install.roles.includes(member.role)) continue;
			if (connector.auth.type === "none") {
				usable.push({ connectorId, connectionId: null, credentials: null });
				continue;
			}
			const connection: Doc<"connectorConnections"> | null = await connectionFor(ctx, connector, member);
			if (connection) usable.push({ connectorId, connectionId: connection._id, credentials: connection.credentials });
		}
		return usable;
	},
});

export const setConnectionError = internalMutation({
	args: { connectionId: v.id("connectorConnections"), error: v.optional(v.string()) },
	handler: async (ctx, { connectionId, error }) => {
		const connection = await ctx.db.get(connectionId);
		if (connection && connection.error !== error) await ctx.db.patch(connectionId, { error });
	},
});
