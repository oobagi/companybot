import { connectionEncryptionConfigured } from "./integrationSetup";
import { can, customUrlProblem } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { action, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { requireMember, memberOf, randomHex } from "./lib";
import { encrypt } from "./crypto";
import { readEvents } from "./integrationEvents";

export const list = query({ args: {}, handler: async ctx => {
	const member = await requireMember(ctx);
	const rows = await ctx.db.query("integrationWebhooks").withIndex("by_user", q => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId)).take(10);
	return rows.filter(r => r.memberId === member.id).map(({ secret: _secret, pending: _pending, ...row }) => row);
} });
export const create = action({ args: { tokenId: v.id("integrationTokens"), url: v.string() }, handler: async (ctx, args): Promise<{ id: string; secret: string }> => {
	if (!connectionEncryptionConfigured()) throw new ConvexError("Webhook setup required. Ask your Companybot administrator to configure secure signing-secret storage, then try again.");
	const secret = randomHex(32);
	const id = await ctx.runMutation(internal.integrationWebhooks.save, { ...args, workspaceId: ctx.workspaceId, secret: await encrypt(secret) });
	return { id, secret };
} });
export const save = internalMutation({ args: { workspaceId: v.optional(v.id("workspaces")), tokenId: v.id("integrationTokens"), url: v.string(), secret: v.string() }, handler: async (ctx, args) => {
	const requested = { ...ctx, workspaceId: args.workspaceId };
	const member = await requireMember(requested);
	const token = await ctx.db.get(args.tokenId);
	if (!can(member, "integrations.manage") || !token || token.workspaceId !== member.workspaceId || token.userId !== member.userId || token.memberId !== member.id || !token.scopes.includes("events:read") || (token.oauth?.expiresAt ?? token.expiresAt) <= Date.now()) throw new ConvexError("Choose your own active token with events:read scope.");
	if (args.url.length > 2048 || customUrlProblem(args.url) || !args.url.startsWith("https://") || new URL(args.url).hash || new URL(args.url).search) throw new ConvexError("Use a public HTTPS URL without a query or fragment.");
	const existing = await ctx.db.query("integrationWebhooks").withIndex("by_user", q => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId)).take(5);
	if (existing.length >= 5) throw new ConvexError("Remove an existing webhook first (maximum 5).");
	return ctx.db.insert("integrationWebhooks", { workspaceId: member.workspaceId, userId: member.userId, memberId: member.id, tokenId: token._id, url: args.url, secret: args.secret, since: Date.now(), cursor: null, nextAt: Date.now(), attempts: 0, disabled: false });
} });
export const remove = mutation({ args: { id: v.id("integrationWebhooks") }, handler: async (ctx, { id }) => {
	const member = await requireMember(ctx), row = await ctx.db.get(id);
	if (!row || row.workspaceId !== member.workspaceId || row.userId !== member.userId) throw new ConvexError("Webhook not found.");
	await ctx.db.delete(id);
} });
export const tick = internalMutation({ args: {}, handler: async ctx => {
	const due = await ctx.db.query("integrationWebhooks").withIndex("by_due", q => q.eq("disabled", false).lte("nextAt", Date.now())).take(25);
	for (const row of due) {
		// A lease also recovers delivery actions interrupted before recording their result.
		await ctx.db.patch(row._id, { nextAt: Date.now() + 60000 });
		await ctx.scheduler.runAfter(0, internal.integrationNetwork.deliver, { id: row._id });
	}
} });
export const prepare = internalMutation({ args: { id: v.id("integrationWebhooks") }, handler: async (ctx, { id }) => {
	const row = await ctx.db.get(id);
	if (!row || row.disabled) return null;
	const token = await ctx.db.get(row.tokenId);
	const member = await memberOf(ctx, row.userId, row.workspaceId);
	if (!token || !member || member.id !== row.memberId || token.memberId !== member.id || !can(member, "integrations.manage") || !token.scopes.includes("events:read") || (token.oauth?.expiresAt ?? token.expiresAt) <= Date.now()) { await ctx.db.patch(id, { disabled: true }); return null; }
	if (row.attempts >= 5) { await ctx.db.patch(id, { disabled: true }); return null; }
	// Re-read this batch on every retry. Revoked place access never leaks event details.
	const batch = await readEvents(ctx, member, token.scopes, row.cursor, 25, row.since);
	if (!batch.page.length) { await ctx.db.patch(id, { cursor: batch.continueCursor, pending: undefined, attempts: 0 }); return null; }
	const pending = row.pending ?? { id: crypto.randomUUID(), at: Date.now(), cursor: batch.continueCursor };
	await ctx.db.patch(id, { pending, attempts: row.attempts + 1 });
	return { url: row.url, secret: row.secret, deliveryId: pending.id, body: JSON.stringify({ id: pending.id, type: "events.available", createdAt: pending.at }) };
} });
export const complete = internalMutation({ args: { id: v.id("integrationWebhooks"), deliveryId: v.string(), status: v.number() }, handler: async (ctx, args) => {
	const row = await ctx.db.get(args.id);
	if (!row || row.disabled || row.pending?.id !== args.deliveryId) return;
	const ok = args.status >= 200 && args.status < 300;
	await ctx.db.patch(row._id, { lastStatus: args.status, nextAt: Date.now() + (ok ? 60000 : Math.min(3600000, 60000 * 2 ** row.attempts)), ...(ok ? { cursor: row.pending.cursor, pending: undefined, attempts: 0 } : { disabled: row.attempts >= 5 }) });
} });
