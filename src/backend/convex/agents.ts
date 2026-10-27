import {
	type AgentConfig,
	blankAgent,
	builtinTools,
	canUseTool,
	defaultAgents,
	describeToolAccess,
	findConnector,
	models,
	toolGroup,
	validateAgentConfig,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { checkVersion, getMember, namesOf, requireAgent, requirePermission, toActor } from "./lib";
import { connectorStates } from "./connectors";
import { agentConfig } from "./schema";

// Agents live in the database, one set per workspace. Owners edit them; every save
// is kept in agentVersions so changes can be reviewed and restored. Replies read the
// agent fresh at the start of each turn, so edits apply from the next reply.

function clean(config: AgentConfig): AgentConfig {
	const tidy = { ...config, name: config.name.trim(), description: config.description.trim() };
	const problem = validateAgentConfig(tidy);
	if (problem) throw new ConvexError(problem);
	// Sorted and deduped so versions compare cleanly.
	return { ...tidy, tools: [...new Set(tidy.tools)].sort() };
}

async function insertAgent(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">, config: AgentConfig) {
	const agentId = await ctx.db.insert("agents", {
		workspaceId,
		...config,
		archived: false,
		version: 1,
		updatedAt: Date.now(),
		updatedBy: userId,
	});
	await ctx.db.insert("agentVersions", { agentId, version: 1, config, savedBy: userId });
	return agentId;
}

/** Gives a new workspace its starting agents. */
export async function seedAgents(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
	for (const config of defaultAgents) await insertAgent(ctx, workspaceId, userId, config);
}

export async function saveVersion(ctx: MutationCtx, agent: Doc<"agents">, config: AgentConfig, userId: Id<"users">) {
	const version = agent.version + 1;
	await ctx.db.patch(agent._id, { ...config, version, updatedAt: Date.now(), updatedBy: userId });
	await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: userId });
}

/** Every agent in the workspace, oldest first, with which tools this person can use. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const agents = await ctx.db
			.query("agents")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		const names = await namesOf(
			ctx,
			agents.map((a) => a.updatedBy),
		);
		const connectors = await connectorStates(ctx, member);
		return agents.map((a) => ({
			...a,
			updatedByName: names.get(a.updatedBy) ?? "",
			access: describeToolAccess(a, toActor(member), connectors),
		}));
	},
});

/**
 * What owners can pick from when editing an agent: models, and tool groups. Each
 * group can be granted whole ("memory.*") or tool by tool. Installed connectors are
 * granted whole, since their tools come from the connector's server.
 */
export const options = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		const builtin = [...new Set(builtinTools.map((t) => toolGroup(t.id)))].map((group) => ({
			id: group,
			name: group.charAt(0).toUpperCase() + group.slice(1),
			connector: false,
			tools: builtinTools
				.filter((t) => toolGroup(t.id) === group)
				.map((t) => ({ id: t.id, description: t.description, ownersOnly: !canUseTool("member", t) })),
		}));
		const installed = member ? await connectorStates(ctx, member) : [];
		const connectors = installed.flatMap((state) => {
			const connector = findConnector(state.id);
			return connector ? [{ id: connector.id, name: connector.name, connector: true, tools: [] }] : [];
		});
		return { models, groups: [...builtin, ...connectors] };
	},
});

export const history = query({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		await requireAgent(ctx, member, agentId);
		const versions = await ctx.db
			.query("agentVersions")
			.withIndex("by_agent", (q) => q.eq("agentId", agentId))
			.order("desc")
			.take(50);
		const names = await namesOf(
			ctx,
			versions.map((v) => v.savedBy),
		);
		return versions.map((v) => ({
			version: v.version,
			config: v.config,
			savedAt: v._creationTime,
			savedByName: names.get(v.savedBy) ?? "",
		}));
	},
});

export const create = mutation({
	args: {},
	handler: async (ctx) => {
		const owner = await requirePermission(ctx, "agents.manage");
		return insertAgent(ctx, owner.workspaceId, owner.userId, blankAgent);
	},
});

export const update = mutation({
	args: { agentId: v.id("agents"), expectedVersion: v.number(), config: agentConfig },
	handler: async (ctx, { agentId, expectedVersion, config }) => {
		const owner = await requirePermission(ctx, "agents.manage");
		const agent = await requireAgent(ctx, owner, agentId);
		checkVersion(agent.version, expectedVersion);
		await saveVersion(ctx, agent, clean(config), owner.userId);
	},
});

/** Brings back an old version by saving it as the newest one. History is never rewritten. */
export const restore = mutation({
	args: { agentId: v.id("agents"), version: v.number(), expectedVersion: v.number() },
	handler: async (ctx, { agentId, version, expectedVersion }) => {
		const owner = await requirePermission(ctx, "agents.manage");
		const agent = await requireAgent(ctx, owner, agentId);
		checkVersion(agent.version, expectedVersion);
		const old = await ctx.db
			.query("agentVersions")
			.withIndex("by_agent", (q) => q.eq("agentId", agentId).eq("version", version))
			.first();
		if (!old) throw new ConvexError("That version doesn't exist.");
		await saveVersion(ctx, agent, clean(old.config), owner.userId);
	},
});

/** Archived agents leave the switcher but keep their chats and memories. */
export const setArchived = mutation({
	args: { agentId: v.id("agents"), archived: v.boolean() },
	handler: async (ctx, { agentId, archived }) => {
		const owner = await requirePermission(ctx, "agents.manage");
		const agent = await requireAgent(ctx, owner, agentId);
		if (archived) {
			const active = await ctx.db
				.query("agents")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", owner.workspaceId))
				.filter((q) => q.eq(q.field("archived"), false))
				.collect();
			if (active.length <= 1) throw new ConvexError("Keep at least one agent.");
		}
		await ctx.db.patch(agent._id, { archived });
	},
});
