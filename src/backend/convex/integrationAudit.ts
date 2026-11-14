import { integrationOperations } from "@companybot/core";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { query } from "./functions";
import { requireMember } from "./lib";

/** Start before executing: a crashed request stays visibly unfinished. No arguments, results, IPs, URLs or credentials. */
export const start = internalMutation({ args: { hash: v.string(), requestId: v.string(), transport: v.string() }, handler: async (ctx, args) => {
	const token = await ctx.db.query("integrationTokens").withIndex("by_hash", q => q.eq("hash", args.hash)).unique();
	if (!token) return { id: null, limited: false };
	const now = Date.now();
	const windowAt = token.windowAt && token.windowAt > now - 60000 ? token.windowAt : now;
	const count = windowAt === token.windowAt ? token.requests ?? 0 : 0;
	if (count > 60) return { id: null, limited: true };
	await ctx.db.patch(token._id, { windowAt, requests: count + 1 });
	const id = await ctx.db.insert("integrationAudit", { workspaceId: token.workspaceId, userId: token.userId, memberId: token.memberId, tokenId: token._id, requestId: args.requestId, transport: args.transport, operation: "protocol", expiresAt: Date.now() + 30 * 86400000 });
	return { id, limited: count >= 60 };
} });
export const finish = internalMutation({ args: { id: v.id("integrationAudit"), operation: v.optional(v.string()), status: v.number() }, handler: async (ctx, { id, operation, status }) => {
	if (await ctx.db.get(id)) await ctx.db.patch(id, { status, operation: operation && Object.hasOwn(integrationOperations, operation) ? operation : "protocol" });
} });
export const list = query({ args: { cursor: v.union(v.string(), v.null()) }, handler: async (ctx, args) => {
	const member = await requireMember(ctx);
	const result = await ctx.db.query("integrationAudit").withIndex("by_user", q => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId)).order("desc").paginate({ cursor: args.cursor, numItems: 25 });
	return { ...result, page: result.page.filter(r => r.memberId === member.id && r.expiresAt > Date.now()) };
} });
