import { can } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, nameOf } from "./lib";

// Trash: what people deleted, until it's restored or deleted for good. Each kind's own rules
// (recordOps, pageOps, chatOps) move its items in and out through here; trash.ts lists and
// deletes for good. See wiki/data.md#trash.

/** Days an item stays in Trash before `trash.sweep` deletes it for good. */
export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 24 * 60 * 60_000;

export type TrashKind = Doc<"trash">["kind"];

/** An item's Trash row. Ids are unique across tables, so the id alone finds it. */
export const trashEntry = (ctx: QueryCtx, itemId: string) =>
	ctx.db
		.query("trash")
		.withIndex("by_item", (q) => q.eq("itemId", itemId))
		.first();

/** Adds an item to Trash, deleted by `who` now. The caller marks the item itself `archived`. */
export async function putInTrash(ctx: MutationCtx, who: Who, item: { kind: TrashKind; id: string; name: string; typeId?: Doc<"trash">["typeId"] }) {
	await ctx.db.insert("trash", {
		workspaceId: who.member.workspaceId,
		kind: item.kind,
		itemId: item.id,
		name: item.name,
		...(item.typeId && { typeId: item.typeId }),
		deletedBy: who.member.userId,
		...(who.agentId && { agentId: who.agentId }),
		deletedAt: Date.now(),
	});
}

/** Whoever deleted it, or an owner, can restore it. */
export const canRestore = (member: Member, entry: Doc<"trash">) => entry.deletedBy === member.userId || can(member.role, "trash.manage");

/** Takes an item out of Trash. Refused unless they can restore it, or once it's being deleted for good. */
export async function takeFromTrash(ctx: MutationCtx, { member }: Who, itemId: string) {
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId) throw new ConvexError("It's no longer in Trash.");
	if (!canRestore(member, entry)) throw new ConvexError(`Only ${await nameOf(ctx, entry.deletedBy)}, who deleted it, or an owner can restore it.`);
	await ctx.db.delete(entry._id);
}

/** Who deleted an item and when, for its own screen. Null unless it's in Trash. */
export async function trashInfo(ctx: QueryCtx, member: Member, itemId: string) {
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId) return null;
	return describeTrash(ctx, member, entry);
}

/** Shared attribution for the list and item banners; nameOf handles names, email and erased accounts. */
export async function describeTrash(ctx: QueryCtx, member: Member, entry: Doc<"trash">) {
	return {
		kind: entry.kind,
		itemId: entry.itemId,
		name: entry.name,
		user: await nameOf(ctx, entry.deletedBy),
		agent: entry.agentId ? ((await ctx.db.get(entry.agentId))?.name ?? null) : null,
		at: entry.deletedAt,
		canRestore: canRestore(member, entry),
	};
}
