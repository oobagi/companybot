import { canEditMemory } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, getMember, namesOf, requireAgent, requireMember, toActor } from "./lib";
import { createMemory, listMemories, memoryVersions, removeMemory, restoreMemoryVersion, searchMemories, updateMemory } from "./memoryOps";
import { memoryOn, personalMemoryHere, runningTurn } from "./turns";

const scope = v.union(v.literal("workspace"), v.literal("personal"));

/** Every memory the person can see, across all agents. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const actor = toActor(member);
		const memories = await listMemories(ctx, member);
		const names = await namesOf(ctx, memories.flatMap((m) => [m.updatedBy, m.createdBy] as Id<"users">[]));
		return memories.map((m) => ({
			...m,
			canEdit: canEditMemory(actor, m),
			updatedByName: names.get(m.updatedBy as Id<"users">) ?? "",
			createdByName: names.get(m.createdBy as Id<"users">) ?? "",
		}));
	},
});

export const create = mutation({
	args: { agentId: v.id("agents"), scope, content: v.string() },
	handler: async (ctx, { agentId, scope, content }) =>
		createMemory(ctx, { member: await requireMember(ctx) }, agentId, scope, content),
});

export const update = mutation({
	args: { id: v.id("memories"), content: v.string(), expectedVersion: v.number() },
	handler: async (ctx, { id, content, expectedVersion }) =>
		updateMemory(ctx, { member: await requireMember(ctx) }, id, content, expectedVersion),
});

/** Team memories go to Trash; personal ones are deleted. */
export const remove = mutation({
	args: { id: v.id("memories") },
	handler: async (ctx, { id }) => removeMemory(ctx, { member: await requireMember(ctx) }, id),
});

/** What a memory said before each edit, newest first, with who saved it. */
export const versions = query({
	args: { id: v.id("memories") },
	handler: async (ctx, { id }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const versions = await memoryVersions(ctx, member, id);
		const names = await namesOf(ctx, versions.map((v) => v.savedBy));
		return versions.map((v) => ({ _id: v._id, content: v.content, savedAt: v.savedAt, savedByAgent: !!v.savedByAgent, savedByName: names.get(v.savedBy) ?? "" }));
	},
});

/** Puts an old version back, as a new edit. `expectedVersion`: the memory's version the person was looking at. */
export const restoreVersion = mutation({
	args: { versionId: v.id("memoryVersions"), expectedVersion: v.number() },
	handler: async (ctx, { versionId, expectedVersion }) =>
		restoreMemoryVersion(ctx, { member: await requireMember(ctx) }, versionId, expectedVersion),
});

// Agent-facing versions: same rules, acting for the turn's person. runningTurn re-checks
// on every call that the turn is still running, the person is still a member (with their
// role now) and can still see the chat, so removals and role changes apply mid-reply.

const SHARED_CHAT = "2+ people can read this chat, so personal memories can't be read or changed here. You can still save a new one for the person who asked.";
const MEMORY_OFF = "An owner turned memory off for this workspace. Don't search or save memories.";

/** The turn's person and agent, refusing memory use when off (read fresh on every call). */
async function acting(ctx: QueryCtx, turnId: Id<"agentTurns">, target?: Id<"agents">) {
	const { turn, chat, who } = await runningTurn(ctx, turnId);
	if (!(await memoryOn(ctx, turn.workspaceId))) throw new ConvexError(MEMORY_OFF);
	if (target) await requireAgent(ctx, who.member, target);
	return { who, agentId: target ?? turn.agentId, personal: await personalMemoryHere(ctx, chat) };
}

/** A memory in this workspace, refusing personal ones in shared chats. */
async function requireChatMemory(ctx: QueryCtx, id: Id<"memories">, member: Member, personal: boolean) {
	const memory = await ctx.db.get(id);
	if (memory?.workspaceId !== member.workspaceId) throw new ConvexError("Memory not found.");
	if (!personal && memory.scope === "personal") throw new ConvexError(SHARED_CHAT);
}

export const searchFor = internalQuery({
	args: { turnId: v.id("agentTurns"), query: v.string(), agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { turnId, query, agentId: target }) => {
		const { who, agentId, personal } = await acting(ctx, turnId, target);
		return searchMemories(ctx, who.member, agentId, { query, personal });
	},
});

export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), scope, content: v.string(), agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { turnId, scope, content, agentId: target }) => {
		// Personal saves work in shared chats too: they go only to the person who asked, and what's
		// saved was already said here, so nothing private leaks. Reading stays DM-only.
		const { who, agentId } = await acting(ctx, turnId, target);
		return createMemory(ctx, who, agentId, scope, content);
	},
});

export const updateFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.id("memories"), content: v.string() },
	handler: async (ctx, { turnId, id, content }) => {
		const { who, personal } = await acting(ctx, turnId);
		await requireChatMemory(ctx, id, who.member, personal);
		return updateMemory(ctx, who, id, content);
	},
});

export const removeFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.id("memories") },
	handler: async (ctx, { turnId, id }) => {
		const { who, personal } = await acting(ctx, turnId);
		await requireChatMemory(ctx, id, who.member, personal);
		await removeMemory(ctx, who, id);
	},
});
