import { can, deniedMessage } from "@companybot/core";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { type MutationCtx, internalMutation } from "./_generated/server";
import { startCascade } from "./cascade";
import { setChannelTrashed } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, type Who, getMember, nameOf, requireMember } from "./lib";
import { deletePage, requirePage, setPageTrashed } from "./pageOps";
import { setFieldTrashed, setRecordTrashed, setTypeTrashed } from "./recordOps";
import { trashKind } from "./schema";
import { TRASH_MS, type TrashKind, canRestore, trashEntry } from "./trashOps";

// Trash: one place for every deleted record, database, field, page and channel. Deleting moves
// an item here; whoever deleted it (or an owner) can restore it, where it was, links included.
// Owners can delete forever; everything else goes for good after TRASH_DAYS. See wiki/data.md#trash.

const PAGE_MAX = 50;
/** Entries deleted for good per run. Each starts its own cascade, so this only bounds the sweep itself; a full run schedules the next. */
const SWEEP_MAX = 100;

const tables = { record: "records", database: "recordTypes", field: "recordFields", page: "pages", channel: "chats" } as const satisfies Record<TrashKind, TableNames>;

function idOf<K extends TrashKind>(ctx: MutationCtx, kind: K, id: string) {
	const itemId = ctx.db.normalizeId(tables[kind], id);
	if (!itemId) throw new ConvexError("That isn't in this workspace.");
	return itemId as Id<(typeof tables)[K]>;
}

/** Moves an item to Trash, or back: each kind's own rules decide who may. Agents use the same. */
export async function setTrashed(ctx: MutationCtx, who: Who, kind: TrashKind, id: string, trashed: boolean) {
	if (kind === "record") return void (await setRecordTrashed(ctx, who, idOf(ctx, kind, id), trashed));
	if (kind === "database") return setTypeTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "field") return setFieldTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "page") return setPageTrashed(ctx, who, await requirePage(ctx, who.member, idOf(ctx, kind, id)), trashed);
	return setChannelTrashed(ctx, who, idOf(ctx, kind, id), trashed);
}

/**
 * Deletes an entry's item for good. The entry goes at once, so it can't be restored; a cascade
 * (lifecycle.ts) then deletes what belonged to the item, and the item last. Pages go at once.
 */
async function deleteEntry(ctx: MutationCtx, entry: Doc<"trash">) {
	await ctx.db.delete(entry._id);
	const workspaceId = entry.workspaceId;
	if (entry.kind === "record") await startCascade(ctx, "record", { workspaceId, recordId: idOf(ctx, "record", entry.itemId) });
	if (entry.kind === "database") await startCascade(ctx, "database", { workspaceId, typeId: idOf(ctx, "database", entry.itemId) });
	if (entry.kind === "field") await startCascade(ctx, "field", { workspaceId, typeId: entry.typeId, fieldId: idOf(ctx, "field", entry.itemId) });
	if (entry.kind === "channel") await startCascade(ctx, "channel", { workspaceId, chatId: idOf(ctx, "channel", entry.itemId) });
	if (entry.kind === "page") await deletePage(ctx, idOf(ctx, "page", entry.itemId));
}

/** "Delete forever": owners only, and never agents. */
export async function purgeItem(ctx: MutationCtx, member: Member, itemId: string) {
	if (!can(member.role, "trash.manage")) throw new ConvexError(deniedMessage("trash.manage"));
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId) throw new ConvexError("It's no longer in Trash.");
	await deleteEntry(ctx, entry);
}

/** What's in Trash, newest first, optionally one kind, or matching words in names (best first, up to 50). */
export const list = query({
	args: { kind: v.optional(trashKind), search: v.optional(v.string()), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { kind, search, paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return { page: [], isDone: true, continueCursor: "" };
		const opts = { ...paginationOpts, numItems: Math.min(paginationOpts.numItems, PAGE_MAX) };
		const trash = ctx.db.query("trash");
		const result = search?.trim()
			? await trash
					.withSearchIndex("search", (q) => {
						const s = q.search("name", search).eq("workspaceId", member.workspaceId);
						return kind ? s.eq("kind", kind) : s;
					})
					.paginate(opts)
			: kind
				? await trash.withIndex("by_kind", (q) => q.eq("workspaceId", member.workspaceId).eq("kind", kind)).order("desc").paginate(opts)
				: await trash.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).order("desc").paginate(opts);
		const page = [];
		for (const e of result.page) {
			const type = e.typeId && (await ctx.db.get(e.typeId));
			page.push({
				_id: e._id,
				kind: e.kind,
				itemId: e.itemId,
				name: e.name,
				in: type ? type.plural : null,
				typeKey: type ? type.key : null,
				user: await nameOf(ctx, e.deletedBy),
				agent: e.agentId ? ((await ctx.db.get(e.agentId))?.name ?? null) : null,
				deletedAt: e.deletedAt,
				canRestore: canRestore(member, e),
			});
		}
		return { ...result, page };
	},
});

const item = { kind: trashKind, id: v.string() };

/** "Delete": moves it to Trash. */
export const move = mutation({
	args: item,
	handler: async (ctx, { kind, id }) => setTrashed(ctx, { member: await requireMember(ctx) }, kind, id, true),
});

/** Puts it back where it was, links included. */
export const restore = mutation({
	args: item,
	handler: async (ctx, { kind, id }) => setTrashed(ctx, { member: await requireMember(ctx) }, kind, id, false),
});

/** "Delete forever". */
export const purge = mutation({
	args: { id: v.string() },
	handler: async (ctx, { id }) => purgeItem(ctx, await requireMember(ctx), id),
});

/** Runs hourly (crons.ts): deletes for good what's been in Trash for TRASH_DAYS. */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const due = await ctx.db
			.query("trash")
			.withIndex("by_deleted", (q) => q.lt("deletedAt", Date.now() - TRASH_MS))
			.take(SWEEP_MAX);
		for (const entry of due) await deleteEntry(ctx, entry);
		if (due.length === SWEEP_MAX) await ctx.scheduler.runAfter(0, internal.trash.sweep, {});
	},
});
