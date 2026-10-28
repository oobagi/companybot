import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Member, Who } from "./lib";
import { requireEditable, requirePage } from "./pageOps";

// A deleted ancestor gates the whole subtree immediately; no fan-out on trash/restore.
export const PAGE_DEPTH_MAX = 32;
const MOVE_SCAN_MAX = 1_000;
export const pageRow = (p: Doc<"pages">) => ({ _id: p._id, title: p.title, parentId: p.parentId ?? null, updatedAt: p.updatedAt });

/** Share this reader across a list to avoid rereading common ancestors. Missing parents fail closed during purge. */
export function pageStates(ctx: QueryCtx) {
	const seen = new Map<Id<"pages">, Promise<Doc<"pages"> | null>>();
	return async (page: Doc<"pages">) => {
		const ancestors: Doc<"pages">[] = [];
		let current = page;
		let trashPage = page.archived ? page : undefined;
		while (current.parentId) {
			if (ancestors.length >= PAGE_DEPTH_MAX || current.parentId === page._id) throw new ConvexError("This page's nesting is too deep.");
			let pending = seen.get(current.parentId);
			if (!pending) { pending = ctx.db.get(current.parentId); seen.set(current.parentId, pending); }
			const parent = await pending;
			if (!parent || parent.workspaceId !== page.workspaceId) return { ancestors, archived: true, trashPage, missingId: current.parentId };
			ancestors.push(parent);
			if (parent.archived) trashPage = parent;
			current = parent;
		}
		return { ancestors, archived: !!trashPage, trashPage };
	};
}
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
	await ctx.db.patch(page._id, { parentId, updatedAt: Date.now(), updatedBy: who.member.userId });
	const latest = await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id)).order("desc").first();
	const n = (latest?.n ?? 0) + 1;
	await ctx.db.insert("pageMoves", { workspaceId: page.workspaceId, pageId: page._id, n, userId: who.member.userId, ...(who.agentId && { agentId: who.agentId }), from: before.ancestors[0]?.title ?? "Pages", to: destination?.parent.title ?? "Pages" });
	for (const old of await ctx.db.query("pageMoves").withIndex("by_page", (q) => q.eq("pageId", page._id).lte("n", n - 100)).take(2)) await ctx.db.delete(old._id);
}
