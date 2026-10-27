import { Step, Transform } from "@tiptap/pm/transform";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, mutation } from "./_generated/server";
import { authUserId, memberOf } from "./lib";
import { pageSchema, requireEditable, saveTransform, sync } from "./pageOps";

// Sync names a page alone, so resolve its workspace before checking access.
async function pageFor(ctx: QueryCtx, id: string) {
	const pageId = ctx.db.normalizeId("pages", id);
	const page = pageId && (await ctx.db.get(pageId));
	const userId = await authUserId(ctx);
	const member = page && userId && (await memberOf(ctx, userId, page.workspaceId));
	if (!page || !member) throw new ConvexError("Page not found.");
	return { page, member };
}

export const { getSnapshot, latestVersion, getSteps } = sync.syncApi<DataModel>({ checkRead: async (ctx, id) => { await pageFor(ctx, id); } });

export const submitSteps = mutation({
	args: { id: v.string(), version: v.number(), clientId: v.union(v.string(), v.number()), steps: v.array(v.string()) },
	handler: async (ctx, args) => {
		const { page, member } = await pageFor(ctx, args.id);
		await requireEditable(ctx, member, page);
		const { doc, version } = await sync.getDoc(ctx, page._id, pageSchema());
		if (!Number.isSafeInteger(args.version) || args.version < 1 || args.version > version) throw new ConvexError("Invalid page version.");
		if (args.version < version) {
			const { steps, clientIds } = await ctx.runQuery(components.prosemirrorSync.lib.getSteps, { id: args.id, version: args.version });
			return { status: "needs-rebase" as const, steps, clientIds };
		}
		const tr = new Transform(doc);
		for (const step of args.steps) tr.step(Step.fromJSON(pageSchema(), JSON.parse(step)));
		await saveTransform(ctx, { member }, page, version, tr, args.clientId);
		return { status: "synced" as const };
	},
});

// The editor sends debounced snapshots. Accepted steps already saved the canonical one;
// never trust client content or let a delayed snapshot change history or authorship.
export const submitSnapshot = mutation({
	args: { id: v.string(), version: v.number(), content: v.string() },
	handler: async (ctx, { id }) => {
		await pageFor(ctx, id);
		return null;
	},
});

export const deleteDoc = internalMutation({
	args: { id: v.id("pages") },
	handler: (ctx, args) => ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, args),
});
