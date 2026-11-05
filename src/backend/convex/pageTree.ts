import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type AccessLevel, EVERYONE, can, widens } from "@companybot/core";
import { type Member, type Who, memo } from "./lib";
import { type AccessList, accessInfo } from "./placeAccess";
import { appendPageBlock, removePageBlock, requireEditable, requirePage } from "./pageOps";

// A deleted ancestor gates the whole subtree immediately; no fan-out on trash/restore.
export const PAGE_DEPTH_MAX = 32;
const MOVE_SCAN_MAX = 1_000;
/** What a page row is: a page, or a folder (wiki/drive.md). */
export const kindOf = (p: Pick<Doc<"pages">, "kind">): "page" | "folder" => p.kind ?? "page";
/** What can go in a page row: pages hold sub-pages only; folders hold pages, folders and files. */
export type ChildKind = "page" | "folder" | "file";

/**
 * A page or folder as lists show it, given how far the person reaches in it (`pageReach`). `lock`: who its own list lets
 * in, for the sidebar's lock ("Office and Owners"); sub-pages following it show none. `canEdit`: Rename, Move,
 * New page inside and Archive (`pages.edit` and Edit in it); lists show live pages only.
 */
export const pageRow = (p: Doc<"pages">, member: Member, level: AccessLevel, parentSeen = true) => ({
	_id: p._id,
	kind: kindOf(p),
	title: p.title,
	/** Null at the top level, and under a parent they can't see. */
	parentId: parentSeen ? (p.parentId ?? null) : null,
	updatedAt: p.updatedAt,
	lock: accessInfo(member, p.access).lock,
	canEdit: level === "edit" && can(member, "pages.edit"),
});

/**
 * What a page or file leaving its parent's list keeps (a move, or a restore to the top level): never more people.
 * One following its parent's list keeps that list if `after` would let anyone further in; one with its own keeps it.
 */
export const keptAccess = (member: Member, page: Pick<Doc<"pages">, "access">, before: AccessList, after: AccessList) => {
	const live = member.workspaceRoles.map((r) => r.id as string);
	// A deleted role's id is copied nowhere: it matches nobody, and the role cleanup may have passed this page already.
	return !page.access && widens(before, after, live) ? { access: (before ?? []).filter((e) => e.role === EVERYONE || live.includes(e.role)) } : {};
};

/**
 * Share this reader across a list to avoid rereading common ancestors. Missing parents fail closed during purge.
 * `access`: the Who can access list that rules the page: its own, else the nearest ancestor's; a record's
 * page, its database's. `type`: that database, for a record's page.
 */
export function pageStates(ctx: QueryCtx, get: (id: Id<"pages">) => Promise<Doc<"pages"> | null> = (id) => ctx.db.get(id)) {
	const seen = new Map<Id<"pages">, Promise<Doc<"pages"> | null>>();
	const typeOf = memo(async (recordId: Id<"records">) => {
		const record = await ctx.db.get(recordId);
		return record && (await ctx.db.get(record.typeId));
	});
	return async (page: Doc<"pages">): Promise<PageState> => {
		if (page.recordId) {
			const type = await typeOf(page.recordId);
			// A record's page has no parent; it's in Archive with its record (pageOps.requireEditable checks that).
			return { ancestors: [], archived: page.archived, trashPage: page.archived ? page : undefined, access: type ? type.access : [], type: type ?? undefined };
		}
		const ancestors: Doc<"pages">[] = [];
		let current = page;
		let trashPage = page.archived ? page : undefined;
		while (current.parentId) {
			if (ancestors.length >= PAGE_DEPTH_MAX || current.parentId === page._id) throw new ConvexError("This page's nesting is too deep.");
			let pending = seen.get(current.parentId);
			if (!pending) { pending = get(current.parentId); seen.set(current.parentId, pending); }
			const parent = await pending;
			if (!parent || parent.workspaceId !== page.workspaceId) return { ancestors, archived: true, trashPage, missingId: current.parentId, access: [] };
			ancestors.push(parent);
			if (parent.archived) trashPage = parent;
			current = parent;
		}
		return { ancestors, archived: !!trashPage, trashPage, access: [page, ...ancestors].find((p) => p.access)?.access };
	};
}

export type PageState = {
	ancestors: Doc<"pages">[];
	archived: boolean;
	trashPage?: Doc<"pages">;
	missingId?: Id<"pages">;
	access: AccessList;
	type?: Doc<"recordTypes">;
};
export const pageState = (ctx: QueryCtx, page: Doc<"pages">) => pageStates(ctx)(page);

/** Record bodies are neither parents nor children. Folders go in folders; files go in folders; pages go in either. */
export async function parentFor(ctx: QueryCtx, member: Member, parentId: Id<"pages">, child: ChildKind = "page") {
	const parent = await requirePage(ctx, member, parentId);
	if (parent.recordId) throw new ConvexError("Record bodies can't contain sub-pages.");
	if (child !== "page" && kindOf(parent) !== "folder") throw new ConvexError(`${child === "file" ? "Files" : "Folders"} go in folders, or at the top level of Drive.`);
	await requireEditable(ctx, member, parent);
	const state = await pageState(ctx, parent);
	if (state.ancestors.length + 1 >= PAGE_DEPTH_MAX) throw new ConvexError(`Keep pages under ${PAGE_DEPTH_MAX} levels deep.`);
	return { parent, ...state };
}

/** Shared app/agent move, with bounded cycle/depth checks and history. */
export async function movePage(ctx: MutationCtx, who: Who, page: Doc<"pages">, parentId?: Id<"pages">) {
	await requireEditable(ctx, who.member, page);
	if (page.recordId) throw new ConvexError("Record bodies can't be nested.");
	if (page.parentId === parentId) return;
	const before = await pageState(ctx, page);
	const destination = parentId ? await parentFor(ctx, who.member, parentId, kindOf(page)) : null;
	if (parentId === page._id || destination?.ancestors.some((p) => p._id === page._id)) throw new ConvexError(`A ${kindOf(page)} can't move inside itself or its descendants.`);
	const depth = destination ? destination.ancestors.length + 1 : 0;
	// Shallower moves cannot violate the depth limit. Deeper moves inspect at most 1,000 descendants.
	if (depth > before.ancestors.length) {
		const queue = [{ id: page._id, depth }];
		let scanned = 0;
		for (let i = 0; i < queue.length; i++) {
			const next = queue[i]!;
			const children = await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", page.workspaceId).eq("parentId", next.id)).take(MOVE_SCAN_MAX - scanned + 1);
			scanned += children.length;
			if (scanned > MOVE_SCAN_MAX) throw new ConvexError("This tree is too large to move deeper at once. Move smaller branches first.");
			if (children.length && next.depth + 1 >= PAGE_DEPTH_MAX) throw new ConvexError(`Keep pages under ${PAGE_DEPTH_MAX} levels deep.`);
			queue.push(...children.map((p) => ({ id: p._id, depth: next.depth + 1 })));
		}
	}
	// Moving never opens a page to more people. Moving somewhere stricter makes it stricter.
	const kept = keptAccess(who.member, page, before.access, destination ? destination.access : undefined);
	await ctx.db.patch(page._id, { parentId, updatedAt: Date.now(), updatedBy: who.member.userId, ...kept });
	if (before.ancestors[0]) await removePageBlock(ctx, who, before.ancestors[0], page._id);
	if (destination) await appendPageBlock(ctx, who, destination.parent, page._id);
	const latest = await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id)).order("desc").first();
	const n = (latest?.n ?? 0) + 1;
	// Ids, not titles: history names each place only to people who can see it (pages.moves).
	await ctx.db.insert("pageMoves", { workspaceId: page.workspaceId, pageId: page._id, n, userId: who.member.userId, ...(who.agentId && { agentId: who.agentId }), fromId: before.ancestors[0]?._id ?? null, toId: destination?.parent._id ?? null });
	for (const old of await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id).lte("n", n - 100)).take(2)) await ctx.db.delete(old._id);
}

export type FileState = {
	/** Its folder's ancestors, nearest first: the folder, then the folder's. */
	ancestors: Doc<"pages">[];
	archived: boolean;
	/** What put it in Archive: itself, or a folder above it. */
	trashItem?: Doc<"driveFiles"> | Doc<"pages">;
	missingId?: Id<"pages">;
	access: AccessList;
};

/**
 * A file's state, like `pageStates`: in Archive if it or a folder above it is; its own Who can access
 * list, else its folder's (`pageStates`). Share one reader across a list.
 */
export function fileStates(ctx: QueryCtx, pages = pageStates(ctx)) {
	return async (file: Doc<"driveFiles">): Promise<FileState> => {
		const folder = file.parentId ? await ctx.db.get(file.parentId) : null;
		if (file.parentId && (!folder || folder.workspaceId !== file.workspaceId)) return { ancestors: [], archived: true, trashItem: file.archived ? file : undefined, missingId: file.parentId, access: [] };
		const above = folder ? await pages(folder) : null;
		if (above?.missingId) return { ancestors: [folder!, ...above.ancestors], archived: true, trashItem: file.archived ? file : undefined, missingId: above.missingId, access: [] };
		const trashItem = file.archived ? file : above?.trashPage;
		return { ancestors: folder ? [folder, ...above!.ancestors] : [], archived: !!trashItem, trashItem, access: file.access ?? above?.access };
	};
}
export const fileState = (ctx: QueryCtx, file: Doc<"driveFiles">) => fileStates(ctx)(file);
