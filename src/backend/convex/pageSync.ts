import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { authUserId, memberOf } from "./lib";
import { PAGE_MAX_BYTES, latestVersionOf, recordVersion, requireEditable } from "./pageOps";

// The editor's sync API: prosemirror-sync's useBlockNoteSync calls these with the page's id
// alone, so the workspace comes from the page (whoever's in its workspace may read it) rather
// than the request (functions.ts). They wrap the component's own functions with access checks,
// and log versions as snapshots land. See wiki/pages.md.

const lib = components.prosemirrorSync.lib;

async function pageFor(ctx: QueryCtx, id: string) {
	const pageId = ctx.db.normalizeId("pages", id);
	const page = pageId && (await ctx.db.get(pageId));
	const userId = await authUserId(ctx);
	const member = page && userId && (await memberOf(ctx, userId, page.workspaceId));
	if (!page || !member) throw new ConvexError("Page not found.");
	return { page, member };
}

async function editable(ctx: QueryCtx, id: string) {
	const found = await pageFor(ctx, id);
	await requireEditable(ctx, found.member, found.page);
	return found;
}

export const getSnapshot = query({
	args: { id: v.string(), version: v.optional(v.number()) },
	handler: async (ctx, args) => {
		await pageFor(ctx, args.id);
		return ctx.runQuery(lib.getSnapshot, args);
	},
});

export const latestVersion = query({
	args: { id: v.string() },
	handler: async (ctx, args) => {
		await pageFor(ctx, args.id);
		return ctx.runQuery(lib.latestVersion, args);
	},
});

export const getSteps = query({
	args: { id: v.string(), version: v.number() },
	handler: async (ctx, args) => {
		await pageFor(ctx, args.id);
		return ctx.runQuery(lib.getSteps, args);
	},
});

export const submitSteps = mutation({
	args: { id: v.string(), version: v.number(), clientId: v.union(v.string(), v.number()), steps: v.array(v.string()) },
	handler: async (ctx, args) => {
		await editable(ctx, args.id);
		// One delta is one document: a paste past this can't be stored, or kept as a version.
		if (args.steps.reduce((n, step) => n + step.length, 0) > PAGE_MAX_BYTES) throw new ConvexError("That's too much to add at once. Split it into several pages.");
		return ctx.runMutation(lib.submitSteps, args);
	},
});

/** Sent by the editor that made the last change, a second after it stops. */
export const submitSnapshot = mutation({
	args: { id: v.string(), version: v.number(), content: v.string() },
	handler: async (ctx, args) => {
		const { page, member } = await editable(ctx, args.id);
		if (args.content.length > PAGE_MAX_BYTES) throw new ConvexError("This page is too long to save. Remove something, or split it into several pages.");
		// A late one (a newer snapshot already landed) adds nothing.
		if (args.version <= ((await latestVersionOf(ctx, page._id))?.version ?? 1)) return null;
		await ctx.runMutation(lib.submitSnapshot, args);
		await recordVersion(ctx, { member }, page, args.version);
		return null;
	},
});

/** Deletes a page's content, a little at a time (the component schedules the rest). */
export const deleteDoc = internalMutation({
	args: { id: v.id("pages") },
	handler: (ctx, { id }: { id: Id<"pages"> }) => ctx.runMutation(lib.deleteDocument, { id }),
});
