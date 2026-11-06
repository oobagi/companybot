import { type AccessLevel, can, fileKind, reaches } from "@companybot/core";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { cascading } from "./cascade";
import { mutation, query } from "./functions";
import { deleteFile, uploadOf } from "./images";
import { type Member, type Who, capped, checkPermission, emptyPage, getMember, requireInWorkspace, requireMember } from "./lib";
import { cleanTitle, pageReach } from "./pageOps";
import { type FileState, fileState, fileStates, keptAccess, kindOf, pageRow, pageState, parentFor } from "./pageTree";
import { accessInfo, reach, requireAccess, requireKeepsEdit, savedAccess } from "./placeAccess";
import { changeAccessSources, notePlace, readArtifact, writeSources } from "./replySources";
import { accessArg } from "./schema";
import { leaveSections } from "./sectionOps";
import { toggleTrash, trashInfo } from "./trashOps";

// Files in Drive: PDFs, Office files, pictures and text, in folders (pages rows with `kind: "folder"`,
// pageTree.ts) or at the top level. Uploaded through the chat's upload endpoint (files.upload) and
// claimed here (`addFile`), like a message claims its attachments. Who can access follows the folder
// unless the file sets its own list; Archive gates a folder's files with it. See wiki/drive.md.

const TITLES_MAX = 100;

/** A file in the person's workspace that they reach `need` in (`requireFileAccess`). */
export async function requireFile(ctx: QueryCtx, member: Member, fileId: Id<"driveFiles">, need: AccessLevel = "view") {
	const file = requireInWorkspace(member, await ctx.db.get(fileId), "File");
	await requireFileAccess(ctx, member, file, need);
	return file;
}

/** Refuses someone without `need` in a file, naming who has it: by its own list, or its folder's. */
export async function requireFileAccess(ctx: QueryCtx, member: Member, file: Doc<"driveFiles">, need: AccessLevel, state?: FileState, asked?: string) {
	const { access } = state ?? (await fileState(ctx, file));
	if (!(await readArtifact(ctx, member, file))) throw new ConvexError("File not found.");
	requireAccess(member, "file", file.name, access, need, asked);
	await notePlace(ctx, member, file._id, access);
}

/** How far someone reaches in each file ("edit", "view" or null), sharing reads across a list. */
export function fileReach(ctx: QueryCtx, member: Member) {
	const state = fileStates(ctx);
	return async (file: Doc<"driveFiles">) => {
		const { access } = await state(file);
		const level = (await readArtifact(ctx, { ...member, replyId: undefined }, file)) ? reach(member, access) : null;
		if (level) await notePlace(ctx, member, file._id, access);
		return level;
	};
}

/** Whether someone can see a file (`fileReach`). */
export function fileVisible(ctx: QueryCtx, member: Member) {
	const level = fileReach(ctx, member);
	return async (file: Doc<"driveFiles">) => reaches(await level(file), "view");
}

/** `pages.edit` and Edit in the file change it, unless it or its folder is in Archive. */
export async function requireFileEditable(ctx: QueryCtx, member: Member, file: Doc<"driveFiles">) {
	checkPermission(member, "pages.edit");
	const state = await fileState(ctx, file);
	await requireFileAccess(ctx, member, file, "edit", state);
	if (state.archived) throw new ConvexError("This file is in Archive. Restore it to make changes.");
}

/** A file as lists show it (like `pageRow`). */
export const fileRow = (f: Doc<"driveFiles">, member: Member, level: AccessLevel, parentSeen = true) => ({
	_id: f._id,
	name: f.name,
	type: f.type,
	size: f.size,
	/** Null at the top level, and under a folder they can't see. */
	parentId: parentSeen ? (f.parentId ?? null) : null,
	updatedAt: f.updatedAt,
	lock: accessInfo(member, f.access).lock,
	canEdit: level === "edit" && can(member, "pages.edit"),
});

/**
 * Puts one of the caller's unclaimed file uploads (files.upload, with `file` set) in a folder or at
 * Drive's top level, as a message claims its attachments. Anyone else's, a picture's, or one already
 * used is refused. `name` renames it on the way in.
 */
export async function addFile(ctx: MutationCtx, who: Who, storageId: Id<"_storage">, parentId?: Id<"pages">, name?: string) {
	const { member } = who;
	checkPermission(member, "pages.edit");
	if (parentId) await parentFor(ctx, member, parentId, "file");
	const upload = await uploadOf(ctx, storageId);
	if (upload?.userId !== member.userId || upload.workspaceId !== member.workspaceId || !upload.file) throw new ConvexError("That file isn't available anymore. Upload it again.");
	await ctx.db.delete(upload._id);
	const usedPlaces = await writeSources(ctx, member, parentId);
	return ctx.db.insert("driveFiles", {
		usedPlaces,
		workspaceId: member.workspaceId,
		...(parentId && { parentId }),
		...upload.file,
		name: cleanTitle(name ?? upload.file.name, "file"),
		storageId,
		archived: false,
		createdBy: member.userId,
		updatedAt: Date.now(),
		updatedBy: member.userId,
	});
}

export async function renameFile(ctx: MutationCtx, who: Who, file: Doc<"driveFiles">, name: string) {
	await requireFileEditable(ctx, who.member, file);
	await writeSources(ctx, who.member, file._id);
	await ctx.db.patch(file._id, { name: cleanTitle(name, "file"), updatedAt: Date.now(), updatedBy: who.member.userId });
}

/** Moves a file to a folder, or the top level. Like a page, it never opens to more people on the way (`keptAccess`). */
export async function moveFile(ctx: MutationCtx, who: Who, file: Doc<"driveFiles">, parentId?: Id<"pages">) {
	await requireFileEditable(ctx, who.member, file);
	if (file.parentId === parentId) return;
	const before = await fileState(ctx, file);
	const destination = parentId ? await parentFor(ctx, who.member, parentId, "file") : null;
	const kept = keptAccess(who.member, file, before.access, destination ? destination.access : undefined);
	await ctx.db.patch(file._id, { parentId, updatedAt: Date.now(), updatedBy: who.member.userId, ...kept });
	// Sidebar sections hold top-level things only.
	if (!file.parentId) await leaveSections(ctx, file.workspaceId, "drive", file._id);
}

/** Moves a file to Archive or back. One in Archive with its folder comes back with the folder. */
export async function setFileTrashed(ctx: MutationCtx, who: Who, file: Doc<"driveFiles">, archived: boolean) {
	checkPermission(who.member, "pages.edit");
	if (file.archived === archived) return;
	if (archived) await requireFileEditable(ctx, who.member, file);
	else await requireFileAccess(ctx, who.member, file, "edit");
	await toggleTrash(ctx, who, archived, { kind: "file", id: file._id, name: file.name });
	if (!archived && file.parentId) {
		const folder = await ctx.db.get(file.parentId);
		const state = folder ? await pageState(ctx, folder) : null;
		const missingId = state?.missingId ?? (!folder ? file.parentId : undefined);
		if (missingId && (await cascading(ctx, "page", { workspaceId: file.workspaceId, pageId: missingId }))) throw new ConvexError("This file is being deleted forever.");
		// Back at the top level, it keeps the list it had in its folder (as a move would), never Everyone's.
		if (!folder || state?.archived) await ctx.db.patch(file._id, { parentId: undefined, ...keptAccess(who.member, file, (await fileState(ctx, file)).access, undefined) });
	}
	await ctx.db.patch(file._id, { archived, updatedAt: Date.now(), updatedBy: who.member.userId });
}

/** Deletes a file for good: its row and its stored bytes. */
export async function deleteDriveFile(ctx: MutationCtx, fileId: Id<"driveFiles">) {
	const file = await ctx.db.get(fileId);
	if (!file) return;
	await ctx.db.delete(fileId);
	await deleteFile(ctx, file.storageId);
	if (!file.parentId) await leaveSections(ctx, file.workspaceId, "drive", file._id);
}

/** Whether a folder (or the top level) can list files for this person. */
async function folderListable(ctx: QueryCtx, member: Member, parentId: Id<"pages"> | undefined) {
	if (!parentId) return true;
	const folder = await ctx.db.get(parentId);
	return folder?.workspaceId === member.workspaceId && kindOf(folder) === "folder" && !(await pageState(ctx, folder)).archived && !!(await pageReach(ctx, member)(folder));
}

/** Puts one of your uploads (files.upload) in Drive: in a folder, or at the top level. Returns the file's id. */
export const add = mutation({
	args: { file: v.id("_storage"), parentId: v.optional(v.id("pages")) },
	handler: async (ctx, { file, parentId }) => addFile(ctx, { member: await requireMember(ctx) }, file, parentId),
});

/** A file's screen: what it is, where it opens (`url`), its folder path, and what this person may do. */
export const get = query({
	args: { fileId: v.string() },
	handler: async (ctx, { fileId }) => {
		const member = await getMember(ctx);
		const id = ctx.db.normalizeId("driveFiles", fileId);
		const file = member && id && (await ctx.db.get(id));
		if (!member || file?.workspaceId !== member.workspaceId) return null;
		const state = await fileState(ctx, file);
		const level = await fileReach(ctx, member)(file);
		if (!level) return null;
		const { level: _level, ...access } = accessInfo(member, state.access);
		const reach = pageReach(ctx, member);
		const ancestors = [];
		for (const [i, a] of state.ancestors.entries()) {
			const at = await reach(a);
			const above = state.ancestors[i + 1];
			if (at) ancestors.unshift(pageRow(a, member, at, !above || !!(await reach(above))));
		}
		// In Archive with a folder they can't see: say it's archived without naming or offering what holds it.
		const held = state.trashItem && state.trashItem._id !== file._id ? (state.trashItem as Doc<"pages">) : undefined;
		const trashItem = held && !(await reach(held)) ? null : (state.trashItem ?? file);
		return {
			_id: file._id,
			name: file.name,
			type: file.type,
			kind: fileKind(file.type),
			size: file.size,
			width: file.width ?? null,
			height: file.height ?? null,
			/** Where its bytes are, for the viewer and Download. Null once the stored file is gone. */
			url: await ctx.storage.getUrl(file.storageId),
			archived: state.archived,
			// A folder they can't see stays unnamed and unlinked: the file reads as top-level to them.
			parentId: state.ancestors[0] && (await reach(state.ancestors[0])) ? state.ancestors[0]._id : null,
			ancestors,
			updatedAt: file.updatedAt,
			canEdit: await requireFileEditable(ctx, member, file).then(() => true, () => false),
			trash: trashItem && (await trashInfo(ctx, member, trashItem._id)),
			...access,
			/** Its own list, or null when it follows its folder's. */
			ownAccess: file.access ? access.access : null,
			/** Who can access can be changed here: `pages.edit` and Edit in it. */
			canManageAccess: can(member, "pages.edit") && level === "edit",
		};
	},
});

/** The files in a folder, or at the top level, by name; the sidebar and Drive's listings share it. */
export const children = query({
	args: { parentId: v.optional(v.id("pages")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { parentId, paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member || !(await folderListable(ctx, member, parentId))) return emptyPage();
		const result = await ctx.db
			.query("driveFiles")
			.withIndex("by_parent", (q) => q.eq("workspaceId", member.workspaceId).eq("parentId", parentId).eq("archived", false))
			.paginate(capped(paginationOpts, 50));
		const reach = fileReach(ctx, member);
		const page = [];
		// Files kept from them are left out; a page can come back short.
		for (const f of result.page) {
			const level = await reach(f);
			if (level) page.push(fileRow(f, member, level));
		}
		return { ...result, page };
	},
});

/** Live files by id, as the rail's pins show them: gone or hidden ones are left out. */
export const titles = query({
	args: { ids: v.array(v.string()) },
	handler: async (ctx, { ids }) => {
		if (ids.length > TITLES_MAX) throw new ConvexError(`Look up at most ${TITLES_MAX} files at once.`);
		const member = await getMember(ctx);
		if (!member) return [];
		const state = fileStates(ctx);
		const seen = fileVisible(ctx, member);
		const rows = [];
		for (const value of ids) {
			const id = ctx.db.normalizeId("driveFiles", value);
			const file = id && (await ctx.db.get(id));
			if (file && file.workspaceId === member.workspaceId && !(await state(file)).archived && (await seen(file))) rows.push({ _id: file._id, name: file.name, type: file.type });
		}
		return rows;
	},
});

export const rename = mutation({
	args: { fileId: v.id("driveFiles"), name: v.string() },
	handler: async (ctx, { fileId, name }) => {
		const member = await requireMember(ctx);
		await renameFile(ctx, { member }, await requireFile(ctx, member, fileId), name);
	},
});

export const move = mutation({
	args: { fileId: v.id("driveFiles"), parentId: v.optional(v.id("pages")) },
	handler: async (ctx, { fileId, parentId }) => {
		const member = await requireMember(ctx);
		await moveFile(ctx, { member }, await requireFile(ctx, member, fileId), parentId);
	},
});

/**
 * Who can access a file: Everyone or roles, each at View or Edit, or `null` to follow its folder's
 * again. People with `pages.edit` and Edit in it choose.
 */
export const setAccess = mutation({
	args: { fileId: v.id("driveFiles"), access: v.union(accessArg, v.null()) },
	handler: async (ctx, { fileId, access }) => {
		const member = await requireMember(ctx);
		const file = await requireFile(ctx, member, fileId);
		await requireFileEditable(ctx, member, file);
		const next = access ? await savedAccess(ctx, member, access) : undefined;
		const inherited = file.parentId ? (await pageState(ctx, (await ctx.db.get(file.parentId))!)).access : undefined;
		requireKeepsEdit(member, "page", next ?? inherited);
		// It can retain facts from another source: check before widening.
		await changeAccessSources(ctx, member, file, { access: next ?? inherited });
		await ctx.db.patch(file._id, { access: next });
	},
});
