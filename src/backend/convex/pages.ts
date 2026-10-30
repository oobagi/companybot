import { type PaginationOptions, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { claimUpload, imageUrl } from "./images";
import { type Member, capped, emptyPage, getMember, nameOf, requireMember } from "./lib";
import {
	createPage,
	editorsOf,
	pageOfRecord,
	renamePage,
	requireEditable,
	requirePage,
	restoreVersion,
} from "./pageOps";
import { movePage, pageRow, pageState, pageStates } from "./pageTree";
import { trashInfo } from "./trashOps";

// Pages metadata and history; content syncs through pageSync.ts. See wiki/pages.md.

/** Pages the sidebar lists, by title. */
const LIST_MAX = 200;
const HISTORY_PAGE_MAX = 20;

const canEdit = async (ctx: QueryCtx, member: Member, page: Doc<"pages">) =>
	requireEditable(ctx, member, page).then(
		() => true,
		() => false,
	);

/** Standalone pages, by title. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const pages = await ctx.db
			.query("pages")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", false))
			.take(LIST_MAX);
		// A page under a trashed one is in Trash too.
		const state = pageStates(ctx);
		const visible = [];
		for (const p of pages) if (!(await state(p)).archived) visible.push(pageRow(p));
		return visible;
	},
});

export const get = query({
	args: { pageId: v.string() },
	handler: async (ctx, { pageId }) => {
		const member = await getMember(ctx);
		const id = ctx.db.normalizeId("pages", pageId);
		const page = member && id && (await ctx.db.get(id));
		if (!member || page?.workspaceId !== member.workspaceId) return null;
		const state = await pageState(ctx, page);
		return {
			_id: page._id,
			title: page.title,
			archived: state.archived,
			parentId: page.parentId ?? null,
			ancestors: state.ancestors.slice().reverse().map(pageRow),
			recordId: page.recordId ?? null,
			canEdit: await canEdit(ctx, member, page),
			trash: await trashInfo(ctx, member, state.trashPage?._id ?? page._id),
		};
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
	args: { title: v.optional(v.string()), recordId: v.optional(v.id("records")), parentId: v.optional(v.id("pages")) },
	handler: async (ctx, { title, recordId, parentId }) => {
		if (recordId && parentId) throw new ConvexError("Record bodies can't be nested.");
		const who = { member: await requireMember(ctx) };
		return createPage(ctx, who, recordId ? { recordId } : { title: title ?? "", parentId });
	},
});

/** A paged level of the tree; the sidebar and Move dialog share it. */
export const children = query({
	args: { parentId: v.optional(v.id("pages")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { parentId, paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return emptyPage();
		if (parentId) {
			const parent = await ctx.db.get(parentId);
			if (parent?.workspaceId !== member.workspaceId || parent.recordId || (await pageState(ctx, parent)).archived) return emptyPage();
		}
		const result = await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", parentId).eq("recordId", undefined).eq("archived", false))
			.paginate(capped(paginationOpts, 50));
		const hasChildren = async (p: Doc<"pages">) => !!(await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", p._id).eq("recordId", undefined).eq("archived", false)).first());
		return { ...result, page: await Promise.all(result.page.map(async (p) => ({ ...pageRow(p), hasChildren: await hasChildren(p) }))) };
	},
});

/** Standalone pages whose titles match, with their ancestors' titles: the Move dialog's search. At most 20. */
export const search = query({
	args: { query: v.string() },
	handler: async (ctx, { query: text }) => {
		const member = await getMember(ctx);
		if (!member || !text.trim()) return [];
		// Record bodies can't be filtered out by the index, so walk hits until enough standalone, live pages are found.
		const state = pageStates(ctx);
		const rows = [];
		for await (const p of ctx.db.query("pages").withSearchIndex("search_title", (q) => q.search("title", text).eq("workspaceId", member.workspaceId).eq("archived", false))) {
			if (p.recordId) continue;
			const { archived, ancestors } = await state(p);
			if (!archived) rows.push({ ...pageRow(p), path: ancestors.map((a) => a.title).reverse() });
			if (rows.length === 20) break;
		}
		return rows;
	},
});

/** Validate saved expansion ids without scanning or truncating the workspace's page tree. */
export const liveIds = query({
	args: { ids: v.array(v.string()) },
	handler: async (ctx, { ids }) => {
		if (ids.length > 100) throw new ConvexError("Check at most 100 saved page ids at once.");
		const member = await getMember(ctx);
		// Unknown isn't deleted: signed out (or not yet), keep the saved ids.
		if (!member) return null;
		const state = pageStates(ctx);
		const live = [];
		for (const value of ids) {
			const id = ctx.db.normalizeId("pages", value);
			const page = id && await ctx.db.get(id);
			if (page && page.workspaceId === member.workspaceId && !page.recordId && !(await state(page)).archived) live.push(value);
		}
		return live;
	},
});

export const move = mutation({
	args: { pageId: v.id("pages"), parentId: v.optional(v.id("pages")) },
	handler: async (ctx, { pageId, parentId }) => {
		const member = await requireMember(ctx);
		await movePage(ctx, { member }, await requirePage(ctx, member, pageId), parentId);
	},
});

/** Metadata moves stay separate from restorable content snapshots. */
export const moves = query({
	args: { pageId: v.id("pages"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { pageId, paginationOpts }) => {
		const member = await getMember(ctx);
		const page = member && await ctx.db.get(pageId);
		if (!member || page?.workspaceId !== member.workspaceId) return emptyPage();
		const result = await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", pageId)).order("desc")
			.paginate(capped(paginationOpts, 20));
		return { ...result, page: await Promise.all(result.page.map(async (r) => ({ ...r, user: await nameOf(ctx, r.userId), agent: r.agentId ? (await ctx.db.get(r.agentId))?.name ?? "An agent" : null }))) };
	},
});

/** Puts one of your uploads in a page you can edit; returns its URL for the image block. */
export const addImage = mutation({
	args: { pageId: v.id("pages"), file: v.id("_storage") },
	handler: async (ctx, { pageId, file }) => {
		const member = await requireMember(ctx);
		const page = await requirePage(ctx, member, pageId);
		await requireEditable(ctx, member, page);
		await claimUpload(ctx, member, file);
		const url = (await imageUrl(ctx, file))!;
		await ctx.db.insert("pageImages", { workspaceId: page.workspaceId, pageId, storageId: file, url });
		return url;
	},
});

export const rename = mutation({
	args: { pageId: v.id("pages"), title: v.string() },
	handler: async (ctx, { pageId, title }) => {
		const member = await requireMember(ctx);
		await renamePage(ctx, { member }, await requirePage(ctx, member, pageId), title);
	},
});

/** Versions, newest first: who edited (an agent for whom; `others` joined in meanwhile), and when. */
export const history = query({
	args: { pageId: v.id("pages"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { pageId, paginationOpts }) => {
		const member = await getMember(ctx);
		const page = member && (await ctx.db.get(pageId));
		if (!member || page?.workspaceId !== member.workspaceId) return emptyPage();
		return pageHistory(ctx, page._id, paginationOpts);
	},
});

export async function requireVersion(ctx: QueryCtx, member: Member, versionId: Id<"pageVersions">) {
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
		return versionContent(ctx, page, row);
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

export async function pageHistory(ctx: QueryCtx, pageId: Id<"pages">, paginationOpts: PaginationOptions) {
	const result = await ctx.db
		.query("pageVersions")
		.withIndex("by_page", (q) => q.eq("pageId", pageId))
		.order("desc")
		.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
	return {
		...result,
		page: await Promise.all(
			result.page.map(async (row) => {
				const [first, ...others] = await editorsOf(ctx, row);
				return { _id: row._id, time: row.editedAt, ...first!, others, restored: row.restored ?? null };
			}),
		),
	};
}

export async function versionContent(ctx: QueryCtx, page: Doc<"pages">, row: Doc<"pageVersions">) {
	const snapshot = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: page._id, version: row.version });
	return snapshot.content !== null && snapshot.version === row.version ? snapshot.content : null;
}
