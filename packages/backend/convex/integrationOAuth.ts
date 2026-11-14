import { can, integrationScope } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { requireMember, checkPermission, memberOf, randomHex } from "./lib";
import { tokenHash } from "./integrationTokens";

const DAY = 86400000;
export const issuer = () => (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
export const resources = () => [`${issuer()}/mcp`, `${issuer()}/api/v1`];
const requestArgs = { clientId: v.string(), redirect: v.string(), resource: v.string(), challenge: v.string(), scopes: v.array(v.string()), state: v.string() };
export type ConsentRequest = { clientId: string; redirect: string; resource: string; challenge: string; scopes: string[]; state: string };
function validRedirect(value: string) {
	try {
		const url = new URL(value);
		return value.length <= 2048 && !url.hash && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname));
	} catch { return false; }
}
async function clientOf(ctx: QueryCtx, clientId: string) {
	const id = ctx.db.normalizeId("integrationOAuthClients", clientId);
	return id ? ctx.db.get(id) : ctx.db.query("integrationOAuthClients").withIndex("by_url", q => q.eq("metadataUrl", clientId)).unique();
}
async function validate(ctx: QueryCtx, args: ConsentRequest) {
	const client = await clientOf(ctx, args.clientId);
	if (!client || client.expiresAt <= Date.now() || client.metadataUrl && (client.validatedUntil ?? 0) <= Date.now() || !client.redirects.includes(args.redirect)) throw new ConvexError("Unknown client or unregistered redirect URI.");
	if (!issuer() || !resources().includes(args.resource) || !/^[A-Za-z0-9_-]{43}$/.test(args.challenge) || args.state.length > 2048) throw new ConvexError("Invalid resource, state, or S256 PKCE challenge.");
	if (!args.scopes.length || args.scopes.length > 20 || args.scopes.some(s => !integrationScope.safeParse(s).success)) throw new ConvexError("Invalid scope.");
	return client;
}
export const cached = internalQuery({ args: { clientId: v.string() }, handler: async (ctx, { clientId }) => {
	const client = await clientOf(ctx, clientId);
	return !!client && (client.cacheUntil ?? 0) > Date.now();
} });
export const rememberMetadata = internalMutation({ args: { clientId: v.string(), name: v.string(), redirects: v.array(v.string()), maxAge: v.number() }, handler: async (ctx, args) => {
	if (!args.name.trim() || args.name.length > 80 || !args.redirects.length || args.redirects.length > 5 || !args.redirects.every(validRedirect)) throw new ConvexError("Invalid client metadata.");
	const existing = await clientOf(ctx, args.clientId);
	const data = { metadataUrl: args.clientId, name: args.name, redirects: args.redirects, cacheUntil: Date.now() + Math.min(300, Math.max(0, args.maxAge)) * 1000, validatedUntil: Date.now() + 300000, expiresAt: Date.now() + 30 * DAY };
	if (existing) await ctx.db.patch(existing._id, data);
	else {
		const recent = await ctx.db.query("integrationOAuthClients").order("desc").take(100);
		if (recent.length === 100 && recent[99]!._creationTime > Date.now() - 3600000) throw new ConvexError("Client registration limit reached.");
		await ctx.db.insert("integrationOAuthClients", data);
	}
} });
export const inspect = internalQuery({ args: requestArgs, handler: validate });
export const consent = query({ args: requestArgs, handler: async (ctx, args) => {
	const member = await requireMember(ctx);
	checkPermission(member, "integrations.manage");
	const client = await validate(ctx, args);
	return { name: client.name, redirect: args.redirect, workspace: (await ctx.db.get(member.workspaceId))!.name, scopes: args.scopes };
} });
export const approve = mutation({ args: { ...requestArgs, allow: v.boolean(), selectedScopes: v.array(v.string()) }, handler: async (ctx, args) => {
	const member = await requireMember(ctx);
	checkPermission(member, "integrations.manage");
	const client = await validate(ctx, args);
	const redirect = new URL(args.redirect);
	redirect.searchParams.set("state", args.state);
	redirect.searchParams.set("iss", issuer());
	if (!args.allow) { redirect.searchParams.set("error", "access_denied"); return redirect.href; }
	const scopes = [...new Set(args.selectedScopes)];
	if (!scopes.length || scopes.some(s => !args.scopes.includes(s))) throw new ConvexError("Choose only requested scopes.");
	const tokens = await ctx.db.query("integrationTokens").withIndex("by_workspace", q => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).take(20);
	for (const t of tokens) if ((t.oauth?.expiresAt ?? t.expiresAt) <= Date.now()) await ctx.db.delete(t._id);
	if (tokens.filter(t => (t.oauth?.expiresAt ?? t.expiresAt) > Date.now()).length >= 10) throw new ConvexError("Revoke an existing connection first (maximum 10).");
	const tokenId = await ctx.db.insert("integrationTokens", { workspaceId: member.workspaceId, userId: member.userId, memberId: member.id, name: client.name, hash: await tokenHash(randomHex(32)), prefix: "OAuth", scopes, expiresAt: Date.now() + 300000, receipts: [], oauth: { clientId: client._id, resource: args.resource, expiresAt: Date.now() + 30 * DAY } });
	const code = randomHex(32);
	await ctx.db.insert("integrationOAuthCodes", { workspaceId: member.workspaceId, userId: member.userId, tokenId, hash: await tokenHash(code), clientId: client._id, redirect: args.redirect, resource: args.resource, challenge: args.challenge, expiresAt: Date.now() + 300000, used: false });
	await ctx.db.patch(client._id, { expiresAt: Date.now() + 30 * DAY });
	redirect.searchParams.set("code", code);
	return redirect.href;
} });

/** Public clients only: PKCE replaces a secret shipped in a desktop or browser app. */
export const register = internalMutation({ args: { name: v.string(), redirects: v.array(v.string()) }, handler: async (ctx, args) => {
	if (!args.name.trim() || args.name.length > 80 || !args.redirects.length || args.redirects.length > 5 || !args.redirects.every(validRedirect)) return { error: "invalid_client_metadata" };
	const recent = await ctx.db.query("integrationOAuthClients").order("desc").take(100);
	if (recent.length === 100 && recent[99]!._creationTime > Date.now() - 3600000) return { error: "temporarily_unavailable" };
	const clientId = await ctx.db.insert("integrationOAuthClients", { name: args.name.trim(), redirects: [...new Set(args.redirects)], expiresAt: Date.now() + 30 * DAY });
	return { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: args.name.trim(), redirect_uris: args.redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
} });
export const exchange = internalMutation({ args: { grant: v.string(), clientId: v.string(), resource: v.string(), codeHash: v.string(), redirect: v.string(), challenge: v.string(), refreshHash: v.string(), scope: v.optional(v.string()) }, handler: async (ctx, args) => {
	const invalid = { error: "invalid_grant" };
	const code = args.grant === "authorization_code" ? await ctx.db.query("integrationOAuthCodes").withIndex("by_hash", q => q.eq("hash", args.codeHash)).unique() : null;
	const refresh = args.grant === "refresh_token" ? await ctx.db.query("integrationRefreshTokens").withIndex("by_hash", q => q.eq("hash", args.refreshHash)).unique() : null;
	const source = code ?? refresh;
	const client = await clientOf(ctx, args.clientId);
	const token = source && await ctx.db.get(source.tokenId);
	if (!source || source.expiresAt <= Date.now() || !token?.oauth || token.oauth.clientId !== client?._id || token.oauth.resource !== args.resource) return invalid;
	if (code && (code.redirect !== args.redirect || code.challenge !== args.challenge)) return invalid;
	// Keep spent hashes until the grant expires so reuse revokes the entire family.
	if (source.used) { await ctx.db.delete(token._id); return invalid; }
	const member = await memberOf(ctx, token.userId, token.workspaceId);
	if (!member || member.id !== token.memberId || !can(member, "integrations.manage") || token.oauth.expiresAt <= Date.now()) return invalid;
	const scopes = args.scope === undefined ? token.scopes : [...new Set(args.scope.split(" ").filter(Boolean))];
	if (!scopes.length || scopes.some(s => !token.scopes.includes(s))) return { error: "invalid_scope" };
	// Bound refresh churn and the resulting replay-detection rows to one per minute.
	if (refresh && source._creationTime > Date.now() - 60000) return { error: "temporarily_unavailable" };
	await ctx.db.patch(source._id, { used: true });
	const access = `cb_${randomHex(32)}`, nextRefresh = randomHex(32);
	const expiresAt = Math.min(Date.now() + 3600000, token.oauth.expiresAt);
	await ctx.db.patch(token._id, { hash: await tokenHash(access), prefix: access.slice(0, 11), scopes, expiresAt });
	await ctx.db.insert("integrationRefreshTokens", { workspaceId: token.workspaceId, userId: token.userId, tokenId: token._id, hash: await tokenHash(nextRefresh), used: false, expiresAt: token.oauth.expiresAt });
	return { access_token: access, token_type: "Bearer", expires_in: Math.floor((expiresAt - Date.now()) / 1000), refresh_token: nextRefresh, scope: scopes.join(" ") };
} });
export const revoke = internalMutation({ args: { hash: v.string(), clientId: v.string() }, handler: async (ctx, args) => {
	const access = await ctx.db.query("integrationTokens").withIndex("by_hash", q => q.eq("hash", args.hash)).unique();
	const refresh = await ctx.db.query("integrationRefreshTokens").withIndex("by_hash", q => q.eq("hash", args.hash)).unique();
	const token = access ?? (refresh && await ctx.db.get(refresh.tokenId));
	if (token?.oauth && token.oauth.clientId === (await clientOf(ctx, args.clientId))?._id) await ctx.db.delete(token._id);
} });
