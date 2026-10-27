import { BlockNoteEditor } from "@blocknote/core";
import { can, deniedMessage } from "@companybot/core";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { Node, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { ConvexError, getDocumentSize } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, nameOf, requireInWorkspace } from "./lib";
import { startCascade } from "./cascade";
import { inTrash, requireRecord } from "./recordOps";
import { putInTrash, takeFromTrash } from "./trashOps";

// Shared rules for standalone pages and record bodies. See wiki/pages.md.

export const sync = new ProsemirrorSync<Id<"pages">>(components.prosemirrorSync);
const lib = components.prosemirrorSync.lib;

/** Longest a page's content can be, as JSON: well under Convex's 1 MiB per document. */
export const PAGE_MAX_BYTES = 500_000;
/**
 * Largest delta (batch of steps) stored. The component reads up to 100 at once, and cleaning up reads
 * each twice (a delete reads too): 12 MB, under Convex's 16 MiB with room for a few snapshots.
 */
export const DELTA_MAX_BYTES = 60_000;
/** Versions kept per page; older ones go, with their snapshots. */
export const PAGE_VERSIONS_MAX = 100;
const TITLE_MAX = 200;
/** Like Notion: a run of edits stays one version until the page rests for 2 minutes, or it runs 10. */
export const IDLE_MS = 2 * 60_000;
export const VERSION_MS = 10 * 60_000;
/** Others credited on one version, besides whoever started it. */
const OTHERS_MAX = 10;
/** Steps behind the latest snapshot are kept this long, so a client that was briefly offline can catch up. */
const STEPS_KEEP_MS = 24 * 60 * 60_000;

let schema: Schema | undefined;
/** BlockNote's ProseMirror schema, as the app's editor has it. An unmounted editor needs no DOM. */
export const pageSchema = () => (schema ??= BlockNoteEditor.create().pmSchema);

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

/** Every member reads every page; `pages.edit` changes them, unless the page or its record is in Trash. */
export async function requireEditable(ctx: QueryCtx, member: Member, page: Doc<"pages">) {
	if (!can(member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
	if (page.archived) throw new ConvexError("This page is in Trash. Restore it to make changes.");
	if (page.recordId && (await inTrash(ctx, await requireRecord(ctx, member, page.recordId)))) throw new ConvexError("This record is in Trash. Restore it to make changes.");
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
		if (await inTrash(ctx, record)) throw new ConvexError("This record is in Trash. Restore it to make changes.");
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

/** Moves a standalone page to Trash or back. A record's page goes with its record. */
export async function setPageTrashed(ctx: MutationCtx, who: Who, page: Doc<"pages">, archived: boolean) {
	if (!can(who.member.role, "pages.edit")) throw new ConvexError(deniedMessage("pages.edit"));
	if (page.recordId) throw new ConvexError("A record's page goes to Trash with its record.");
	if (page.archived === archived) return;
	if (archived) await putInTrash(ctx, who, { kind: "page", id: page._id, name: page.title });
	else await takeFromTrash(ctx, who, page._id);
	await ctx.db.patch(page._id, { archived, updatedAt: Date.now(), updatedBy: who.member.userId });
}

/** Deletes a page for good: its row at once, then its content (a little at a time) and its versions. */
export async function deletePage(ctx: MutationCtx, pageId: Id<"pages">) {
	await ctx.db.delete(pageId);
	await ctx.scheduler.runAfter(0, internal.pageSync.deleteDoc, { id: pageId });
	await startCascade(ctx, "page", { pageId });
}

export const latestVersionOf = (ctx: QueryCtx, pageId: Id<"pages">) =>
	ctx.db
		.query("pageVersions")
		.withIndex("by_page", (q) => q.eq("pageId", pageId))
		.order("desc")
		.first();

/** A version's editors by name: whoever started it, then anyone who edited meanwhile. */
export const editorsOf = (ctx: QueryCtx, row: Doc<"pageVersions">) =>
	Promise.all(
		[row, ...(row.others ?? [])].map(async (e) => ({ user: await nameOf(ctx, e.userId), agent: e.agentId ? ((await ctx.db.get(e.agentId))?.name ?? "An agent") : null })),
	);

/** Deletes the component's snapshot at exactly `version`. */
const dropSnapshot = (ctx: MutationCtx, pageId: Id<"pages">, version: number) =>
	ctx.runMutation(lib.deleteSnapshots, { id: pageId, afterVersion: version - 1, beforeVersion: version + 1 });

/** Group continuous edits, everyone's who edits meanwhile; restores start a new version. Prune history and snapshots together. */
export async function recordVersion(ctx: MutationCtx, who: Who, page: Doc<"pages">, version: number, restored?: number) {
	const now = Date.now();
	await ctx.db.patch(page._id, { updatedAt: now, updatedBy: who.member.userId });
	const latest = await latestVersionOf(ctx, page._id);
	if (latest && !restored && !latest.restored && now - latest.editedAt < IDLE_MS && now - latest._creationTime < VERSION_MS) {
		const editor = { userId: who.member.userId, ...(who.agentId && { agentId: who.agentId }) };
		const same = (e: { userId: Id<"users">; agentId?: Id<"agents"> }) => e.userId === editor.userId && e.agentId === editor.agentId;
		const others = latest.others ?? [];
		await dropSnapshot(ctx, page._id, latest.version);
		await ctx.db.patch(latest._id, { version, editedAt: now, ...(!same(latest) && !others.some(same) && others.length < OTHERS_MAX && { others: [...others, editor] }) });
		return;
	}
	await ctx.runMutation(lib.deleteSteps, { id: page._id, beforeTs: now - STEPS_KEEP_MS });
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
}

/** The page's content now. */
export async function readDoc(ctx: QueryCtx, pageId: Id<"pages">) {
	// getDoc only reads; its type asks for a mutation ctx.
	return (await sync.getDoc(ctx as unknown as MutationCtx, pageId, pageSchema())).doc;
}

const tooMuch = () => new ConvexError("That's too much to add at once. Split it into smaller pieces.");

/** Validate and save steps (in deltas of at most DELTA_MAX_BYTES), their canonical snapshot and history in one transaction. */
export async function saveTransform(ctx: MutationCtx, who: Who, page: Doc<"pages">, version: number, tr: Transform, clientId: string | number = "transform", restored?: number) {
	if (!tr.docChanged || tr.doc.eq(tr.before)) return false;
	const content = JSON.stringify(tr.doc.toJSON());
	const steps = tr.steps.map((s) => JSON.stringify(s.toJSON()));
	const bytes = getDocumentSize({ content });
	if (bytes > PAGE_MAX_BYTES || getDocumentSize({ steps }) > PAGE_MAX_BYTES)
		throw new ConvexError("That would make the page too long. Split it into several pages.");
	// Every block fits a delta on its own, so any version can be put back a block at a time.
	if (bytes > DELTA_MAX_BYTES)
		tr.doc.firstChild!.forEach((block) => {
			if (getDocumentSize({ block: JSON.stringify(block.toJSON()) }) > DELTA_MAX_BYTES - 1_000) throw tooMuch();
		});
	let at = version;
	let batch: string[] = [];
	let size = 0;
	const flush = async () => {
		await ctx.runMutation(lib.submitSteps, { id: page._id, version: at, clientId, steps: batch });
		at += batch.length;
		[batch, size] = [[], 0];
	};
	for (const step of steps) {
		const bytes = getDocumentSize({ step });
		if (bytes > DELTA_MAX_BYTES) throw tooMuch();
		if (size + bytes > DELTA_MAX_BYTES) await flush();
		batch.push(step);
		size += bytes;
	}
	await flush();
	await ctx.runMutation(lib.submitSnapshot, { id: page._id, version: at, content });
	await recordVersion(ctx, who, page, at, restored);
	return true;
}

/** Inserts blocks at `pos`, a step each so each fits a delta. Returns where they end. */
function insertBlocks(tr: Transform, pos: number, blocks: readonly Node[]) {
	for (const block of blocks) {
		tr.insert(pos, block);
		pos += block.nodeSize;
	}
	return pos;
}

/** Puts `blocks` in place of the page's: in front of them, then the old ones go. */
function replaceBlocks(doc: Node, blocks: readonly Node[]) {
	const tr = new Transform(doc);
	const end = insertBlocks(tr, 1, blocks);
	return tr.delete(end, tr.doc.content.size - 1);
}

export async function writeDoc(ctx: MutationCtx, who: Who, page: Doc<"pages">, change: (doc: Node) => Transform, restored?: number) {
	await requireEditable(ctx, who.member, page);
	const { doc, version } = await sync.getDoc(ctx, page._id, pageSchema());
	return saveTransform(ctx, who, page, version, change(doc), "transform", restored);
}

/** Replaces the content, or adds to its end, with blocks (a JSON array, as pageMarkdown.ts makes). */
export function writeBlocks(ctx: MutationCtx, who: Who, page: Doc<"pages">, json: string, mode: "replace" | "append") {
	const schema = pageSchema();
	const raw: unknown = JSON.parse(json);
	if (!Array.isArray(raw)) throw new ConvexError("Use a JSON array of page blocks.");
	const blocks = raw.map((b) => schema.nodeFromJSON(b));
	for (const block of blocks) {
		if (block.type.name !== "blockContainer") throw new ConvexError("Use blockContainer nodes from pages_read.");
		block.check();
	}
	return writeDoc(ctx, who, page, (doc) => {
		if (mode === "replace") {
			const last = blocks.at(-1)?.firstChild;
			return replaceBlocks(doc, last?.type.name === "paragraph" && last.content.size === 0 ? blocks : [...blocks, schema.nodeFromJSON(emptyBlock())]);
		}
		// Before the empty block BlockNote keeps at the end, if it's there.
		const last = doc.firstChild!.lastChild!;
		const tr = new Transform(doc);
		insertBlocks(tr, doc.content.size - 1 - (last.textContent === "" && last.childCount === 1 ? last.nodeSize : 0), blocks);
		return tr;
	});
}

/** Puts a version's content back, as a new version: nothing is lost. */
export async function restoreVersion(ctx: MutationCtx, who: Who, page: Doc<"pages">, row: Doc<"pageVersions">) {
	const snapshot = await ctx.runQuery(lib.getSnapshot, { id: page._id, version: row.version });
	if (snapshot.content === null || snapshot.version !== row.version) throw new ConvexError("This version is no longer available.");
	const old = pageSchema().nodeFromJSON(JSON.parse(snapshot.content));
	return writeDoc(ctx, who, page, (doc) => replaceBlocks(doc, old.firstChild!.content.content), row.editedAt);
}
