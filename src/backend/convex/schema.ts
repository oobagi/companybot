import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const role = v.union(v.literal("owner"), v.literal("member"));

export const agentConfig = v.object({
	name: v.string(),
	description: v.string(),
	instructions: v.string(),
	model: v.string(),
	tools: v.array(v.string()),
});

// Shared settings carry a `version` that goes up on every save. A save sends the
// version it started from; if someone saved in between, it's refused as a conflict.

export default defineSchema({
	...authTables,

	workspaces: defineTable({ name: v.string(), version: v.optional(v.number()) }),

	members: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		role,
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"]),

	invites: defineTable({
		workspaceId: v.id("workspaces"),
		email: v.string(),
		role,
	})
		.index("by_email", ["email"])
		.index("by_workspace", ["workspaceId"]),

	// Each workspace has its own agents. Every save also writes an agentVersions row.
	agents: defineTable({
		workspaceId: v.id("workspaces"),
		...agentConfig.fields,
		archived: v.boolean(),
		version: v.number(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
	}).index("by_workspace", ["workspaceId"]),

	agentVersions: defineTable({
		agentId: v.id("agents"),
		version: v.number(),
		config: agentConfig,
		savedBy: v.id("users"),
	}).index("by_agent", ["agentId", "version"]),

	memories: defineTable({
		workspaceId: v.id("workspaces"),
		agentId: v.id("agents"),
		scope: v.union(v.literal("workspace"), v.literal("personal")),
		ownerId: v.union(v.id("users"), v.null()),
		content: v.string(),
		updatedAt: v.number(),
		updatedBy: v.id("users"),
		version: v.number(),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_agent", ["agentId"]),

	// Personal preferences: only the person sees them; they follow them across devices.
	preferences: defineTable({
		userId: v.id("users"),
		/** What agents and teammates call you. */
		displayName: v.string(),
		sendWith: v.union(v.literal("enter"), v.literal("mod-enter")),
	}).index("by_user", ["userId"]),

	pluginInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		pluginId: v.string(),
	}).index("by_workspace", ["workspaceId", "pluginId"]),

	skillInstalls: defineTable({
		workspaceId: v.id("workspaces"),
		skillId: v.string(),
	}).index("by_workspace", ["workspaceId", "skillId"]),

	// One continuous conversation per person per agent.
	conversations: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		agentId: v.id("agents"),
		/** True while the agent is replying. Blocks overlapping turns. */
		busy: v.boolean(),
		/** Running summary of messages older than `summarizedUpTo`. */
		summary: v.optional(v.string()),
		summarizedUpTo: v.optional(v.number()),
	}).index("by_user_agent", ["userId", "agentId"]),

	messages: defineTable({
		conversationId: v.id("conversations"),
		role: v.union(v.literal("user"), v.literal("assistant")),
		text: v.string(),
		tools: v.array(
			v.object({
				id: v.string(),
				name: v.string(),
				status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
			}),
		),
		status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
		error: v.optional(v.string()),
	}).index("by_conversation", ["conversationId"]),
});
