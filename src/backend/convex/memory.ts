import { canEditMemory } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getMember, memberOf, namesOf, requireMember, toActor } from "./lib";
import { createMemory, listMemories, removeMemory, updateMemory } from "./memoryOps";

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
		createMemory(ctx, await requireMember(ctx), agentId, scope, content),
});

export const update = mutation({
	args: { id: v.id("memories"), content: v.string(), expectedVersion: v.number() },
	handler: async (ctx, { id, content, expectedVersion }) =>
		updateMemory(ctx, await requireMember(ctx), id, content, expectedVersion),
});

export const remove = mutation({
	args: { id: v.id("memories") },
	handler: async (ctx, { id }) => removeMemory(ctx, await requireMember(ctx), id),
});

// Agent-facing versions: same rules, acting for the person the agent is helping.
// Membership is read fresh on every call, so a removed person's agent loses access at once.

async function actingFor(ctx: QueryCtx, userId: Id<"users">) {
	const member = await memberOf(ctx, userId);
	if (!member) throw new ConvexError("This person is no longer in the workspace.");
	return member;
}

const forArgs = {
	userId: v.id("users"),
	agentId: v.id("agents"),
	/** Set in chats with 2+ people: only team memories, so personal facts never land in a shared chat. */
	teamOnly: v.optional(v.boolean()),
};

const SHARED_CHAT = "Personal memories are off in chats with 2+ people. Only team memories work here.";

/** Refuses personal memories in shared chats. */
async function requireTeamMemory(ctx: QueryCtx, id: Id<"memories">, teamOnly?: boolean) {
	if (teamOnly && (await ctx.db.get(id))?.scope === "personal") throw new ConvexError(SHARED_CHAT);
}

export const listFor = internalQuery({
	args: forArgs,
	handler: async (ctx, { userId, agentId, teamOnly }) => {
		const memories = await listMemories(ctx, await actingFor(ctx, userId), agentId);
		return teamOnly ? memories.filter((m) => m.scope === "workspace") : memories;
	},
});

export const createFor = internalMutation({
	args: { ...forArgs, scope, content: v.string() },
	handler: async (ctx, { userId, agentId, teamOnly, scope, content }) => {
		if (teamOnly && scope === "personal") throw new ConvexError(SHARED_CHAT);
		return createMemory(ctx, await actingFor(ctx, userId), agentId, scope, content);
	},
});

export const updateFor = internalMutation({
	args: { ...forArgs, id: v.id("memories"), content: v.string() },
	handler: async (ctx, { userId, agentId, teamOnly, id, content }) => {
		const memory = await ctx.db.get(id);
		if (memory?.agentId !== agentId) throw new ConvexError("Memory not found.");
		await requireTeamMemory(ctx, id, teamOnly);
		return updateMemory(ctx, await actingFor(ctx, userId), id, content);
	},
});

export const removeFor = internalMutation({
	args: { ...forArgs, id: v.id("memories") },
	handler: async (ctx, { userId, agentId, teamOnly, id }) => {
		const memory = await ctx.db.get(id);
		if (memory?.agentId !== agentId) throw new ConvexError("Memory not found.");
		await requireTeamMemory(ctx, id, teamOnly);
		await removeMemory(ctx, await actingFor(ctx, userId), id);
	},
});
