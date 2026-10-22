import { canEditMemory } from "@companybot/core";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { getMember, memberArg, requireMember, toActor } from "./lib";
import { createMemory, listMemories, removeMemory, updateMemory } from "./memoryOps";

const scope = v.union(v.literal("workspace"), v.literal("personal"));

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const actor = toActor(member);
		return (await listMemories(ctx, member)).map((m) => ({ ...m, canEdit: canEditMemory(actor, m) }));
	},
});

export const create = mutation({
	args: { scope, content: v.string() },
	handler: async (ctx, { scope, content }) => createMemory(ctx, await requireMember(ctx), scope, content),
});

export const update = mutation({
	args: { id: v.id("memories"), content: v.string() },
	handler: async (ctx, { id, content }) => updateMemory(ctx, await requireMember(ctx), id, content),
});

export const remove = mutation({
	args: { id: v.id("memories") },
	handler: async (ctx, { id }) => removeMemory(ctx, await requireMember(ctx), id),
});

// Agent-facing versions: same rules, acting for the person the agent is helping.
export const listFor = internalQuery({
	args: { member: memberArg },
	handler: (ctx, { member }) => listMemories(ctx, member),
});

export const createFor = internalMutation({
	args: { member: memberArg, scope, content: v.string() },
	handler: (ctx, { member, scope, content }) => createMemory(ctx, member, scope, content),
});

export const updateFor = internalMutation({
	args: { member: memberArg, id: v.id("memories"), content: v.string() },
	handler: (ctx, { member, id, content }) => updateMemory(ctx, member, id, content),
});

export const removeFor = internalMutation({
	args: { member: memberArg, id: v.id("memories") },
	handler: (ctx, { member, id }) => removeMemory(ctx, member, id),
});
