import type { PageFindInput, PageWriteInput } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { type Member, asToolResult, nameOf } from "./lib";
import {
	createPage,
	pageOfRecord,
	readDoc,
	renamePage,
	requirePage,
	restoreVersion,
	setPageArchived,
	writeBlocks,
} from "./pageOps";
import { requireRecord } from "./recordOps";
import { runningTurn } from "./turns";

// Pages tools (core's PageStore), acting as the turn's person through runningTurn, like
// records: their role is read fresh each call, and every write is a version naming them and
// the agent. Markdown is converted before and after, in Node (pageMarkdown.ts). See wiki/pages.md.

const FIND_MAX = 50;
const SEARCH_MAX = 20;
/** Versions pages_read lists, with ids `restore` takes. */
const VERSIONS_SHOWN = 5;

/** A page by id, else a live page titled exactly `name`. */
async function pageNamed(ctx: QueryCtx, member: Member, name: string) {
	const id = ctx.db.normalizeId("pages", name);
	if (id) return requirePage(ctx, member, id);
	const rows = await ctx.db
		.query("pages")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", false).eq("title", name.trim()))
		.take(2);
	if (rows.length > 1) throw new ConvexError(`Several pages are titled “${name}”. Find them with pages_find and use an id.`);
	if (!rows[0]) throw new ConvexError(`No page titled “${name}”. Find it with pages_find, or use its id.`);
	return rows[0];
}

const recordNamed = (ctx: QueryCtx, member: Member, id: string) => {
	const recordId = ctx.db.normalizeId("records", id);
	if (!recordId) throw new ConvexError("Record not found. Use its id, from records_find.");
	return requireRecord(ctx, member, recordId);
};

/** What the page is called: its title, or its record's name. */
const titleOf = async (ctx: QueryCtx, page: Doc<"pages">) => (page.recordId ? ((await ctx.db.get(page.recordId))?.title ?? "") : page.title);

export const findFor = internalQuery({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member } = await runningTurn(ctx, turnId);
		const { search, cursor } = input as PageFindInput;
		const row = (p: Doc<"pages">) => ({ id: p._id, title: p.title, edited: new Date(p.updatedAt).toISOString() });
		if (search?.trim()) {
			const found = await ctx.db
				.query("pages")
				.withSearchIndex("search_title", (q) => q.search("title", search).eq("workspaceId", member.workspaceId).eq("archived", false))
				.take(SEARCH_MAX);
			return { rows: found.map(row), more: false };
		}
		const page = await ctx.db
			.query("pages")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", false))
			.paginate({ numItems: FIND_MAX, cursor: cursor ?? null });
		return { rows: page.page.map(row), more: !page.isDone, ...(!page.isDone && { cursor: page.continueCursor }) };
	},
});

export const readFor = internalQuery({
	args: { turnId: v.id("agentTurns"), page: v.optional(v.string()), record: v.optional(v.string()) },
	handler: async (ctx, { turnId, page: name, record: recordName }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const record = recordName ? await recordNamed(ctx, member, recordName) : null;
			const page = record ? await pageOfRecord(ctx, member.workspaceId, record._id) : name ? await pageNamed(ctx, member, name) : null;
			if (!record && !page) throw new ConvexError("Say which page (page) or record (record) to read.");
			const versions = page
				? await ctx.db
						.query("pageVersions")
						.withIndex("by_page", (q) => q.eq("pageId", page._id))
						.order("desc")
						.take(VERSIONS_SHOWN)
				: [];
			return {
				...(page && { id: page._id }),
				title: page ? await titleOf(ctx, page) : record!.title,
				...(record && { record: record._id }),
				...(page?.archived && { archived: true }),
				// A record nobody has written in yet has no page: it reads as empty.
				doc: page ? JSON.stringify((await readDoc(ctx, page._id)).toJSON()) : null,
				versions: await Promise.all(
					versions.map(async (row) => ({
						version: row._id,
						time: new Date(row.editedAt).toISOString(),
						by: await nameOf(ctx, row.userId),
						...(row.agentId && { agent: (await ctx.db.get(row.agentId))?.name ?? "an agent" }),
					})),
				),
			};
		});
	},
});

export const writeFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any(), blocks: v.optional(v.string()) },
	handler: async (ctx, { turnId, input, blocks }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { page: name, record, title, markdown, mode = "append", archived, restore } = input as PageWriteInput;
		return asToolResult(async () => {
			const changes = [title, markdown, archived, restore].filter((x) => x !== undefined).length;
			if ((archived !== undefined || restore) && changes > 1) throw new ConvexError("Archive, restore or bring back a version on its own.");
			let page: Doc<"pages">;
			if (restore) {
				const versionId = ctx.db.normalizeId("pageVersions", restore);
				const row = versionId && (await ctx.db.get(versionId));
				if (!row) throw new ConvexError("Version not found. Use a version id from pages_read.");
				page = await requirePage(ctx, member, row.pageId);
				await restoreVersion(ctx, who, page, row);
				return { id: page._id, title: await titleOf(ctx, page), restored: row._id };
			}
			if (record) page = (await ctx.db.get(await createPage(ctx, who, { recordId: (await recordNamed(ctx, member, record))._id })))!;
			else if (name) page = await pageNamed(ctx, member, name);
			else {
				if (!title) throw new ConvexError("Give the new page a title.");
				page = (await ctx.db.get(await createPage(ctx, who, { title })))!;
			}
			if (archived !== undefined) await setPageArchived(ctx, who, page, archived);
			if (title !== undefined && (name || record)) await renamePage(ctx, who, page, title);
			const wrote = blocks !== undefined && (await writeBlocks(ctx, who, page, blocks, mode));
			const after = (await ctx.db.get(page._id))!;
			return { id: page._id, title: await titleOf(ctx, after), ...(markdown !== undefined && !wrote && { unchanged: true }) };
		});
	},
});
