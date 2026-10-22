import { type Memory, type MemoryScope, canCreateMemory, canEditMemory, canReadMemory } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, toActor } from "./lib";

// Shared by the app (public functions) and agents (internal functions), so both
// follow the same permission rules from @companybot/core.

export const toMemory = (d: Doc<"memories">): Memory => ({
	id: d._id,
	scope: d.scope,
	ownerId: d.ownerId,
	content: d.content,
	updatedAt: new Date(d.updatedAt).toISOString(),
	updatedBy: d.updatedBy,
});

export async function listMemories(ctx: QueryCtx, member: Member) {
	const docs = await ctx.db
		.query("memories")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.collect();
	const actor = toActor(member);
	return docs.map(toMemory).filter((m) => canReadMemory(actor, m));
}

export async function createMemory(ctx: MutationCtx, member: Member, scope: MemoryScope, content: string) {
	if (!canCreateMemory(toActor(member), scope)) throw new ConvexError("Only owners can add team memories.");
	const id = await ctx.db.insert("memories", {
		workspaceId: member.workspaceId,
		scope,
		ownerId: scope === "personal" ? member.userId : null,
		content: content.trim(),
		updatedAt: Date.now(),
		updatedBy: member.userId,
	});
	return toMemory((await ctx.db.get(id))!);
}

async function requireEditable(ctx: QueryCtx, member: Member, id: Id<"memories">) {
	const doc = await ctx.db.get(id);
	const actor = toActor(member);
	// Hide memories the person can't read, so their existence doesn't leak.
	if (!doc || doc.workspaceId !== member.workspaceId || !canReadMemory(actor, toMemory(doc))) {
		throw new ConvexError("Memory not found.");
	}
	if (!canEditMemory(actor, toMemory(doc))) throw new ConvexError("You can't change this memory.");
	return doc;
}

export async function updateMemory(ctx: MutationCtx, member: Member, id: Id<"memories">, content: string) {
	await requireEditable(ctx, member, id);
	await ctx.db.patch(id, { content: content.trim(), updatedAt: Date.now(), updatedBy: member.userId });
	return toMemory((await ctx.db.get(id))!);
}

export async function removeMemory(ctx: MutationCtx, member: Member, id: Id<"memories">) {
	await requireEditable(ctx, member, id);
	await ctx.db.delete(id);
}
