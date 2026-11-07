import { type TrashKind, canTrash } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, type Writer, nameOf } from "./lib";
import { outsiderWords } from "@companybot/core";
import { privateTo } from "./automationOps";
import { releaseHeld } from "./wakeups";

// Trash: what people deleted, until it's restored or deleted for good. Each kind's own rules
// (recordOps, pageOps, chatOps, agents, skills, automations, memoryOps) move its items in and out through here; trash.ts lists and
// deletes for good. See wiki/data.md#trash.

export type { TrashKind };

/** An item's Trash row. Ids are unique across tables, so the id alone finds it. */
export const trashEntry = (ctx: QueryCtx, itemId: string) =>
	ctx.db
		.query("trash")
		.withIndex("by_item", (q) => q.eq("itemId", itemId))
		.first();

/** Adds an item to Archive, deleted by `who` now (a member, or someone outside archiving their own record). The caller marks the item itself `archived`. */
export async function putInTrash(ctx: MutationCtx, who: Writer, item: { kind: TrashKind; id: string; name: string; includesSubpages?: boolean; typeId?: Doc<"trash">["typeId"] }) {
	const by = "outsider" in who
		? { workspaceId: who.outsider.workspaceId, contact: who.outsider.contact, agentId: who.outsider.agentId }
		: { workspaceId: who.member.workspaceId, deletedBy: who.member.userId, ...(who.agentId && { agentId: who.agentId }) };
	await ctx.db.insert("trash", {
		...by,
		kind: item.kind,
		itemId: item.id,
		name: item.name,
		...(item.includesSubpages && { includesSubpages: true }),
		...(item.typeId && { typeId: item.typeId }),
		deletedAt: Date.now(),
	});
}

type TrashItem = Parameters<typeof putInTrash>[2];

/** Puts an item in Archive (`archived`) or takes it out, as `who`. The caller patches the item. Only members restore. */
export const toggleTrash = (ctx: MutationCtx, who: Writer, archived: boolean, item: TrashItem) =>
	archived ? putInTrash(ctx, who, item) : "outsider" in who ? Promise.reject(new ConvexError("Only staff can restore it.")) : takeFromTrash(ctx, who, item.id);

/** Anyone who could delete it can restore it, whoever deleted it (core `canTrash`). */
export async function canRestore(ctx: QueryCtx, member: Member, entry: Doc<"trash">) {
	return canTrash(member, entry.kind, entry.kind === "skill" ? await skillOwner(ctx, entry) : entry.kind === "automation" ? await personalTo(ctx, entry) : null);
}

async function skillOwner(ctx: QueryCtx, entry: Doc<"trash">) {
	const id = ctx.db.normalizeId("skillInstalls", entry.itemId);
	const install = id && await ctx.db.get(id);
	return install?.audience === "personal" ? install.ownerId : null;
}

/** Who a trashed personal automation belongs to: only they can see it, so only they can restore it. */
async function personalTo(ctx: QueryCtx, entry: Doc<"trash">) {
	const id = ctx.db.normalizeId("automationInstalls", entry.itemId);
	const install = id && (await ctx.db.get(id));
	return install ? privateTo(install) : null;
}

/** Takes an item out of Trash. Refused unless they can restore it, or once it's being deleted for good. */
export async function takeFromTrash(ctx: MutationCtx, { member }: Who, itemId: string) {
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId) throw new ConvexError("It's no longer in Archive.");
	if (!(await canRestore(ctx, member, entry))) throw new ConvexError("You can't restore this: it takes the same access as deleting it.");
	await ctx.db.delete(entry._id);
	// Wakeups held while their agent, chat or record was here try again.
	await releaseHeld(ctx, member.workspaceId);
}

/** Who deleted an item and when, for its own screen. Null unless it's in Archive. */
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
		user: entry.deletedBy ? await nameOf(ctx, entry.deletedBy) : entry.contact ? outsiderWords(entry.contact) : "Someone",
		agent: entry.agentId ? ((await ctx.db.get(entry.agentId))?.name ?? null) : null,
		at: entry.deletedAt,
		canRestore: await canRestore(ctx, member, entry),
	};
}
