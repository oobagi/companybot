import { BlockNoteEditor } from "@blocknote/core";
import { can, deniedMessage } from "@companybot/core";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { Node, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, requireInWorkspace } from "./lib";
import { requireRecord } from "./recordOps";

// Pages: standalone docs and record bodies, one concept. Content lives in the prosemirrorSync
// component (snapshots and steps, keyed by the page's id); history is `pageVersions`, each
// pointing at one of its snapshots. The app (pages.ts, pageSync.ts) and agents (pageTools.ts)
// both go through here with a `Who`, like records. See wiki/pages.md.

export const sync = new ProsemirrorSync<Id<"pages">>(components.prosemirrorSync);
const lib = components.prosemirrorSync.lib;

/** Longest a page's content can be, as JSON: well under Convex's 1 MiB per document. */
export const PAGE_MAX_BYTES = 500_000;
/** Versions kept per page; older ones go, with their snapshots. */
export const PAGE_VERSIONS_MAX = 100;
const TITLE_MAX = 200;
/** Like Notion: one author's run of edits stays one version until it pauses for 2 minutes, or runs 10. */
export const IDLE_MS = 2 * 60_000;
export const VERSION_MS = 10 * 60_000;
/** Steps behind the latest snapshot are kept this long, so a client that was briefly offline can catch up. */
const STEPS_KEEP_MS = 24 * 60 * 60_000;

let schema: Schema | undefined;
/** BlockNote's ProseMirror schema, as the app's editor has it. Needs no DOM. */
export const pageSchema = () => (schema ??= BlockNoteEditor.create({ _headless: true }).pmSchema);

/** An empty block, as BlockNote keeps at the end of every page. */
const emptyBlock = () => ({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph" }] });

export async function requirePage(ctx: QueryCtx, member: Member, pageId: Id<"pages">) {
	return requireInWorkspace(member, await ctx.db.get(pageId), "Page");
}

/** A record's body, if it has one yet. */
export const pageOfRecord = (ctx: QueryCtx, workspaceId: Id<"workspaces">, recordId: Id<"records">) =>
	ctx.db
		.query("pages")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("recordId", recordId))
		.first();

/** Every member reads every page; `pages.edit` changes them, unless the page or its record is archived. */
export async function requireEditable(ctx: QueryCtx, member: Member, page: Doc<"pages">) {
	if (!can(member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
	if (page.archived) throw new ConvexError("This page is archived. Restore it to make changes.");
	if (page.recordId && (await ctx.db.get(page.recordId))?.archived) throw new ConvexError("This record is archived. Restore it to make changes.");
}

function cleanTitle(title: string) {
	const clean = title.replace(/\s+/g, " ").trim();
	if (!clean) throw new ConvexError("Give the page a title.");
	if (clean.length > TITLE_MAX) throw new ConvexError(`Keep titles under ${TITLE_MAX} characters.`);
	return clean;
}

/** A standalone page, or a record's body (returned if it already has one). Starts empty. */
export async function createPage(ctx: MutationCtx, { member }: Who, to: { title: string } | { recordId: Id<"records"> }) {
	if (!can(member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
	let recordId: Id<"records"> | undefined;
	if ("recordId" in to) {
		const record = await requireRecord(ctx, member, to.recordId);
		const existing = await pageOfRecord(ctx, member.workspaceId, record._id);
		if (existing) return existing._id;
		if (record.archived) throw new ConvexError("This record is archived. Restore it to make changes.");
		recordId = record._id;
	}
	const pageId = await ctx.db.insert("pages", {
		workspaceId: member.workspaceId,
		...(recordId && { recordId }),
		title: "title" in to ? cleanTitle(to.title) : "",
		archived: false,
		createdBy: member.userId,
		updatedAt: Date.now(),
		updatedBy: member.userId,
	});
	await sync.create(ctx, pageId, { type: "doc", content: [{ type: "blockGroup", content: [emptyBlock()] }] });
	return pageId;
}

export async function renamePage(ctx: MutationCtx, { member }: Who, page: Doc<"pages">, title: string) {
	await requireEditable(ctx, member, page);
	if (page.recordId) throw new ConvexError("A record's page takes the record's name. Rename the record instead.");
	await ctx.db.patch(page._id, { title: cleanTitle(title), updatedAt: Date.now(), updatedBy: member.userId });
}

export async function setPageArchived(ctx: MutationCtx, { member }: Who, page: Doc<"pages">, archived: boolean) {
	if (!can(member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
	if (page.recordId) throw new ConvexError("A record's page is archived with its record.");
	await ctx.db.patch(page._id, { archived, updatedAt: Date.now(), updatedBy: member.userId });
}

export const latestVersionOf = (ctx: QueryCtx, pageId: Id<"pages">) =>
	ctx.db
		.query("pageVersions")
		.withIndex("by_page", (q) => q.eq("pageId", pageId))
		.order("desc")
		.first();

/** Deletes the component's snapshot at exactly `version`. */
const dropSnapshot = (ctx: MutationCtx, pageId: Id<"pages">, version: number) =>
	ctx.runMutation(lib.deleteSnapshots, { id: pageId, afterVersion: version - 1, beforeVersion: version + 1 });

/**
 * Logs that `who` brought the page to `version`, once the component has a snapshot there. The
 * author's open version grows (its old snapshot goes), or a new one starts; past
 * PAGE_VERSIONS_MAX the oldest goes. A restore always starts its own.
 */
export async function recordVersion(ctx: MutationCtx, who: Who, page: Doc<"pages">, version: number, restored?: number) {
	const now = Date.now();
	const latest = await latestVersionOf(ctx, page._id);
	if (
		latest &&
		!restored &&
		!latest.restored &&
		latest.userId === who.member.userId &&
		latest.agentId === who.agentId &&
		now - latest.editedAt < IDLE_MS &&
		now - latest._creationTime < VERSION_MS
	) {
		await dropSnapshot(ctx, page._id, latest.version);
		await ctx.db.patch(latest._id, { version, editedAt: now });
		return;
	}
	const n = (latest?.n ?? 0) + 1;
	await ctx.db.insert("pageVersions", {
		pageId: page._id,
		n,
		version,
		userId: who.member.userId,
		...(who.agentId && { agentId: who.agentId }),
		editedAt: now,
		...(restored && { restored }),
	});
	const oldest = ctx.db.query("pageVersions").withIndex("by_page", (q) => q.eq("pageId", page._id).lte("n", n - PAGE_VERSIONS_MAX));
	for (const old of await oldest.take(2)) {
		await dropSnapshot(ctx, page._id, old.version);
		await ctx.db.delete(old._id);
	}
	await ctx.runMutation(lib.deleteSteps, { id: page._id, beforeTs: now - STEPS_KEEP_MS });
	await ctx.db.patch(page._id, { updatedAt: now, updatedBy: who.member.userId });
}

/** The page's content now. */
export async function readDoc(ctx: QueryCtx, pageId: Id<"pages">) {
	// getDoc only reads; its type asks for a mutation ctx.
	return (await sync.getDoc(ctx as unknown as MutationCtx, pageId, pageSchema())).doc;
}

/**
 * Changes a page's content as `who` and logs it as a version, like an edit in the editor.
 * `change` gets the content now and returns the change (it may run again if the page moved).
 * Returns false if nothing changed.
 */
export async function writeDoc(ctx: MutationCtx, who: Who, page: Doc<"pages">, change: (doc: Node) => Transform, restored?: number) {
	await requireEditable(ctx, who.member, page);
	let changed = false;
	await sync.transform(ctx, page._id, pageSchema(), (doc) => {
		const tr = change(doc);
		changed = tr.docChanged;
		if (!changed) return null;
		if (JSON.stringify(tr.doc.toJSON()).length > PAGE_MAX_BYTES) throw new ConvexError("That would make the page too long. Split it into several pages.");
		return tr;
	});
	if (!changed) return false;
	const version = (await ctx.runQuery(lib.latestVersion, { id: page._id }))!;
	await recordVersion(ctx, who, page, version, restored);
	return true;
}

/** Replaces the content, or adds to its end, with blocks (a JSON array, as pageMarkdown.ts makes). */
export function writeBlocks(ctx: MutationCtx, who: Who, page: Doc<"pages">, json: string, mode: "replace" | "append") {
	const schema = pageSchema();
	const blocks = JSON.parse(json) as object[];
	return writeDoc(ctx, who, page, (doc) => {
		const tr = new Transform(doc);
		const group = doc.firstChild!;
		if (mode === "replace") {
			const next = schema.nodeFromJSON({ type: "doc", content: [{ type: "blockGroup", content: [...blocks, emptyBlock()] }] });
			return tr.replaceWith(0, doc.content.size, next.content);
		}
		// Before the empty block BlockNote keeps at the end, if it's there.
		const last = group.lastChild!;
		const end = doc.content.size - 1 - (last.textContent === "" && last.childCount === 1 ? last.nodeSize : 0);
		return blocks.length ? tr.insert(end, blocks.map((b) => schema.nodeFromJSON(b))) : tr;
	});
}

/** Puts a version's content back, as a new version: nothing is lost. */
export async function restoreVersion(ctx: MutationCtx, who: Who, page: Doc<"pages">, row: Doc<"pageVersions">) {
	const snapshot = await ctx.runQuery(lib.getSnapshot, { id: page._id, version: row.version });
	if (snapshot.content === null || snapshot.version !== row.version) throw new ConvexError("This version is no longer available.");
	const old = pageSchema().nodeFromJSON(JSON.parse(snapshot.content));
	return writeDoc(ctx, who, page, (doc) => new Transform(doc).replaceWith(0, doc.content.size, old.content), row.editedAt);
}
