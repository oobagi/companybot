import { findInput, readInput, writeInput } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { type Member, asToolResult } from "./lib";
import {
	createPage,
	pageOfRecord,
	readDoc,
	renamePage,
	requirePage,
	restoreVersion,
	setPageTrashed,
	writeBlocks,
} from "./pageOps";
import { movePage, pageState, pageStates } from "./pageTree";
import { inTrash, recordById } from "./recordOps";
import { pageHistory, requireVersion, versionContent } from "./pages";
import { runningTurn } from "./turns";

// PageStore as the turn's person; conversion runs separately in pageMarkdown.ts.

const FIND_MAX = 50;
const SEARCH_MAX = 20;
/** Versions pages_read lists, with ids `restore` takes. */
const VERSIONS_SHOWN = 5;

/** A page by id, else a page titled exactly `name`: a live one, or one in Trash (to restore it). */
async function pageNamed(ctx: QueryCtx, member: Member, name: string, trashed = false) {
	const id = ctx.db.normalizeId("pages", name);
	if (id) return requirePage(ctx, member, id);
	const candidates = await ctx.db
		.query("pages")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", trashed).eq("title", name.trim()))
		.take(FIND_MAX + 1);
	const state = pageStates(ctx);
	const rows = [];
	for (const p of candidates) if ((await state(p)).archived === trashed) rows.push(p);
	if (candidates.length > FIND_MAX || rows.length > 1) throw new ConvexError(`Several pages are titled “${name}”. Find them with pages_find and use an id.`);
	if (!rows[0]) throw new ConvexError(`No page titled “${name}”. Find it with pages_find, or use its id.`);
	return rows[0];
}

const recordNamed = (ctx: QueryCtx, member: Member, id: string) => recordById(ctx, member, id, "Record not found. Use its id, from records_find.");

/** What the page is called: its title, or its record's name. */
const titleOf = async (ctx: QueryCtx, page: Doc<"pages">) => (page.recordId ? ((await ctx.db.get(page.recordId))?.title ?? "") : page.title);

export const findFor = internalQuery({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member } = await runningTurn(ctx, turnId);
		const { search, cursor, trashed = false, parent } = findInput.parse(input);
		const parentPage = parent ? await pageNamed(ctx, member, parent) : null;
		if (parentPage?.recordId) throw new ConvexError("Record bodies can't contain sub-pages.");
		const row = (p: Doc<"pages">) => ({ id: p._id, title: p.title, parentId: p.parentId ?? null, edited: new Date(p.updatedAt).toISOString() });
		const pages = ctx.db.query("pages");
		const found = parent !== undefined
			? pages.withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", parentPage?._id))
			: search?.trim()
			? pages.withSearchIndex("search_title", (q) => q.search("title", search).eq("workspaceId", member.workspaceId).eq("archived", trashed))
			: pages.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", trashed));
		const page = await found.paginate({ numItems: search?.trim() ? SEARCH_MAX : FIND_MAX, cursor: cursor ?? null });
		const state = pageStates(ctx);
		const rows = [];
		for (const p of page.page) if (!p.recordId && (await state(p)).archived === trashed) rows.push(row(p));
		return { rows, more: !page.isDone, ...(!page.isDone && { cursor: page.continueCursor }) };
	},
});

export const readFor = internalQuery({
	args: { turnId: v.id("agentTurns"), page: v.optional(v.string()), record: v.optional(v.string()), version: v.optional(v.string()), history: v.optional(v.boolean()), cursor: v.optional(v.string()), format: v.optional(v.string()) },
	handler: async (ctx, { turnId, ...input }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const { page: name, record: recordName, version, history, cursor } = readInput.parse(input);
			const oldId = version && ctx.db.normalizeId("pageVersions", version);
			if (version && !oldId) throw new ConvexError("Version not found.");
			const old = oldId ? await requireVersion(ctx, member, oldId) : null;
			const record = recordName ? await recordNamed(ctx, member, recordName) : null;
			const page = old?.page ?? (record ? await pageOfRecord(ctx, member.workspaceId, record._id) : name ? await pageNamed(ctx, member, name) : null);
			if (old && ((record && old.page.recordId !== record._id) || (name && (await pageNamed(ctx, member, name))._id !== old.page._id))) throw new ConvexError("Version belongs to a different page.");
			if (!record && !page) throw new ConvexError("Say which page (page) or record (record) to read.");
			const result = page ? await pageHistory(ctx, page._id, { cursor: history ? cursor ?? null : null, numItems: history ? 20 : VERSIONS_SHOWN }) : null;
			const versions = (result?.page ?? []).map((r) => ({
				version: r._id,
				time: new Date(r.time).toISOString(),
				by: r.user,
				...(r.agent && { agent: r.agent }),
				...(r.others.length > 0 && { others: r.others.map((e) => (e.agent ? `${e.agent}, for ${e.user}` : e.user)) }),
			}));
			if (history) return { title: page ? await titleOf(ctx, page) : record!.title, doc: null, versions, moreVersions: !!result && !result.isDone, ...(result && !result.isDone && { cursor: result.continueCursor }) };
			const state = page ? await pageState(ctx, page) : null;
			const children = page && !page.recordId && !old ? await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", page._id).eq("archived", false)).take(51) : [];
			const doc = old ? await versionContent(ctx, old.page, old.row) : page ? JSON.stringify((await readDoc(ctx, page._id)).toJSON()) : null;
			if (old && doc === null) throw new ConvexError("This version is no longer available.");
			return {
				...(page && { id: page._id, parentId: page.parentId ?? null }),
				ancestors: state?.ancestors.slice().reverse().map((p) => ({ id: p._id, title: p.title })) ?? [],
				subpages: children.slice(0, 50).map((p) => ({ id: p._id, title: p.title })),
				subpagesMore: children.length > 50,
				title: page ? await titleOf(ctx, page) : record!.title,
				...(record && { record: record._id }),
				...((state?.archived || (record && (await inTrash(ctx, record)))) && { inTrash: true }),
				// A record nobody has written in yet has no page: it reads as empty.
				doc,
				versions,
			};
		});
	},
});

const writeArgs = { turnId: v.id("agentTurns"), input: v.any(), blocks: v.optional(v.string()) };

// Catch expected errors outside the write transaction, so a refused edit saves nothing.
export const writeFor = internalMutation({
	args: writeArgs,
	handler: async (ctx, args): Promise<unknown> => asToolResult(() => ctx.runMutation(internal.pageTools.writeChecked, args)),
});

export const writeChecked = internalMutation({
	args: writeArgs,
	handler: async (ctx, { turnId, input, blocks }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { page: name, record, title, markdown, blocks: rich, mode = "append", trash, restore, parent, action = "write" } = writeInput.parse(input);
		if (record && parent !== undefined) throw new ConvexError("Record bodies can't be nested.");
		const parentId = parent ? (await pageNamed(ctx, member, parent))._id : undefined;
		if (action === "move") {
			if (!name || parent === undefined || record || [title, markdown, rich, trash, restore].some((x) => x !== undefined)) throw new ConvexError("Move with page and parent only; parent null means top level.");
			const page = await pageNamed(ctx, member, name);
			await movePage(ctx, who, page, parentId);
			return { id: page._id, title: page.title, parentId: parentId ?? null };
		}
		if (name && parent !== undefined) throw new ConvexError("Use action move to change a page's parent.");
		if (rich !== undefined && markdown !== undefined) throw new ConvexError("Use blocks or markdown, not both.");
		const content = rich ?? blocks;
		const changes = [title, markdown, rich, trash, restore, parent].filter((x) => x !== undefined).length;
		if ((trash !== undefined || restore) && changes > 1) throw new ConvexError("Delete, restore or bring back a version on its own.");
		let page: Doc<"pages">;
		if (restore) {
			const versionId = ctx.db.normalizeId("pageVersions", restore);
			const row = versionId && (await ctx.db.get(versionId));
			if (!row) throw new ConvexError("Version not found. Use a version id from pages_read.");
			page = await requirePage(ctx, member, row.pageId);
			if ((name && (await pageNamed(ctx, member, name))._id !== page._id) || (record && (await recordNamed(ctx, member, record))._id !== page.recordId))
				throw new ConvexError("Version belongs to a different page.");
			await restoreVersion(ctx, who, page, row);
			return { id: page._id, title: await titleOf(ctx, page), restored: row._id };
		}
		if (record) page = (await ctx.db.get(await createPage(ctx, who, { recordId: (await recordNamed(ctx, member, record))._id })))!;
		else if (name) page = await pageNamed(ctx, member, name, trash === false);
		else {
			if (!title) throw new ConvexError("Give the new page a title.");
			page = (await ctx.db.get(await createPage(ctx, who, { title, parentId })))!;
		}
		if (trash !== undefined) await setPageTrashed(ctx, who, page, trash);
		if (title !== undefined && (name || record)) await renamePage(ctx, who, page, title);
		const wrote = content !== undefined && (await writeBlocks(ctx, who, page, content, mode));
		const after = (await ctx.db.get(page._id))!;
		return { id: page._id, title: await titleOf(ctx, after), ...((markdown !== undefined || rich !== undefined) && !wrote && { unchanged: true }) };
	},
});
