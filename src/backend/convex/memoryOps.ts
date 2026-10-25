import {
	type Memory,
	type MemoryScope,
	can,
	canCreateMemory,
	canEditMemory,
	canReadMemory,
	deniedMessage,
	memoryMatches,
} from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, checkVersion, requireAgent, toActor } from "./lib";

// Shared by the app (public functions) and agents (internal functions), so both
// follow the same permission rules from @companybot/core.

export const toMemory = (d: Doc<"memories">): Memory => ({
	id: d._id,
	agentId: d.agentId,
	scope: d.scope,
	ownerId: d.ownerId,
	content: d.content,
	updatedAt: new Date(d.updatedAt).toISOString(),
	updatedBy: d.updatedBy,
	...(d.updatedByAgent && { updatedByAgent: true }),
	version: d.version,
});

/** Every memory the person can see, across all agents. For the app. */
export async function listMemories(ctx: QueryCtx, member: Member) {
	const docs = await ctx.db
		.query("memories")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.collect();
	const actor = toActor(member);
	return docs.map(toMemory).filter((m) => canReadMemory(actor, m));
}

/** Most memories one agent search reads per scope (the newest), so it stays bounded however many there are. */
export const MEMORY_SCAN_MAX = 500;
/** Most it returns. */
export const MEMORY_RESULTS_MAX = 50;

/**
 * One agent's memories the person can see that match `query` (core `memoryMatches`), oldest
 * first. `personal`: false in chats with 2+ people, so only team memories are read.
 */
export async function searchMemories(ctx: QueryCtx, member: Member, agentId: Id<"agents">, { query, personal }: { query: string; personal: boolean }) {
	const newest = (scope: MemoryScope, ownerId?: Id<"users">) =>
		ctx.db
			.query("memories")
			.withIndex("by_agent_scope", (q) => (ownerId ? q.eq("agentId", agentId).eq("scope", scope).eq("ownerId", ownerId) : q.eq("agentId", agentId).eq("scope", scope)))
			.order("desc")
			.take(MEMORY_SCAN_MAX);
	const actor = toActor(member);
	const docs = await newest("workspace");
	// "memory.all.read" reads everyone's personal memories, as in the app.
	if (personal) docs.push(...(await newest("personal", can(actor, "memory.all.read") ? undefined : member.userId)));
	return docs
		.filter((d) => d.workspaceId === member.workspaceId && memoryMatches(d.content, query))
		.sort((a, b) => a._creationTime - b._creationTime)
		.slice(-MEMORY_RESULTS_MAX)
		.map(toMemory)
		.filter((m) => canReadMemory(actor, m));
}

export async function createMemory(ctx: MutationCtx, { member, agentId: byAgent }: Who, agentId: Id<"agents">, scope: MemoryScope, content: string) {
	if (!canCreateMemory(toActor(member), scope)) throw new ConvexError(deniedMessage("memory.team.write"));
	await requireAgent(ctx, member, agentId);
	if (!content.trim()) throw new ConvexError("Memory can't be empty.");
	const id = await ctx.db.insert("memories", {
		workspaceId: member.workspaceId,
		agentId,
		scope,
		ownerId: scope === "personal" ? member.userId : null,
		content: content.trim(),
		updatedAt: Date.now(),
		updatedBy: member.userId,
		...(byAgent && { updatedByAgent: true }),
		version: 1,
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

/**
 * `expectedVersion` comes from the app's edit form. Agents edit the latest, so they
 * skip it; the change is marked as theirs.
 */
export async function updateMemory(ctx: MutationCtx, { member, agentId: byAgent }: Who, id: Id<"memories">, content: string, expectedVersion?: number) {
	const doc = await requireEditable(ctx, member, id);
	if (expectedVersion !== undefined) checkVersion(doc.version, expectedVersion);
	if (!content.trim()) throw new ConvexError("Memory can't be empty.");
	await ctx.db.patch(id, {
		content: content.trim(),
		updatedAt: Date.now(),
		updatedBy: member.userId,
		updatedByAgent: byAgent ? true : undefined,
		version: doc.version + 1,
	});
	return toMemory((await ctx.db.get(id))!);
}

export async function removeMemory(ctx: MutationCtx, { member }: Who, id: Id<"memories">) {
	await requireEditable(ctx, member, id);
	await ctx.db.delete(id);
}
