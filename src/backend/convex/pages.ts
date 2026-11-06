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
	pageReach,
	pageVisible,
	renamePage,
	requireEditable,
	requirePage,
	restoreVersion,
} from "./pageOps";
import { accessInfo, requireKeepsEdit, savedAccess } from "./placeAccess";
import { withoutPageTitles } from "./pageBlocks";
import { changeAccessSources, writeSources } from "./replySources";
import { accessArg } from "./schema";
import { can } from "@companybot/core";
import { hasChildren, kindOf, movePage, pageRow, pageState, pageStates } from "./pageTree";
import { trashInfo } from "./trashOps";

// Pages metadata and history; content syncs through pageSync.ts. See wiki/pages.md.

/** Pages the sidebar lists, by title. */
const LIST_MAX = 200;
const HISTORY_PAGE_MAX = 20;
const AUDIENCE_SCAN_MAX = 1_000;

const canEdit = async (ctx: QueryCtx, member: Member, page: Doc<"pages">) =>
	requireEditable(ctx, member, page).then(
		() => true,
		() => false,
	);

/** Standalone pages you can see, by title. */
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
		const reach = pageReach(ctx, member);
		const visible = [];
		for (const p of pages) {
			const { archived, ancestors } = await state(p);
			const level = !archived && (await reach(p));
			if (level) visible.push(pageRow(p, member, level, !ancestors[0] || !!(await reach(ancestors[0]))));
		}
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
		const { level, ...access } = accessInfo(member, state.access);
		if (!level) return null;
		const reach = pageReach(ctx, member);
		const ancestors = [];
		for (const [i, a] of state.ancestors.entries()) {
			const at = await reach(a);
			const above = state.ancestors[i + 1];
			if (at) ancestors.unshift(pageRow(a, member, at, !above || !!(await reach(above))));
		}
		// In Archive with an ancestor they can't see: say it's archived without naming or offering what holds it.
		const trashPage = state.trashPage && state.trashPage._id !== page._id && !(await reach(state.trashPage)) ? null : (state.trashPage ?? page);
		return {
			_id: page._id,
			kind: kindOf(page),
			title: page.title,
			archived: state.archived,
			// A parent they can't see stays unnamed and unlinked: the page reads as top-level to them.
			parentId: state.ancestors[0] && (await reach(state.ancestors[0])) ? state.ancestors[0]._id : null,
			ancestors,
			recordId: page.recordId ?? null,
			canEdit: await canEdit(ctx, member, page),
			trash: trashPage && (await trashInfo(ctx, member, trashPage._id)),
			...access,
			/** Its own list, or null when it follows its parent's (a record's page always follows its database). */
			ownAccess: page.access ? access.access : null,
			/** Who can access can be changed here: `pages.edit` and Edit in it, standalone pages only. */
			canManageAccess: !page.recordId && can(member, "pages.edit") && level === "edit",
		};
	},
});

/** A record's body: its page id, or null before anyone writes in it. */
export const forRecord = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		const page = member && (await pageOfRecord(ctx, member.workspaceId, recordId));
		return member && page && (await pageVisible(ctx, member)(page)) ? page._id : null;
	},
});

/** A standalone page or folder (`kind`), or a record's body (its existing one, if any). */
export const create = mutation({
	args: { title: v.optional(v.string()), recordId: v.optional(v.id("records")), parentId: v.optional(v.id("pages")), insertInParent: v.optional(v.boolean()), kind: v.optional(v.literal("folder")) },
	handler: async (ctx, { title, recordId, parentId, insertInParent, kind }) => {
		if (recordId && (parentId || kind)) throw new ConvexError("Record bodies can't be nested.");
		const who = { member: await requireMember(ctx) };
		return createPage(ctx, who, recordId ? { recordId } : { title: title ?? "", parentId, insertInParent, kind });
	},
});

/** A paged level of the tree, pages and folders together (`kind`); the sidebar and Move dialog share it. Files are driveFiles.children. */
export const children = query({
	args: { parentId: v.optional(v.id("pages")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { parentId, paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return emptyPage();
		const reach = pageReach(ctx, member);
		if (parentId) {
			const parent = await ctx.db.get(parentId);
			if (parent?.workspaceId !== member.workspaceId || parent.recordId || (await pageState(ctx, parent)).archived || !(await reach(parent))) return emptyPage();
		}
		const result = await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", parentId).eq("recordId", undefined).eq("archived", false))
			.paginate(capped(paginationOpts, 50));
		const page = [];
		// Pages kept from them are left out; a page can come back short.
		for (const p of result.page) {
			const level = await reach(p);
			if (level) page.push({ ...pageRow(p, member, level), hasChildren: await hasChildren(ctx, p) });
		}
		return { ...result, page };
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
		const reach = pageReach(ctx, member);
		const rows = [];
		let read = 0;
		for await (const p of ctx.db.query("pages").withSearchIndex("search_title", (q) => q.search("title", text).eq("workspaceId", member.workspaceId).eq("archived", false))) {
			if (++read > 200) break;
			const level = !p.recordId && (await reach(p));
			if (!level) continue;
			const { archived, ancestors } = await state(p);
			const path = [];
			for (const a of ancestors.slice().reverse()) if (await reach(a)) path.push(a.title);
			if (!archived) rows.push({ ...pageRow(p, member, level, !ancestors[0] || !!(await reach(ancestors[0]))), path });
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
		const seen = pageVisible(ctx, member);
		const live = [];
		for (const value of ids) {
			const id = ctx.db.normalizeId("pages", value);
			const page = id && await ctx.db.get(id);
			if (page && page.workspaceId === member.workspaceId && !page.recordId && !(await state(page)).archived && (await seen(page))) live.push(value);
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
		if (!member || page?.workspaceId !== member.workspaceId || !(await pageVisible(ctx, member)(page))) return emptyPage();
		const result = await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", pageId)).order("desc")
			.paginate(capped(paginationOpts, 20));
		const seen = pageVisible(ctx, member);
		// Each place by what this person can see: a page they can't see isn't named.
		const place = async (id: Id<"pages"> | null | undefined) => {
			if (id === null) return "Pages";
			const at = id && (await ctx.db.get(id));
			if (!at || at.workspaceId !== member.workspaceId) return "another page";
			return (await seen(at)) ? at.title : "a page you can't see";
		};
		return {
			...result,
			page: await Promise.all(
				result.page.map(async (r) => ({
					_id: r._id,
					_creationTime: r._creationTime,
					from: await place(r.fromId),
					to: await place(r.toId),
					user: await nameOf(ctx, r.userId),
					agent: r.agentId ? ((await ctx.db.get(r.agentId))?.name ?? "An agent") : null,
				})),
			),
		};
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

/**
 * Who can access a standalone page or folder and the sub-pages, folders and files that follow it: Everyone or
 * roles, each at View or Edit, or `null` to follow its parent's again. People with `pages.edit` and Edit in
 * it choose. A record's page follows its database.
 */
export const setAccess = mutation({
	args: { pageId: v.id("pages"), access: v.union(accessArg, v.null()) },
	handler: async (ctx, { pageId, access }) => {
		const member = await requireMember(ctx);
		const page = await requirePage(ctx, member, pageId);
		if (page.recordId) throw new ConvexError("A record's page follows its database. Change who can access the database instead.");
		await requireEditable(ctx, member, page);
		const next = access ? await savedAccess(ctx, member, access) : undefined;
		const inherited = page.parentId ? (await pageState(ctx, (await ctx.db.get(page.parentId))!)).access : undefined;
		requireKeepsEdit(member, "page", next ?? inherited);
		// A child following this list can retain facts from another source too. Check before widening.
		const queue = [page];
		let scanned = 0;
		for (let i = 0; i < queue.length; i++) {
			const row = queue[i]!;
			await changeAccessSources(ctx, member, row, { access: next ?? inherited });
			const children = await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", row._id)).take(AUDIENCE_SCAN_MAX - scanned + 1);
			scanned += children.length;
			if (scanned > AUDIENCE_SCAN_MAX) throw new ConvexError("Change access on smaller branches first.");
			queue.push(...children.filter((p) => !p.access));
			if (kindOf(row) !== "folder") continue;
			const files = await ctx.db.query("driveFiles").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", row._id)).take(AUDIENCE_SCAN_MAX - scanned + 1);
			scanned += files.length;
			if (scanned > AUDIENCE_SCAN_MAX) throw new ConvexError("Change access on smaller branches first.");
			for (const f of files) if (!f.access) await changeAccessSources(ctx, member, f, { access: next ?? inherited });
		}
		await ctx.db.patch(page._id, { access: next });
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
		if (!member || page?.workspaceId !== member.workspaceId || !(await pageVisible(ctx, member)(page))) return emptyPage();
		return pageHistory(ctx, page._id, paginationOpts);
	},
});

export async function requireVersion(ctx: QueryCtx, member: Member, versionId: Id<"pageVersions">) {
	const row = await ctx.db.get(versionId);
	const page = row && (await ctx.db.get(row.pageId));
	if (!row || page?.workspaceId !== member.workspaceId) throw new ConvexError("Version not found.");
	await requirePage(ctx, member, page._id);
	return { row, page };
}

/** One version's content (ProseMirror JSON), to show it. Null once it's gone. */
export const version = query({
	args: { versionId: v.id("pageVersions") },
	handler: async (ctx, { versionId }) => {
		const member = await requireMember(ctx);
		const { row, page } = await requireVersion(ctx, member, versionId);
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

/** A version's content, without the page titles old versions stored (pageBlocks.ts). Null once it's gone. */
export async function versionContent(ctx: QueryCtx, page: Doc<"pages">, row: Doc<"pageVersions">) {
	const snapshot = await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: page._id, version: row.version });
	return snapshot.content !== null && snapshot.version === row.version ? withoutPageTitles(snapshot.content) : null;
}
