import { can, integrationScope } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { checkPermission, memberOf, randomHex, requireMember } from "./lib";
import type { MutationCtx } from "./_generated/server";

export const tokenHash = async (secret: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))), b => b.toString(16).padStart(2, "0")).join("");

export const list = query({
	args: {},
	handler: async ctx => {
		const member = await requireMember(ctx);
		const rows = await ctx.db.query("integrationTokens").withIndex("by_workspace", q => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).take(20);
		return { workspaceId: member.workspaceId, endpoint: process.env.CONVEX_SITE_URL ?? null, tokens: rows.map(t => ({ id: t._id, name: t.name, prefix: t.prefix, scopes: t.scopes, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt ?? null, lastOperation: t.lastOperation ?? null })) };
	},
});
export const create = mutation({
	args: { name: v.string(), scopes: v.array(v.string()), days: v.number() },
	handler: async (ctx, args) => {
		const member = await requireMember(ctx);
		checkPermission(member, "integrations.manage");
		const name = args.name.trim();
		if (!name || name.length > 80 || !Number.isInteger(args.days) || args.days < 1 || args.days > 90) throw new ConvexError("Use a name up to 80 characters and an expiration of 1 to 90 days.");
		const scopes = [...new Set(args.scopes)];
		if (!scopes.length || scopes.some(s => !integrationScope.safeParse(s).success)) throw new ConvexError("Choose valid scopes.");
		const rows = await ctx.db.query("integrationTokens").withIndex("by_workspace", q => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).take(20);
		for (const row of rows) if (row.expiresAt <= Date.now()) await ctx.db.delete(row._id);
		if (rows.filter(r => r.expiresAt > Date.now()).length >= 10) throw new ConvexError("Revoke a token before creating another (maximum 10).");
		const secret = `cb_${randomHex(32)}`;
		const expiresAt = Date.now() + args.days * 86400000;
		const id = await ctx.db.insert("integrationTokens", { workspaceId: member.workspaceId, userId: member.userId, memberId: member.id, name, hash: await tokenHash(secret), prefix: secret.slice(0, 11), scopes, expiresAt, receipts: [] });
		return { id, secret, expiresAt };
	},
});
export const revoke = mutation({
	args: { id: v.id("integrationTokens") },
	handler: async (ctx, { id }) => {
		const member = await requireMember(ctx);
		const token = await ctx.db.get(id);
		if (!token || token.workspaceId !== member.workspaceId || token.userId !== member.userId) throw new ConvexError("Token not found.");
		await ctx.db.delete(id);
	},
});

/** Rechecked in the same transaction as every operation, including replay. */
export async function authenticateIntegration(ctx: MutationCtx, hash: string) {
	const token = await ctx.db.query("integrationTokens").withIndex("by_hash", q => q.eq("hash", hash)).unique();
	const member = token && token.expiresAt > Date.now() ? await memberOf(ctx, token.userId, token.workspaceId) : null;
	if (!token || !member || member.id !== token.memberId || !can(member, "integrations.manage")) return null;
	return { token, member };
}
