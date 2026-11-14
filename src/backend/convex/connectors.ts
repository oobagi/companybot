import {
	type Connector,
	type ConnectorState,
	can,
	canUseConnector,
	connectorFetch,
	startSignIn,
	validateCredentials,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, type MutationCtx, type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { action, mutation, query } from "./functions";
import { encrypt } from "./crypto";
import { type Member, checkPermission, getMember, memberFor, memberOf, requireMember, requirePermission, rolesOf, sweepExpired } from "./lib";
import { allowedRoles, connectorIn, connectorsIn } from "./connectorAccess";
import { cascading, startCascade } from "./cascade";
import { inheritPlaces, readArtifact } from "./replySources";
import { runningTurn } from "./turns";
import { builtInId } from "./roles";

// Install → choose roles (owners always can) → connect an account → agents granted "<connector>.*" use it.
// Credentials are encrypted in actions (crypto.ts) and only decrypted by the agent runner.

/** A connector this workspace can see: the catalog's or its own (custom). */
async function requireConnector(ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string): Promise<Connector> {
	const connector = await connectorIn(ctx, workspaceId, connectorId);
	if (!connector) throw new ConvexError("Unknown connector.");
	return connector;
}

/**
 * Its old install's accounts, rules and tool list are still being deleted (an uninstall, or an edit
 * to a custom connector's server or sign-in: customConnectors.update). Nothing connects or loads
 * until that's done, so old credentials never reach a new server and new accounts aren't swept up.
 */
const resetting = (ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string) => cascading(ctx, "connectorInstall", { workspaceId, connectorId });

/**
 * The fetch an action connects to `connector` with: undefined (the runtime's) for catalog
 * connectors. For custom ones, core `connectorFetch` over the Node network (connectorNetwork.ts):
 * each host is looked up once per connection and every address checked public, and each request
 * then connects only to those addresses, so nothing ever reaches a private or local one.
 */
export const fetchFor = (ctx: Pick<ActionCtx, "runAction">, connector: Connector) =>
	connector.custom
		? connectorFetch({
				resolve: (hostname) => ctx.runAction(internal.connectorNetwork.addresses, { hostname }),
				request: async (url, addresses, init) => {
					const answer = await ctx.runAction(internal.connectorNetwork.request, { url: url.href, addresses, ...init });
					// These statuses can't carry a body, even an empty one.
					const empty = [204, 205, 304].includes(answer.status);
					return new Response(empty ? null : answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers as [string, string][] });
				},
			})
		: undefined;

export const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string) =>
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
	const connectors = await connectorsIn(ctx, member.workspaceId);
	for (const install of installs) {
		const connector = connectors.find((c) => c.id === install.connectorId);
		if (!connector) continue;
		const connected = connector.auth.type === "none" || !!(await connectionFor(ctx, connector, member));
		states.push({ id: connector.id, roles: allowedRoles(member, install), connected });
	}
	return states;
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const states = await connectorStates(ctx, member);
		const memberRole = member.workspaceRoles.find((r) => r.builtIn === "member")?.id;
		return Promise.all(
			(await connectorsIn(ctx, member.workspaceId)).map(async (connector) => {
				const state = states.find((s) => s.id === connector.id);
				const connection = state ? await connectionFor(ctx, connector, member) : null;
				const roleIds = state?.roles ?? defaultRoles(connector, memberRole);
				return {
					id: connector.id,
					name: connector.name,
					description: connector.description,
					version: connector.version,
					publisher: connector.publisher,
					documentationUrl: connector.documentationUrl ?? null,
					setup: connector.setup ?? null,
					connection: connector.connection,
					server: connector.mcp.url,
					transport: connector.mcp.transport,
					/** Added by this workspace: people with connectors.manage edit or remove it (customConnectors.ts). */
					custom: !!connector.custom,
					// Labels only; nothing secret lives in the catalog.
					auth: connector.auth,
					installed: !!state,
					/** Ids of the roles allowed to use it; before it's installed, the ones that would be. */
					roleIds,
					// COMPAT(0.1.0-alpha.10): alpha.9 apps read `roles.includes("member")` for "Everyone" vs "Owners only"; delete this.
					roles: (memberRole && roleIds.includes(memberRole) ? ["owner", "member"] : ["owner"]) as ("owner" | "member")[],
					canUse: !!state && canUseConnector(member, state.roles),
					connected: state?.connected ?? false,
					error: connection?.error ?? null,
					canConnect:
						connector.connection === "workspace" ? can(member, "connectors.manage") : can(member, "connectors.connect"),
					oauthRedirectUrl: connector.auth.type === "oauth" ? oauthRedirectUrl() : null,
				};
			}),
		);
	},
});

export const setInstalled = mutation({
	args: { connectorId: v.string(), installed: v.boolean() },
	handler: async (ctx, { connectorId, installed }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const connector = await requireConnector(ctx, member.workspaceId, connectorId);
		const existing = await installOf(ctx, member.workspaceId, connectorId);
		if (installed && !existing) await install(ctx, member, connector);
		if (!installed && existing) await uninstall(ctx, connector, existing);
	},
});

/** Installs a connector here, for its default roles. Waits out an uninstall still deleting the old one's rows. */
export async function install(ctx: MutationCtx, member: Member, connector: Connector, roles?: Id<"roles">[]) {
	if (await resetting(ctx, member.workspaceId, connector.id)) throw new ConvexError("It's still being uninstalled. Try again in a minute.");
	if (roles) {
		const here = new Set((await rolesOf(ctx, member.workspaceId)).map((r) => r._id));
		if (roles.some((id) => !here.has(id))) throw new ConvexError("Role not found.");
	}
	return ctx.db.insert("connectorInstalls", {
		workspaceId: member.workspaceId,
		connectorId: connector.id,
		roles: roles ?? defaultRoles(connector, await builtInId(ctx, member.workspaceId, "member")),
		installedBy: member.userId,
	});
}

/** Ends access at once, then deletes its accounts, rules, locks and tool list (lifecycle.ts): reinstalling starts strict again. */
export async function uninstall(ctx: MutationCtx, connector: Connector, existing: Doc<"connectorInstalls">) {
	if (connector.connection === "workspace") await ctx.db.insert("connectorSourceLabels", { workspaceId: existing.workspaceId, installId: existing._id, name: connector.name });
	await ctx.db.delete(existing._id);
	await startCascade(ctx, "connectorInstall", { workspaceId: existing.workspaceId, connectorId: connector.id, connectorInstallId: existing._id });
}

/** Custom servers start Owners-only. Existing installs keep their explicitly stored audience. */
const defaultRoles = (connector: Connector, memberRole: Id<"roles"> | undefined): Id<"roles">[] => (connector.custom || connector.ownersOnly || !memberRole ? [] : [memberRole]);

/** Which of the workspace's roles may use an installed connector. Owners always can. Applies at once, including mid-reply. */
export const setRoles = mutation({
	// COMPAT(0.1.0-alpha.10): alpha.9 apps send "owner" or "member"; narrow this to role ids and delete `legacy` below.
	args: { connectorId: v.string(), roles: v.array(v.union(v.id("roles"), v.literal("owner"), v.literal("member"))) },
	handler: async (ctx, { connectorId, roles }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const install = await installOf(ctx, member.workspaceId, connectorId);
		if (!install) throw new ConvexError("Install the connector first.");
		const memberRole = await builtInId(ctx, member.workspaceId, "member");
		const here = new Set((await rolesOf(ctx, member.workspaceId)).map((r) => r._id));
		// alpha.9 apps only know Owner and Member: their save adds or removes Member and keeps every other role's grant.
		const legacy = roles.some((r) => r === "owner" || r === "member");
		const kept = (install.roles as string[]).filter((r): r is Id<"roles"> => r !== "owner" && r !== "member" && r !== memberRole && here.has(r as Id<"roles">));
		const ids = legacy ? [...kept, ...(roles.includes("member") ? [memberRole] : [])] : (roles as Id<"roles">[]);
		if (ids.some((id) => !here.has(id))) throw new ConvexError("Role not found.");
		await ctx.db.patch(install._id, { roles: [...new Set(ids)] });
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
	args: {
		connectorId: v.string(),
		client: v.optional(v.object({ clientId: v.string(), clientSecret: v.optional(v.string()), issuer: v.string() })),
	},
	handler: async (ctx, { connectorId, client }): Promise<string> => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const target = await ctx.runQuery(internal.connectors.connectTarget, { userId, workspaceId: ctx.workspaceId, connectorId });
		const connector = await requireDefinition(ctx, target.workspaceId, connectorId);
		if (connector.auth.type !== "oauth") throw new ConvexError("This connector doesn't sign in through the browser.");
		let started: Awaited<ReturnType<typeof startSignIn>>;
		try {
			started = await startSignIn(connector, oauthRedirectUrl(), fetchFor(ctx, connector), client);
		} catch (e) {
			throw new ConvexError(`Couldn't start signing in to ${connector.name}: ${e instanceof Error ? e.message : e}`);
		}
		await ctx.runMutation(internal.connectors.saveOAuthFlow, {
			userId,
			...target,
			connectorId,
			state: started.state.state!,
			data: await encrypt(started.state),
		});
		return started.url;
	},
});

const startedUnder = { memberId: v.id("members"), connectorInstallId: v.id("connectorInstalls") };

export const saveOAuthFlow = internalMutation({
	args: { userId: v.id("users"), workspaceId: v.id("workspaces"), ...startedUnder, connectorId: v.string(), state: v.string(), data: v.string() },
	handler: async (ctx, args) => {
		// Checked again: they may have been removed, or it uninstalled, while the provider answered.
		await requireConnectTarget(ctx, args.userId, args.workspaceId, args.connectorId, args);
		// Only the newest sign-in per person counts; drop abandoned ones.
		const old = await ctx.db
			.query("connectorOAuthFlows")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.collect();
		for (const flow of old) await ctx.db.delete(flow._id);
		await ctx.db.insert("connectorOAuthFlows", { ...args, expiresAt: Date.now() + OAUTH_FLOW_MS });
	},
});

/** Runs hourly (crons.ts): deletes sign-ins nobody finished. */
export const forgetExpiredOAuth = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = ctx.db.query("connectorOAuthFlows").withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - OAUTH_FLOW_MS));
		await sweepExpired(ctx, expired, (flow) => ctx.db.delete(flow._id), internal.connectors.forgetExpiredOAuth);
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
		// Check permission before encrypting, then again when saving.
		const target = await ctx.runQuery(internal.connectors.connectTarget, { userId, workspaceId: ctx.workspaceId, connectorId: args.connectorId });
		const connector = await requireDefinition(ctx, target.workspaceId, args.connectorId);
		const problem = validateCredentials(connector, args.credentials);
		if (problem) throw new ConvexError(problem);
		const sealed = await encrypt(args.credentials);
		await ctx.runMutation(internal.connectors.saveConnection, { userId, ...target, connectorId: connector.id, credentials: sealed });
	},
});

/**
 * `workspaceId` is where it connects; without one, nowhere. With
 * `bound` (a save after the check), the membership and install must be the ones it started
 * under: being removed and rejoining, or an uninstall and reinstall, in between refuses it.
 */
async function requireConnectTarget(
	ctx: QueryCtx,
	userId: Id<"users">,
	workspaceId: Id<"workspaces"> | undefined,
	connectorId: string,
	bound?: { memberId: Id<"members">; connectorInstallId: Id<"connectorInstalls"> },
) {
	const member = await memberFor(ctx, userId, workspaceId);
	if (!member) throw new ConvexError("Sign in to a workspace first.");
	const connector = await requireConnector(ctx, member.workspaceId, connectorId);
	const install = await installOf(ctx, member.workspaceId, connectorId);
	if (!install) throw new ConvexError("Install the connector first.");
	if (await resetting(ctx, member.workspaceId, connectorId)) throw new ConvexError(`${connector.name} changed and its old connections are still being deleted. Try again in a minute.`);
	if (!canUseConnector(member, allowedRoles(member, install))) throw new ConvexError("None of your roles can use this connector. Ask someone who installs connectors to allow one.");
	const permission = connector.connection === "workspace" ? "connectors.manage" : "connectors.connect";
	checkPermission(member, permission);
	if (bound && (bound.memberId !== member.id || bound.connectorInstallId !== install._id))
		throw new ConvexError(`This sign-in started before ${connector.name} or your membership changed. Connect again.`);
	return { member, connector, userId: connector.connection === "personal" ? member.userId : null, memberId: member.id, connectorInstallId: install._id };
}

/** A connector's definition in a workspace (no secrets): the catalog's or its own. For the OAuth callback. */
export const definition = internalQuery({
	args: { workspaceId: v.id("workspaces"), connectorId: v.string() },
	handler: async (ctx, { workspaceId, connectorId }) => (await connectorIn(ctx, workspaceId, connectorId)) ?? null,
});

async function requireDefinition(ctx: Pick<ActionCtx, "runQuery">, workspaceId: Id<"workspaces">, connectorId: string): Promise<Connector> {
	const connector = await ctx.runQuery(internal.connectors.definition, { workspaceId, connectorId });
	if (!connector) throw new ConvexError("Unknown connector.");
	return connector;
}

export const connectTarget = internalQuery({
	args: { userId: v.id("users"), workspaceId: v.optional(v.id("workspaces")), connectorId: v.string() },
	/** Where it connects, and under which membership and install, so the save (maybe an OAuth callback later) lands there or nowhere. */
	handler: async (ctx, { userId, workspaceId, connectorId }) => {
		const { member, memberId, connectorInstallId } = await requireConnectTarget(ctx, userId, workspaceId, connectorId);
		return { workspaceId: member.workspaceId, memberId, connectorInstallId };
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
	args: { userId: v.id("users"), workspaceId: v.id("workspaces"), ...startedUnder, connectorId: v.string(), credentials: v.string() },
	handler: async (ctx, args) => {
		const { member, connector, userId } = await requireConnectTarget(ctx, args.userId, args.workspaceId, args.connectorId, args);
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
		const connector = await requireConnector(ctx, member.workspaceId, connectorId);
		if (connector.connection === "workspace") checkPermission(member, "connectors.manage");
		const connection = await connectionFor(ctx, connector, member);
		if (connection) await ctx.db.delete(connection._id);
	},
});

// ---- Internal: used by the agent runner ----

/**
 * The connectors one turn may load: installed, allowed for one of the person's roles (read
 * fresh), and connected. Credentials stay encrypted until the runner needs them.
 */
export const forTurn = internalQuery({
	args: { userId: v.id("users"), workspaceId: v.id("workspaces"), connectorIds: v.array(v.string()) },
	handler: async (ctx, { userId, workspaceId, connectorIds }) => {
		const member = await memberOf(ctx, userId, workspaceId);
		if (!member) return [];
		return usableConnectors(ctx, member, connectorIds);
	},
});

async function usableConnectors(ctx: QueryCtx, member: Member, connectorIds: string[]) {
	/** `connector`: its definition (no secrets), the workspace's own for custom ones, so the runner needs no lookup. */
	const usable: { connectorId: string; connector: Connector; installId: Id<"connectorInstalls">; connectionId: Id<"connectorConnections"> | null; credentials: string | null }[] = [];
	for (const connectorId of connectorIds) {
		const connector = await connectorIn(ctx, member.workspaceId, connectorId);
		const install = connector && (await installOf(ctx, member.workspaceId, connectorId));
		if (!connector || !install || !canUseConnector(member, allowedRoles(member, install))) continue;
		if (await resetting(ctx, member.workspaceId, connectorId)) continue;
		if (connector.auth.type === "none") {
			usable.push({ connectorId, connector, installId: install._id, connectionId: null, credentials: null });
			continue;
		}
		const connection: Doc<"connectorConnections"> | null = await connectionFor(ctx, connector, member);
		if (connection) usable.push({ connectorId, connector, installId: install._id, connectionId: connection._id, credentials: connection.credentials });
	}
	return usable;
}

/** Record the install's live role audience, or the personal account's one-person audience, before use. */
export const forCall = internalMutation({
	args: { turnId: v.id("agentTurns"), connectorId: v.string() },
	handler: async (ctx, { turnId, connectorId }) => {
		const { member } = await runningTurn(ctx, turnId);
		const connection = (await usableConnectors(ctx, member, [connectorId]))[0];
		if (!connection) return null;
		if (connection.connector.connection === "personal") await readArtifact(ctx, member, {}, member.userId);
		else await inheritPlaces(ctx, member, [connection.installId]);
		return { connectionId: connection.connectionId };
	},
});

export const setConnectionError = internalMutation({
	args: { connectionId: v.id("connectorConnections"), error: v.optional(v.string()) },
	handler: async (ctx, { connectionId, error }) => {
		const connection = await ctx.db.get(connectionId);
		if (connection && connection.error !== error) await ctx.db.patch(connectionId, { error });
	},
});
