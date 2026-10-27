import {
	type Memory,
	type MemoryScope,
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
import { putInTrash, takeFromTrash, trashEntry } from "./trashOps";

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
	createdBy: d.createdBy ?? d.updatedBy,
	...(d.updatedByAgent && { updatedByAgent: true }),
	version: d.version,
});

/** Every memory the person can see, across all agents. For the app. */
export async function listMemories(ctx: QueryCtx, member: Member) {
	const docs = await ctx.db
		.query("memories")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("archived", undefined))
		.collect();
	const actor = toActor(member);
	return docs.map(toMemory).filter((m) => canReadMemory(actor, m));
}

/** Most memories one agent search returns. */
export const MEMORY_RESULTS_MAX = 50;

/**
 * One agent's memories the person can see, oldest first. With a query, the best matches
 * from the whole history (search index: words, the last one as a prefix), keeping those
 * holding every word (core `memoryMatches`); without one, the newest. At most
 * MEMORY_RESULTS_MAX either way. `personal`: false in chats with 2+ people, so only team
 * memories are read; true adds the person's own, never anyone else's (owners included).
 */
export async function searchMemories(ctx: QueryCtx, member: Member, agentId: Id<"agents">, { query, personal }: { query: string; personal: boolean }) {
	const actor = toActor(member);
	const text = query.trim();
	const read = (scope: MemoryScope, ownerId?: Id<"users">) =>
		text
			? ctx.db
					.query("memories")
					.withSearchIndex("search_content", (q) => {
						const s = q.search("content", text).eq("agentId", agentId).eq("scope", scope).eq("archived", undefined);
						return ownerId ? s.eq("ownerId", ownerId) : s;
					})
					.take(MEMORY_RESULTS_MAX)
			: ownerId
				? ctx.db
						.query("memories")
						.withIndex("by_agent_owner", (q) => q.eq("agentId", agentId).eq("scope", scope).eq("ownerId", ownerId))
						.order("desc")
						.take(MEMORY_RESULTS_MAX)
				: ctx.db
						.query("memories")
						.withIndex("by_agent_scope", (q) => q.eq("agentId", agentId).eq("scope", scope).eq("archived", undefined))
						.order("desc")
						.take(MEMORY_RESULTS_MAX);
	const docs = await read("workspace");
	if (personal) docs.push(...(await read("personal", member.userId)));
	return docs
		.filter((d) => d.workspaceId === member.workspaceId && memoryMatches(d.content, text))
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
		createdBy: member.userId,
		version: 1,
	});
	return toMemory((await ctx.db.get(id))!);
}

/** A memory the person can read, not in Trash. Others look like they don't exist. */
export async function requireReadable(ctx: QueryCtx, member: Member, id: Id<"memories">) {
	const doc = await ctx.db.get(id);
	if (!doc || doc.workspaceId !== member.workspaceId || doc.archived || !canReadMemory(toActor(member), toMemory(doc))) {
		throw new ConvexError("Memory not found.");
	}
	return doc;
}

async function requireEditable(ctx: QueryCtx, member: Member, id: Id<"memories">) {
	const doc = await requireReadable(ctx, member, id);
	if (!canEditMemory(toActor(member), toMemory(doc))) throw new ConvexError("You can't change this memory.");
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
	if (content.trim() === doc.content) return toMemory(doc);
	await keepVersion(ctx, doc);
	await ctx.db.patch(id, {
		content: content.trim(),
		updatedAt: Date.now(),
		updatedBy: member.userId,
		updatedByAgent: byAgent ? true : undefined,
		version: doc.version + 1,
	});
	return toMemory((await ctx.db.get(id))!);
}

/** Old versions kept per memory. */
export const MEMORY_VERSIONS_MAX = 20;

/** Saves what the memory says now as a version, before it changes, dropping the one that falls past the cap. */
async function keepVersion(ctx: MutationCtx, doc: Doc<"memories">) {
	await ctx.db.insert("memoryVersions", {
		memoryId: doc._id,
		version: doc.version,
		content: doc.content,
		savedBy: doc.updatedBy,
		...(doc.updatedByAgent && { savedByAgent: true }),
		savedAt: doc.updatedAt,
	});
	// Versions go up by one per edit, so this is the one oldest, without reading the rest.
	const old = await ctx.db
		.query("memoryVersions")
		.withIndex("by_memory", (q) => q.eq("memoryId", doc._id).lte("version", doc.version - MEMORY_VERSIONS_MAX))
		.take(10);
	for (const row of old) await ctx.db.delete(row._id);
}

/** A memory's old versions, newest first. None once the memory is gone or out of reach. */
export async function memoryVersions(ctx: QueryCtx, member: Member, id: Id<"memories">) {
	const doc = await ctx.db.get(id);
	if (!doc || doc.workspaceId !== member.workspaceId || doc.archived || !canReadMemory(toActor(member), toMemory(doc))) return [];
	return ctx.db
		.query("memoryVersions")
		.withIndex("by_memory", (q) => q.eq("memoryId", id))
		.order("desc")
		.take(MEMORY_VERSIONS_MAX);
}

/** Puts an old version back, as a new edit (so it can be undone too). */
export async function restoreMemoryVersion(ctx: MutationCtx, who: Who, versionId: Id<"memoryVersions">, expectedVersion: number) {
	const version = await ctx.db.get(versionId);
	if (!version) throw new ConvexError("That version is gone.");
	return updateMemory(ctx, who, version.memoryId, version.content, expectedVersion);
}

/** Team memories go to Trash, so any member can undo a delete. Personal ones are theirs alone and go for good. */
export async function removeMemory(ctx: MutationCtx, who: Who, id: Id<"memories">) {
	const doc = await requireEditable(ctx, who.member, id);
	if (doc.scope === "personal") return deleteMemory(ctx, doc._id);
	await ctx.db.patch(id, { archived: true });
	await putInTrash(ctx, who, { kind: "memory", id, name: doc.content.slice(0, 120) });
}

/** Out of Trash, for anyone who could delete it (trashOps.canRestore). */
export async function setMemoryTrashed(ctx: MutationCtx, who: Who, id: Id<"memories">, trashed: boolean) {
	if (trashed) return removeMemory(ctx, who, id);
	const doc = await ctx.db.get(id);
	if (!doc || doc.workspaceId !== who.member.workspaceId) throw new ConvexError("It's no longer in Trash.");
	await takeFromTrash(ctx, who, id);
	await ctx.db.patch(id, { archived: undefined });
}

/** Deletes a memory for good, with its versions (at most MEMORY_VERSIONS_MAX, kept so by `keepVersion`). */
export async function deleteMemory(ctx: MutationCtx, id: Id<"memories">) {
	for (const v of await ctx.db
		.query("memoryVersions")
		.withIndex("by_memory", (q) => q.eq("memoryId", id))
		.take(MEMORY_VERSIONS_MAX))
		await ctx.db.delete(v._id);
	if (await ctx.db.get(id)) await ctx.db.delete(id);
}

/** A memory deleted by a cascade (its agent's) takes its Trash entry, if it's in Trash. */
export async function forgetTrashEntry(ctx: MutationCtx, row: Doc<"memories">) {
	const entry = row.archived && (await trashEntry(ctx, row._id));
	if (entry) await ctx.db.delete(entry._id);
}
