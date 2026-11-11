import { BlockNoteEditor } from "@blocknote/core";
import { type AccessLevel, reaches } from "@companybot/core";
import { pageHref } from "@companybot/core/page-links";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";
import type { Node, Schema } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { ConvexError, getDocumentSize } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { cascading, startCascade } from "./cascade";
import { type Member, type Who, checkPermission, nameOf, requireInWorkspace } from "./lib";
import { pageBlockSchema, withoutPageTitles } from "./pageBlocks";
import { type PageState, keptAccess, kindOf, pageState, pageStates, parentFor } from "./pageTree";
import { canAdd, reach, requireAccess } from "./placeAccess";
import { inTrash, madeBy, requireRecord } from "./recordOps";
import { notePlace, readArtifact, writeSources } from "./replySources";
import { toggleTrash } from "./trashOps";

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
export const pageSchema = () => (schema ??= BlockNoteEditor.create({ schema: pageBlockSchema }).pmSchema);

/** An empty block, as BlockNote keeps at the end of every page. */
const emptyBlock = () => ({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph" }] });

/** A page in the person's workspace that they reach `need` in (`requirePageAccess`). */
export async function requirePage(ctx: QueryCtx, member: Member, pageId: Id<"pages">, need: AccessLevel = "view") {
	const page = requireInWorkspace(member, await ctx.db.get(pageId), "Page");
	await requirePageAccess(ctx, member, page, need);
	return page;
}

/**
 * Refuses someone without `need` in a page, naming who has it: a standalone page by the list that
 * rules it (its own or an ancestor's), a record's page by its database's.
 */
export async function requirePageAccess(ctx: QueryCtx, member: Member, page: Doc<"pages">, need: AccessLevel, state?: PageState, asked?: string) {
	const { access, type } = state ?? (await pageState(ctx, page));
	if (!(await readArtifact(ctx, member, type ?? page))) throw new ConvexError(`${kindOf(page) === "folder" ? "Folder" : "Page"} not found.`);
	if (type) {
		// Add: the body of a record they made is theirs to read and write, like its fields. Nobody else's.
		if (!(await ownBody(ctx, member, page, access))) requireAccess(member, "database", type.plural, access, need);
	} else requireAccess(member, kindOf(page), page.title, access, need, asked);
	await notePlace(ctx, member, type?._id ?? page._id, access);
}

/** Whether a record's body is one they reach through Add: its record is one they made. */
async function ownBody(ctx: QueryCtx, member: Member, page: Doc<"pages">, access: PageState["access"]) {
	if (!page.recordId || !canAdd(member, access)) return false;
	const record = await ctx.db.get(page.recordId);
	return !!record && madeBy(record, member);
}

/** How far someone reaches in each page ("edit", "view" or null), sharing reads across a list. */
export function pageReach(ctx: QueryCtx, member: Member, get?: (id: Id<"pages">) => Promise<Doc<"pages"> | null>) {
	const state = pageStates(ctx, get);
	return async (page: Doc<"pages">) => {
		const { access, type } = await state(page);
		if (!(await readArtifact(ctx, { ...member, replyId: undefined }, type ?? page))) return null;
		const level = reach(member, access) ?? (type && (await ownBody(ctx, member, page, access)) ? "edit" : null);
		if (level) await notePlace(ctx, member, type?._id ?? page._id, access);
		return level;
	};
}

/** Whether someone can see a page (`pageReach`). */
export function pageVisible(ctx: QueryCtx, member: Member, get?: (id: Id<"pages">) => Promise<Doc<"pages"> | null>) {
	const level = pageReach(ctx, member, get);
	return async (page: Doc<"pages">) => reaches(await level(page), "view");
}

/**
 * A document's page blocks titled for `member`, for agents (who read JSON, not the app's live blocks): the
 * page's current title, or none for a page they can't see (or one deleted). Blocks store no title (pageBlocks.ts).
 */
export const withPageTitles = (ctx: QueryCtx, member: Member, content: string) => pageTitlesFor(ctx, member.workspaceId, pageVisible(ctx, member), content);

/** `withPageTitles` for any reader: `seen` says which pages they may see (someone outside: publicPlaces.ts). */
export async function pageTitlesFor(ctx: QueryCtx, workspaceId: Id<"workspaces">, seen: (page: Doc<"pages">) => Promise<boolean>, content: string) {
	const titles = new Map<string, string>();
	const titleOf = async (id: unknown) => {
		if (typeof id !== "string") return "";
		if (!titles.has(id)) {
			const pageId = ctx.db.normalizeId("pages", id);
			const page = pageId && (await ctx.db.get(pageId));
			titles.set(id, page && page.workspaceId === workspaceId && (await seen(page)) ? page.title : "");
		}
		return titles.get(id)!;
	};
	type Json = { type?: string; attrs?: Record<string, unknown>; content?: Json[] };
	const walk = async (node: Json) => {
		if (node.type === "page" && node.attrs) node.attrs.title = await titleOf(node.attrs.pageId);
		for (const child of node.content ?? []) await walk(child);
	};
	const doc = JSON.parse(content) as Json;
	await walk(doc);
	return JSON.stringify(doc);
}

/** A record's body, if it has one yet. */
export const pageOfRecord = (ctx: QueryCtx, workspaceId: Id<"workspaces">, recordId: Id<"records">) =>
	ctx.db
		.query("pages")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("recordId", recordId))
		.first();

/**
 * `pages.edit` and Edit in the page (its Who can access list) change it, unless the page, a page above it,
 * or the record it's in is in Archive. Seeing it takes View.
 */
export async function requireEditable(ctx: QueryCtx, member: Member, page: Doc<"pages">) {
	checkPermission(member, "pages.edit");
	const state = await pageState(ctx, page);
	await requirePageAccess(ctx, member, page, "edit", state);
	if (state.archived && state.recordArchived && !state.trashPage) throw new ConvexError(page.recordId ? "This record is in Archive. Restore it to make changes." : "This page's record is in Archive. Restore the record to make changes.");
	if (state.archived) throw new ConvexError(`This ${kindOf(page)} is in Archive. Restore it to make changes.`);
}

export function cleanTitle(title: string, kind: "page" | "folder" | "file" = "page") {
	const clean = title.replace(/\s+/g, " ").trim();
	if (!clean) throw new ConvexError(kind === "page" ? "Give the page a title." : `Give the ${kind} a name.`);
	if (clean.length > TITLE_MAX) throw new ConvexError(`Keep ${kind === "page" ? "titles" : "names"} under ${TITLE_MAX} characters.`);
	return clean;
}

/** A folder has no content: nothing to sync, version or write in. */
export function requireContent(page: Doc<"pages">) {
	if (kindOf(page) === "folder") throw new ConvexError("A folder has no content. Put pages and files in it instead.");
}

/** A standalone page or folder, or a record's body (returned if it already has one). Pages start empty. */
export async function createPage(ctx: MutationCtx, who: Who, to: { title: string; parentId?: Id<"pages">; kind?: "folder" } | { recordId: Id<"records"> }) {
	const { member } = who;
	checkPermission(member, "pages.edit");
	const parentId = "parentId" in to ? to.parentId : undefined;
	const kind = "kind" in to ? to.kind : undefined;
	if (parentId) await parentFor(ctx, member, parentId, kind ?? "page");
	let recordId: Id<"records"> | undefined;
	if ("recordId" in to) {
		const record = await requireRecord(ctx, member, to.recordId, "edit");
		const existing = await pageOfRecord(ctx, member.workspaceId, record._id);
		if (existing) return existing._id;
		if (await inTrash(ctx, record)) throw new ConvexError("This record is in Archive. Restore it to make changes.");
		recordId = record._id;
	}
	const usedPlaces = "title" in to ? await writeSources(ctx, member, parentId) : [];
	const pageId = await ctx.db.insert("pages", {
		usedPlaces,
		workspaceId: member.workspaceId,
		...(recordId && { recordId }),
		...(parentId && { parentId }),
		...(kind && { kind }),
		title: "title" in to ? cleanTitle(to.title, kind) : "",
		archived: false,
		createdBy: member.userId,
		updatedAt: Date.now(),
		updatedBy: member.userId,
	});
	if (kind === "folder") return pageId;
	await sync.create(ctx, pageId, { type: "doc", content: [{ type: "blockGroup", content: [emptyBlock()] }] });
	if (parentId && "title" in to) {
		await appendPageBlock(ctx, who, await requirePage(ctx, member, parentId), pageId);
	}
	return pageId;
}

/** Sidebar/agent-created children occupy real document blocks too. A folder has no document to hold one. */
export async function appendPageBlock(ctx: MutationCtx, who: Who, parent: Doc<"pages">, pageId: Id<"pages">) {
	if (kindOf(parent) === "folder") return;
	return writeDoc(ctx, who, parent, (doc) => {
		const tr = new Transform(doc);
		let exists = false;
		doc.descendants((node) => { if (node.type.name === "page" && node.attrs.pageId === pageId) exists = true; });
		if (exists) return tr;
		const last = doc.firstChild!.lastChild!;
		const empty = last.childCount === 1 && last.firstChild?.type.name === "paragraph" && last.firstChild.content.size === 0;
		const pos = doc.content.size - 1 - (empty ? last.nodeSize : 0);
		return tr.insert(pos, pageSchema().nodeFromJSON({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "page", attrs: { pageId } }] }));
	});
}

/** Moving or archiving a child removes its page block, while ordinary inline references stay. */
export async function removePageBlock(ctx: MutationCtx, who: Who, parent: Doc<"pages">, pageId: Id<"pages">) {
	if (kindOf(parent) === "folder" || (await pageState(ctx, parent)).archived) return;
	return writeDoc(ctx, who, parent, (doc) => {
		const tr = new Transform(doc);
		doc.descendants((node, pos) => {
			if (node.type.name !== "blockContainer" || node.firstChild?.type.name !== "page" || node.firstChild.attrs.pageId !== pageId) return true;
			tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
			return false;
		});
		return tr;
	});
}

export async function renamePage(ctx: MutationCtx, who: Who, page: Doc<"pages">, title: string) {
	await requireEditable(ctx, who.member, page);
	if (page.recordId) throw new ConvexError("A record's page takes the record's name. Rename the record instead.");
	await writeSources(ctx, who.member, page._id);
	const clean = cleanTitle(title, kindOf(page));
	await ctx.db.patch(page._id, { title: clean, updatedAt: Date.now(), updatedBy: who.member.userId });
	// Page links are plain link marks whose text is the title when inserted (alpha.7 can't render live titles),
	// so keep the parent's links in step, as an edit by whoever renamed. Reworded links and other pages' links stay.
	// A sub-page with its own list keeps its link text as written: the parent may be open to people it isn't.
	const parent = !page.access && page.parentId && clean !== page.title && (await ctx.db.get(page.parentId));
	if (parent && kindOf(parent) !== "folder") await writeDoc(ctx, who, parent, (doc) => relabelLinks(doc, pageHref(page._id), page.title, clean));
}

/** Link text that still reads `from`, linking to `href`, now reads `to`. */
function relabelLinks(doc: Node, href: string, from: string, to: string) {
	const tr = new Transform(doc);
	doc.descendants((node, pos) => {
		if (node.text === from && node.marks.some((m) => m.type.name === "link" && m.attrs.href === href))
			tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize), doc.type.schema.text(to, node.marks));
	});
	return tr;
}

/** Moves a standalone page or folder to Archive or back, with what's inside it. A record's page goes with its record. */
export async function setPageTrashed(ctx: MutationCtx, who: Who, page: Doc<"pages">, archived: boolean) {
	checkPermission(who.member, "pages.edit");
	if (page.recordId) throw new ConvexError("A record's page goes to Archive with its record.");
	if (page.archived === archived) return;
	if (archived) await requireEditable(ctx, who.member, page);
	else await requirePageAccess(ctx, who.member, page, "edit");
	const child = archived && ((await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", page.workspaceId).eq("parentId", page._id).eq("recordId", undefined).eq("archived", false)).first())
		|| (await ctx.db.query("driveFiles").withIndex("by_parent", (q) => q.eq("workspaceId", page.workspaceId).eq("parentId", page._id).eq("archived", false)).first()));
	await toggleTrash(ctx, who, archived, { kind: kindOf(page), id: page._id, name: page.title, includesSubpages: !!child });
	if (!archived && page.parentId) {
		const parent = await ctx.db.get(page.parentId);
		const state = parent ? await pageState(ctx, parent) : null;
		const missingId = state?.missingId ?? (!parent ? page.parentId : undefined);
		if (missingId && await cascading(ctx, "page", { workspaceId: page.workspaceId, pageId: missingId })) throw new ConvexError(`This ${kindOf(page)} is being deleted forever.`);
		// Back at the top level, it keeps the list it had under its parent (as a move would), never Everyone's.
		if (!parent || state?.archived) await ctx.db.patch(page._id, { parentId: undefined, ...keptAccess(who.member, page, (await pageState(ctx, page)).access, undefined) });
	}
	await ctx.db.patch(page._id, { archived, updatedAt: Date.now(), updatedBy: who.member.userId });
	const restored = (await ctx.db.get(page._id))!;
	const parentId = archived ? page.parentId : restored.parentId;
	const parent = parentId && await ctx.db.get(parentId);
	if (parent) {
		if (archived) await removePageBlock(ctx, who, parent, page._id);
		else await appendPageBlock(ctx, who, parent, page._id);
	}
}

/** Deletes a page or folder for good: its row at once, then its content (a little at a time), versions, and what a folder held. */
export async function deletePage(ctx: MutationCtx, pageId: Id<"pages">) {
	const page = await ctx.db.get(pageId);
	await ctx.db.delete(pageId);
	if (page?.kind !== "folder") await ctx.scheduler.runAfter(0, internal.pageSync.deleteDoc, { id: pageId });
	await startCascade(ctx, "page", { pageId, ...(page && { workspaceId: page.workspaceId }) });
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

/** The page's content now (never a folder's: `requireContent` first). */
export async function readDoc(ctx: QueryCtx, pageId: Id<"pages">) {
	// getDoc only reads; its type asks for a mutation ctx.
	return (await sync.getDoc(ctx as unknown as MutationCtx, pageId, pageSchema())).doc;
}

const tooMuch = () => new ConvexError("That's too much to add at once. Split it into smaller pieces.");

/**
 * Validate and save steps (in deltas of at most DELTA_MAX_BYTES), their canonical snapshot and history in one
 * transaction. Returns whether the content changed: steps that change nothing are still saved, since the
 * editor that sent them counts them in its version (an old one setting a page block's title, which the
 * schema no longer has); dropping them would refuse its next edit. They get no snapshot or history.
 */
export async function saveTransform(ctx: MutationCtx, who: Who, page: Doc<"pages">, version: number, tr: Transform, clientId: string | number = "transform", restored?: number) {
	if (!tr.docChanged) return false;
	const state = await pageState(ctx, page);
	await writeSources(ctx, who.member, state.type?._id ?? page._id);
	const content = JSON.stringify(tr.doc.toJSON());
	// The schema has no page titles, but an old app's step can still try to set one (pageBlocks.ts).
	const steps = tr.steps.map((s) => withoutPageTitles(JSON.stringify(s.toJSON())));
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
	if (tr.doc.eq(tr.before)) return false;
	await adoptImages(ctx, page, tr);
	await ctx.runMutation(lib.submitSnapshot, { id: page._id, version: at, content });
	await recordVersion(ctx, who, page, at, restored);
	return true;
}

const imagesIn = (doc: Node) => {
	const urls = new Set<string>();
	doc.descendants((node) => void (node.type.name === "image" && node.attrs.url && urls.add(node.attrs.url)));
	return urls;
};

/**
 * Pictures copied in from another page in the workspace become this page's too, so the file stays
 * while either has it. Only new ones are looked up: a page's own got their row when they arrived.
 * Other URLs (another workspace's, anything else) are left alone.
 */
async function adoptImages(ctx: MutationCtx, page: Doc<"pages">, tr: Transform) {
	const before = imagesIn(tr.before);
	for (const url of imagesIn(tr.doc)) {
		if (before.has(url) || (await ctx.db.query("pageImages").withIndex("by_page", (q) => q.eq("pageId", page._id).eq("url", url)).first())) continue;
		const source = await ctx.db.query("pageImages").withIndex("by_url", (q) => q.eq("workspaceId", page.workspaceId).eq("url", url)).first();
		if (source) await ctx.db.insert("pageImages", { workspaceId: page.workspaceId, pageId: page._id, storageId: source.storageId, url });
	}
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
	requireContent(page);
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
		insertBlocks(tr, doc.content.size - 1 - (last.firstChild?.type.name === "paragraph" && last.textContent === "" && last.childCount === 1 ? last.nodeSize : 0), blocks);
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
