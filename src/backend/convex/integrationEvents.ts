import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { Member } from "./lib";
import { requireRecord } from "./recordOps";
import { requirePage } from "./pageOps";
import { requireChat } from "./chatOps";
import { canReadReply } from "./replyPrivacy";

export async function readEvents(ctx: QueryCtx, member: Member, scopes: string[], cursor: string | null, limit: number, since: number) {
	const after = cursor === null ? 0 : Number(cursor);
	if (!Number.isSafeInteger(after) || after < 0 || cursor !== null && !/^\d+$/.test(cursor)) throw new ConvexError("Invalid event cursor.");
	const rows = await ctx.db.query("integrationEvents").withIndex("by_workspace", q => q.eq("workspaceId", member.workspaceId).gt("sequence", after)).take(limit + 1);
	const scanned = rows.slice(0, limit);
	const page = [];
	for (const row of scanned) if (row._creationTime >= since && row.expiresAt > Date.now() && await visible(ctx, member, scopes, row)) page.push({ id: row._id, type: row.kind, resourceId: row.resource, at: row._creationTime });
	return { page, isDone: rows.length <= limit, continueCursor: String(scanned.at(-1)?.sequence ?? after), retentionDays: 7 };
}
async function visible(ctx: QueryCtx, member: Member, scopes: string[], event: Doc<"integrationEvents">) {
	try {
		if (event.kind.startsWith("record.") && scopes.includes("records:read")) { await requireRecord(ctx, member, ctx.db.normalizeId("records", event.resource)!); return true; }
		if (event.kind.startsWith("page.") && scopes.includes("pages:read")) { await requirePage(ctx, member, ctx.db.normalizeId("pages", event.resource)!); return true; }
		if (event.kind.startsWith("message.") && scopes.includes("chats:read")) {
			const message = await ctx.db.get(ctx.db.normalizeId("chatMessages", event.resource)!);
			if (!message) return false;
			await requireChat(ctx, member, message.chatId);
			// Same source restrictions as message reads. Even an id can disclose a private reply.
			return !message.quiet && await canReadReply(ctx, member, message);
		}
	} catch { return false; }
	return false;
}
