import { fileFindInput, fileReadInput, fileWriteInput, isImageType, sniffFile } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalAction, internalMutation } from "./_generated/server";
import { withReceipt } from "./approvals";
import { addFile, fileVisible, moveFile, renameFile, requireFile, requireFileAccess, setFileTrashed } from "./driveFiles";
import { type Member, asToolResult } from "./lib";
import { requirePage } from "./pageOps";
import { fileStates, kindOf, pageStates } from "./pageTree";
import { opArg } from "./schema";
import { runningTurn } from "./turns";

// FileStore (core drive-tools.ts) as the turn's person: files in Drive, found, read and saved with
// the same checks the app's own mutations make (driveFiles.ts). Text a model writes is stored by
// `saveText` and claimed like an upload, as a chat file's copy is (files.copyFor).

const FIND_MAX = 50;
const SEARCH_MAX = 20;

/** A live file by id, else one named exactly `name`. For reads: writes take ids (`fileById`). */
async function fileNamed(ctx: QueryCtx, member: Member, name: string) {
	const id = ctx.db.normalizeId("driveFiles", name);
	if (id) return requireFile(ctx, member, id);
	const candidates = await ctx.db
		.query("driveFiles")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("archived", false).eq("name", name.trim()))
		.take(FIND_MAX + 1);
	const state = fileStates(ctx);
	const rows = [];
	for (const f of candidates) if (!(await state(f)).archived) rows.push(f);
	if (candidates.length > FIND_MAX || rows.length > 1) throw new ConvexError(`Several files are named “${name}”. Find them with files_find and use an id.`);
	if (!rows[0]) throw new ConvexError(`No file named “${name}”. Find it with files_find, or use its id.`);
	// Found by name but kept from them: say who can see it, so the agent can tell its person whom to ask.
	await requireFileAccess(ctx, member, rows[0], "view", undefined, name.trim());
	return rows[0];
}

/**
 * A file by id, for writes: never by name, so a held call changes the file it was approved for even if a file
 * is renamed and another takes its name meanwhile (core page-tools `writeTarget` has the same rule). Archived too, to restore it.
 */
async function fileById(ctx: QueryCtx, member: Member, raw: string) {
	const id = ctx.db.normalizeId("driveFiles", raw.trim());
	if (!id) throw new ConvexError(`Name the file by its id, not “${raw}”: names can change. files_find gives ids.`);
	return requireFile(ctx, member, id);
}

/** A folder by id, for writes (`folderNamed` for reads). */
async function folderById(ctx: QueryCtx, member: Member, raw: string) {
	const id = ctx.db.normalizeId("pages", raw.trim());
	if (!id) throw new ConvexError(`Name the folder by its id, not “${raw}”: titles can change. pages_find gives ids.`);
	const page = await requirePage(ctx, member, id);
	if (kindOf(page) !== "folder") throw new ConvexError(`“${page.title}” is a page, not a folder. Files go in folders, or at the top level of Drive.`);
	return page;
}

/** A live folder by id, else one titled exactly `name`. For reads. */
async function folderNamed(ctx: QueryCtx, member: Member, name: string) {
	const id = ctx.db.normalizeId("pages", name);
	const byId = id && (await requirePage(ctx, member, id));
	if (byId) {
		if (kindOf(byId) !== "folder") throw new ConvexError(`“${byId.title}” is a page, not a folder. Files go in folders, or at the top level of Drive.`);
		return byId;
	}
	const candidates = await ctx.db
		.query("pages")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("recordId", undefined).eq("archived", false).eq("title", name.trim()))
		.take(FIND_MAX + 1);
	const state = pageStates(ctx);
	const rows = [];
	for (const p of candidates) if (kindOf(p) === "folder" && !(await state(p)).archived) rows.push(p);
	if (candidates.length > FIND_MAX || rows.length > 1) throw new ConvexError(`Several folders are named “${name}”. Find them with pages_find and use an id.`);
	if (!rows[0]) throw new ConvexError(`No folder named “${name}”. Find it with pages_find, or use its id.`);
	return requirePage(ctx, member, rows[0]._id);
}

const row = (f: Doc<"driveFiles">, folderSeen: boolean) => ({ id: f._id, name: f.name, type: f.type, size: f.size, folderId: folderSeen ? (f.parentId ?? null) : null, edited: new Date(f.updatedAt).toISOString() });

export const findFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) =>
		asToolResult(async () => {
			const { member } = await runningTurn(ctx, turnId);
			const { search, cursor, trashed = false, folder } = fileFindInput.parse(input);
			const in_ = folder ? await folderNamed(ctx, member, folder) : null;
			const files = ctx.db.query("driveFiles");
			const found = folder !== undefined
				? files.withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", in_?._id).eq("archived", trashed))
				: search?.trim()
					? files.withSearchIndex("search_name", (q) => q.search("name", search).eq("workspaceId", member.workspaceId).eq("archived", trashed))
					: files.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("archived", trashed));
			const page = await found.paginate({ numItems: search?.trim() ? SEARCH_MAX : FIND_MAX, cursor: cursor ?? null });
			const state = fileStates(ctx);
			const seen = fileVisible(ctx, member);
			const folderSeen = pageStates(ctx);
			const rows = [];
			for (const f of page.page) {
				if (!(await seen(f))) continue;
				const { archived, ancestors } = await state(f);
				if (archived !== trashed) continue;
				rows.push(row(f, !ancestors[0] || !(await folderSeen(ancestors[0])).archived));
			}
			return { rows, more: !page.isDone, ...(!page.isDone && { cursor: page.continueCursor }) };
		}),
});

/** files_read's lookup, as the turn's person now: the file to read, or why not. */
export const readFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) =>
		asToolResult(async () => {
			const { member } = await runningTurn(ctx, turnId);
			const { file: name, page } = fileReadInput.parse(input);
			const file = await fileNamed(ctx, member, name);
			if (isImageType(file.type)) throw new ConvexError(`${file.name} is a picture, with no text to read.`);
			return { storageId: file.storageId, name: file.name, type: file.type, page };
		}),
});

/** Stores text a model wrote as the turn's person's upload (a file for a message), typed by its name like an uploaded file. */
export const saveText = internalAction({
	args: { turnId: v.id("agentTurns"), name: v.string(), text: v.string() },
	handler: async (ctx, { turnId, name, text }): Promise<{ storageId: Id<"_storage"> } | { error: string }> => {
		const bytes = new TextEncoder().encode(text);
		const type = sniffFile(bytes, name);
		if (!type || isImageType(type)) return { error: `Name a text file .txt, .md, .csv or .json (not ${JSON.stringify(name)}).` };
		const storageId = await ctx.storage.store(new Blob([bytes], { type }));
		const saved = await ctx.runMutation(internal.files.saveCopy, { turnId, storageId, file: { name, type, size: bytes.length } });
		return saved ? { error: saved } : { storageId };
	},
});

/** `op`: an approved call's operation key (approvals.withReceipt). */
const writeArgs = { turnId: v.id("agentTurns"), op: v.optional(opArg), input: v.any(), upload: v.optional(v.id("_storage")) };

// Catch expected errors outside the write transaction, so a refused change saves nothing.
export const writeFor = internalMutation({
	args: writeArgs,
	// The approval's receipt commits with the file change (or the refusal), in this one transaction.
	handler: (ctx, { op, ...args }): Promise<unknown> => withReceipt(ctx, op, args.turnId, () => asToolResult(() => ctx.runMutation(internal.driveTools.writeChecked, args))),
});

/** `upload`: the file to put in Drive, already the person's upload (a copy of a chat file, or text they had written). */
export const writeChecked = internalMutation({
	args: writeArgs,
	handler: async (ctx, { turnId, input, upload }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { file: name, name: newName, folder, from, text, trash } = fileWriteInput.parse(input);
		const folderId = folder ? (await folderById(ctx, member, folder))._id : undefined;
		const changes = [newName, folder, from, text].filter((x) => x !== undefined).length;
		if (trash !== undefined) {
			if (!name || changes) throw new ConvexError("Archive or restore a file on its own: file and trash only.");
			const file = await fileById(ctx, member, name);
			await setFileTrashed(ctx, who, file, trash);
			return { id: file._id, name: file.name };
		}
		if (upload) {
			if (name) throw new ConvexError("To save a new file, leave file out; to change one, leave from and text out.");
			if (text !== undefined && !newName) throw new ConvexError("Name the new text file (name), with its extension.");
			const id = await addFile(ctx, who, upload, folderId, newName);
			const saved = (await ctx.db.get(id))!;
			return { id, name: saved.name, folderId: saved.parentId ?? null };
		}
		if (!name) throw new ConvexError("Say what to do: from or text saves a new file; file with name, folder or trash changes one.");
		if (newName === undefined && folder === undefined) throw new ConvexError("Give the file a new name (name), a folder to move to (folder), or trash.");
		const file = await fileById(ctx, member, name);
		if (newName !== undefined) await renameFile(ctx, who, file, newName);
		if (folder !== undefined) await moveFile(ctx, who, file, folderId);
		const after = (await ctx.db.get(file._id))!;
		return { id: after._id, name: after.name, folderId: after.parentId ?? null };
	},
});
