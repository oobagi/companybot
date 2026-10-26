import { canEditMemory } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { mutation, query } from "./functions";
import { getMember, namesOf, requireMember, toActor } from "./lib";
import { createMemory, forgetPersonalMemories, listMemories, removeMemory, searchMemories, updateMemory } from "./memoryOps";
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
		const names = await namesOf(
			ctx,
			memories.map((m) => m.updatedBy as Id<"users">),
		);
		return memories.map((m) => ({
			...m,
			canEdit: canEditMemory(actor, m),
			updatedByName: names.get(m.updatedBy as Id<"users">) ?? "",
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

export const remove = mutation({
	args: { id: v.id("memories") },
	handler: async (ctx, { id }) => removeMemory(ctx, { member: await requireMember(ctx) }, id),
});

export const forgetForRemovedMember = internalMutation({
	args: { workspaceId: v.id("workspaces"), userId: v.id("users"), before: v.int64() },
	handler: (ctx, { workspaceId, userId, before }) => forgetPersonalMemories(ctx, workspaceId, userId, before),
});

// Agent-facing versions: same rules, acting for the turn's person. runningTurn re-checks
// on every call that the turn is still running, the person is still a member (with their
// role now) and can still see the chat, so removals and role changes apply mid-reply.

const SHARED_CHAT = "Personal memories are off in chats with 2+ people. Only team memories work here.";
const MEMORY_OFF = "An owner turned memory off for this workspace. Don't search or save memories.";

/** The turn's person and agent, refusing memory use when off (read fresh on every call). */
async function acting(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const { turn, chat, who } = await runningTurn(ctx, turnId);
	if (!(await memoryOn(ctx, turn.workspaceId))) throw new ConvexError(MEMORY_OFF);
	return { who, agentId: turn.agentId, personal: await personalMemoryHere(ctx, chat) };
}

/** One of this agent's memories, refusing personal ones in shared chats. */
async function requireOwnMemory(ctx: QueryCtx, id: Id<"memories">, agentId: Id<"agents">, personal: boolean) {
	const memory = await ctx.db.get(id);
	if (memory?.agentId !== agentId) throw new ConvexError("Memory not found.");
	if (!personal && memory.scope === "personal") throw new ConvexError(SHARED_CHAT);
}

export const searchFor = internalQuery({
	args: { turnId: v.id("agentTurns"), query: v.string() },
	handler: async (ctx, { turnId, query }) => {
		const { who, agentId, personal } = await acting(ctx, turnId);
		return searchMemories(ctx, who.member, agentId, { query, personal });
	},
});

export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), scope, content: v.string() },
	handler: async (ctx, { turnId, scope, content }) => {
		const { who, agentId, personal } = await acting(ctx, turnId);
		if (!personal && scope === "personal") throw new ConvexError(SHARED_CHAT);
		return createMemory(ctx, who, agentId, scope, content);
	},
});

export const updateFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.id("memories"), content: v.string() },
	handler: async (ctx, { turnId, id, content }) => {
		const { who, agentId, personal } = await acting(ctx, turnId);
		await requireOwnMemory(ctx, id, agentId, personal);
		return updateMemory(ctx, who, id, content);
	},
});

export const removeFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.id("memories") },
	handler: async (ctx, { turnId, id }) => {
		const { who, agentId, personal } = await acting(ctx, turnId);
		await requireOwnMemory(ctx, id, agentId, personal);
		await removeMemory(ctx, who, id);
	},
});
