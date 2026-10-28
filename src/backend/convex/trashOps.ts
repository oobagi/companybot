import { type TrashKind, canTrash } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, nameOf, toActor } from "./lib";

// Trash: what people deleted, until it's restored or deleted for good. Each kind's own rules
// (recordOps, pageOps, chatOps, agents, skills, automations, memoryOps) move its items in and out through here; trash.ts lists and
// deletes for good. See wiki/data.md#trash.

/** Days an item stays in Trash before `trash.sweep` deletes it for good. */
export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 24 * 60 * 60_000;

export type { TrashKind };

/** An item's Trash row. Ids are unique across tables, so the id alone finds it. */
export const trashEntry = (ctx: QueryCtx, itemId: string) =>
	ctx.db
		.query("trash")
		.withIndex("by_item", (q) => q.eq("itemId", itemId))
		.first();

/** Adds an item to Trash, deleted by `who` now. The caller marks the item itself `archived`. */
export async function putInTrash(ctx: MutationCtx, who: Who, item: { kind: TrashKind; id: string; name: string; includesSubpages?: boolean; typeId?: Doc<"trash">["typeId"] }) {
	await ctx.db.insert("trash", {
		workspaceId: who.member.workspaceId,
		kind: item.kind,
		itemId: item.id,
		name: item.name,
		...(item.includesSubpages && { includesSubpages: true }),
		...(item.typeId && { typeId: item.typeId }),
		deletedBy: who.member.userId,
		...(who.agentId && { agentId: who.agentId }),
		deletedAt: Date.now(),
	});
}

type TrashItem = Parameters<typeof putInTrash>[2];

/** Puts an item in Trash (`archived`) or takes it out, as `who`. The caller patches the item. */
export const toggleTrash = (ctx: MutationCtx, who: Who, archived: boolean, item: TrashItem) =>
	archived ? putInTrash(ctx, who, item) : takeFromTrash(ctx, who, item.id);

/** Anyone who could delete it can restore it, whoever deleted it (core `canTrash`). */
export async function canRestore(ctx: QueryCtx, member: Member, entry: Doc<"trash">) {
	return canTrash(toActor(member), entry.kind, await madeBy(ctx, entry));
}

/** Who made a trashed item, for kinds whose makers manage their own. */
async function madeBy(ctx: QueryCtx, entry: Doc<"trash">) {
	const get = async <T extends "recordFields" | "chats" | "skillInstalls" | "automationInstalls">(table: T) => {
		const id = ctx.db.normalizeId(table, entry.itemId);
		return id ? await ctx.db.get(id) : null;
	};
	if (entry.kind === "field") return (await get("recordFields"))?.createdBy;
	if (entry.kind === "channel") return (await get("chats"))?.createdBy;
	if (entry.kind === "skill") return (await get("skillInstalls"))?.custom?.createdBy;
	if (entry.kind === "automation") {
		const install = await get("automationInstalls");
		return install?.custom ? install.installedBy : undefined;
	}
}

/** Takes an item out of Trash. Refused unless they can restore it, or once it's being deleted for good. */
export async function takeFromTrash(ctx: MutationCtx, { member }: Who, itemId: string) {
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId) throw new ConvexError("It's no longer in Trash.");
	if (!(await canRestore(ctx, member, entry))) throw new ConvexError("You can't restore this: it takes the same access as deleting it.");
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
		hasChildren: entry.includesSubpages === true,
		kind: entry.kind,
		itemId: entry.itemId,
		name: entry.name,
		user: await nameOf(ctx, entry.deletedBy),
		agent: entry.agentId ? ((await ctx.db.get(entry.agentId))?.name ?? null) : null,
		at: entry.deletedAt,
		canRestore: await canRestore(ctx, member, entry),
	};
}
