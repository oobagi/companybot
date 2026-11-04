import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { widens } from "@companybot/core";
import { type Member, type Who, memo } from "./lib";
import { type AccessList, accessInfo } from "./placeAccess";
import { appendPageBlock, removePageBlock, requireEditable, requirePage } from "./pageOps";

// A deleted ancestor gates the whole subtree immediately; no fan-out on trash/restore.
export const PAGE_DEPTH_MAX = 32;
const MOVE_SCAN_MAX = 1_000;
/** A page as lists show it. `lock`: who its own list lets in, for the sidebar's lock ("Office and Owners"); sub-pages following it show none. */
export const pageRow = (p: Doc<"pages">, member: Member) => ({ _id: p._id, title: p.title, parentId: p.parentId ?? null, updatedAt: p.updatedAt, lock: accessInfo(member, p.access).lock });

/**
 * Share this reader across a list to avoid rereading common ancestors. Missing parents fail closed during purge.
 * `access`: the Who can access list that rules the page: its own, else the nearest ancestor's; a record's
 * page, its database's. `type`: that database, for a record's page.
 */
export function pageStates(ctx: QueryCtx) {
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
			if (!pending) { pending = ctx.db.get(current.parentId); seen.set(current.parentId, pending); }
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

/** Record bodies are neither parents nor children. */
export async function parentFor(ctx: QueryCtx, member: Member, parentId: Id<"pages">) {
	const parent = await requirePage(ctx, member, parentId);
	if (parent.recordId) throw new ConvexError("Record bodies can't contain sub-pages.");
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
	const destination = parentId ? await parentFor(ctx, who.member, parentId) : null;
	if (parentId === page._id || destination?.ancestors.some((p) => p._id === page._id)) throw new ConvexError("A page can't move inside itself or its descendants.");
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
	// Moving never opens a page to more people: one following its old parent's list keeps that list
	// if the new place's would let anyone further in. Moving somewhere stricter makes it stricter.
	const keep = !page.access && widens(before.access, destination ? destination.access : undefined, who.member.workspaceRoles.map((r) => r.id));
	await ctx.db.patch(page._id, { parentId, updatedAt: Date.now(), updatedBy: who.member.userId, ...(keep && { access: before.access ?? [] }) });
	if (before.ancestors[0]) await removePageBlock(ctx, who, before.ancestors[0], page._id);
	if (destination) await appendPageBlock(ctx, who, destination.parent, page._id, page.title);
	const latest = await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id)).order("desc").first();
	const n = (latest?.n ?? 0) + 1;
	await ctx.db.insert("pageMoves", { workspaceId: page.workspaceId, pageId: page._id, n, userId: who.member.userId, ...(who.agentId && { agentId: who.agentId }), from: before.ancestors[0]?.title ?? "Pages", to: destination?.parent.title ?? "Pages" });
	for (const old of await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id).lte("n", n - 100)).take(2)) await ctx.db.delete(old._id);
}
