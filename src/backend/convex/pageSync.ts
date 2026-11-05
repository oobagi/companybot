import { Step, Transform } from "@tiptap/pm/transform";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { authUserId, memberOf } from "./lib";
import { pageSchema, requireEditable, requirePageAccess, saveTransform, sync } from "./pageOps";
import { withoutPageTitles } from "./pageBlocks";

// Sync names a page alone, so resolve its workspace before checking access.
async function pageFor(ctx: QueryCtx, id: string) {
	const pageId = ctx.db.normalizeId("pages", id);
	const page = pageId && (await ctx.db.get(pageId));
	const userId = await authUserId(ctx);
	const member = page && userId && (await memberOf(ctx, userId, page.workspaceId));
	if (!page || !member) throw new ConvexError("Page not found.");
	await requirePageAccess(ctx, member, page, "view");
	return { page, member };
}

// The editor's reads, as the component's syncApi has them, except that content goes out without the page
// titles old snapshots and steps stored (pageBlocks.ts `withoutPageTitles`): they'd name hidden sub-pages.
export const getSnapshot = query({
	args: { id: v.string(), version: v.optional(v.number()) },
	handler: async (ctx, args): Promise<{ content: null } | { content: string; version: number }> => {
		await pageFor(ctx, args.id);
		const snapshot = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, args);
		return snapshot.content === null ? snapshot : { ...snapshot, content: withoutPageTitles(snapshot.content) };
	},
});

export const getSteps = query({
	args: { id: v.string(), version: v.number() },
	handler: async (ctx, args) => {
		await pageFor(ctx, args.id);
		const result = await ctx.runQuery(components.prosemirrorSync.lib.getSteps, args);
		return { ...result, steps: result.steps.map(withoutPageTitles) };
	},
});

/** `pageFor`, or null where it would refuse: the page is gone, or this person lost access to it. */
async function visiblePage(ctx: QueryCtx, id: string) {
	try {
		return await pageFor(ctx, id);
	} catch (e) {
		if (e instanceof ConvexError) return null;
		throw e;
	}
}

// Open editors stay subscribed when another window deletes the page or someone takes away access to it:
// null, not an error, so the editor can say so (PageEditor) and nothing logs a failed query.
export const latestVersion = query({
	args: { id: v.string() },
	handler: async (ctx, { id }): Promise<number | null> => {
		if (!(await visiblePage(ctx, id))) return null;
		return ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id });
	},
});

export const submitSteps = mutation({
	args: { id: v.string(), version: v.number(), clientId: v.union(v.string(), v.number()), steps: v.array(v.string()) },
	handler: async (ctx, args) => {
		const { page, member } = await pageFor(ctx, args.id);
		await requireEditable(ctx, member, page);
		const { doc, version } = await sync.getDoc(ctx, page._id, pageSchema());
		if (!Number.isSafeInteger(args.version) || args.version < 1 || args.version > version) throw new ConvexError("Invalid page version.");
		if (args.version < version) {
			const { steps, clientIds } = await ctx.runQuery(components.prosemirrorSync.lib.getSteps, { id: args.id, version: args.version });
			return { status: "needs-rebase" as const, steps: steps.map(withoutPageTitles), clientIds };
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
	// Saves nothing, so a page someone just lost (its editor still open) is no error either.
	handler: async () => null,
});

export const deleteDoc = internalMutation({
	args: { id: v.id("pages") },
	handler: (ctx, args) => ctx.runMutation(components.prosemirrorSync.lib.deleteDocument, args),
});
