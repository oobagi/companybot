import { can, deniedMessage } from "@companybot/core";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { startCascade } from "./cascade";
import { mutation, query } from "./functions";
import { type Member, getMember, nameOf, requireMember } from "./lib";
import {
	createPage,
	pageOfRecord,
	renamePage,
	requireEditable,
	requirePage,
	restoreVersion,
	setPageArchived,
} from "./pageOps";

// Pages metadata and history; content syncs through pageSync.ts. See wiki/pages.md.

/** Pages the sidebar lists, by title. */
const LIST_MAX = 200;
const HISTORY_PAGE_MAX = 20;

const canEdit = async (ctx: QueryCtx, member: Member, page: Doc<"pages">) =>
	requireEditable(ctx, member, page).then(
		() => true,
		() => false,
	);

/** Standalone pages, live or archived, by title. */
export const list = query({
	args: { archived: v.optional(v.boolean()) },
	handler: async (ctx, { archived = false }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const pages = await ctx.db
			.query("pages")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", archived))
			.take(LIST_MAX);
		return pages.map((p) => ({ _id: p._id, title: p.title, updatedAt: p.updatedAt }));
	},
});

export const get = query({
	args: { pageId: v.id("pages") },
	handler: async (ctx, { pageId }) => {
		const member = await getMember(ctx);
		const page = member && (await ctx.db.get(pageId));
		if (!member || page?.workspaceId !== member.workspaceId) return null;
		return { _id: page._id, title: page.title, archived: page.archived, recordId: page.recordId ?? null, canEdit: await canEdit(ctx, member, page) };
	},
});

/** A record's body: its page id, or null before anyone writes in it. */
export const forRecord = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		return member ? ((await pageOfRecord(ctx, member.workspaceId, recordId))?._id ?? null) : null;
	},
});

/** A standalone page, or a record's body (its existing one, if any). */
export const create = mutation({
	args: { title: v.optional(v.string()), recordId: v.optional(v.id("records")) },
	handler: async (ctx, { title, recordId }) => {
		const who = { member: await requireMember(ctx) };
		return createPage(ctx, who, recordId ? { recordId } : { title: title ?? "" });
	},
});

export const rename = mutation({
	args: { pageId: v.id("pages"), title: v.string() },
	handler: async (ctx, { pageId, title }) => {
		const member = await requireMember(ctx);
		await renamePage(ctx, { member }, await requirePage(ctx, member, pageId), title);
	},
});

export const setArchived = mutation({
	args: { pageId: v.id("pages"), archived: v.boolean() },
	handler: async (ctx, { pageId, archived }) => {
		const member = await requireMember(ctx);
		await setPageArchived(ctx, { member }, await requirePage(ctx, member, pageId), archived);
	},
});

/** Deletes an archived page for good: its content and history go too. */
export const remove = mutation({
	args: { pageId: v.id("pages") },
	handler: async (ctx, { pageId }) => {
		const member = await requireMember(ctx);
		const page = await requirePage(ctx, member, pageId);
		if (!can(member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
		if (page.recordId) throw new ConvexError("Delete the record instead.");
		if (!page.archived) throw new ConvexError("Archive the page first.");
		await ctx.db.delete(page._id);
		await ctx.scheduler.runAfter(0, internal.pageSync.deleteDoc, { id: page._id });
		await startCascade(ctx, "page", { pageId: page._id });
	},
});

/** Versions, newest first: who edited (an agent for whom), and when. */
export const history = query({
	args: { pageId: v.id("pages"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { pageId, paginationOpts }) => {
		const member = await getMember(ctx);
		const page = member && (await ctx.db.get(pageId));
		if (!member || page?.workspaceId !== member.workspaceId) return { page: [], isDone: true, continueCursor: "" };
		const result = await ctx.db
			.query("pageVersions")
			.withIndex("by_page", (q) => q.eq("pageId", pageId))
			.order("desc")
			.paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, HISTORY_PAGE_MAX) });
		return {
			...result,
			page: await Promise.all(
				result.page.map(async (row) => ({
					_id: row._id,
					time: row.editedAt,
					user: await nameOf(ctx, row.userId),
					agent: row.agentId ? ((await ctx.db.get(row.agentId))?.name ?? "An agent") : null,
					restored: row.restored ?? null,
				})),
			),
		};
	},
});

async function requireVersion(ctx: QueryCtx, member: Member, versionId: Id<"pageVersions">) {
	const row = await ctx.db.get(versionId);
	const page = row && (await ctx.db.get(row.pageId));
	if (!row || page?.workspaceId !== member.workspaceId) throw new ConvexError("Version not found.");
	return { row, page };
}

/** One version's content (ProseMirror JSON), to show it. Null once it's gone. */
export const version = query({
	args: { versionId: v.id("pageVersions") },
	handler: async (ctx, { versionId }) => {
		const { row, page } = await requireVersion(ctx, await requireMember(ctx), versionId);
		const snapshot = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: page._id, version: row.version });
		return snapshot.content !== null && snapshot.version === row.version ? snapshot.content : null;
	},
});

/** Brings a version back as the newest one, so nothing is lost. */
export const restore = mutation({
	args: { versionId: v.id("pageVersions") },
	handler: async (ctx, { versionId }) => {
		const member = await requireMember(ctx);
		const { row, page } = await requireVersion(ctx, member, versionId);
		await restoreVersion(ctx, { member }, page, row);
	},
});
