import {
	type AgentConfig,
	blankAgent,
	builtinTools,
	canUseTool,
	defaultAgents,
	describeToolAccess,
	defaultModel,
	findConnector,
	toolGroup,
	validateAgentConfig,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, type Who, checkPermission, checkVersion, getMember, namesOf, requireAgent, requireLiveAgent, requirePermission, toActor } from "./lib";
import { connectorStates } from "./connectors";
import { imageUrl } from "./images";
import { allowedModels, catalogModels } from "./modelCatalog";
import { agentConfig } from "./schema";
import { toggleTrash, trashInfo } from "./trashOps";

// Agents live in the database, one set per workspace. Owners edit them; every save
// is kept in agentVersions so changes can be reviewed and restored. Replies read the
// agent fresh at the start of each turn, so edits apply from the next reply.

async function clean(ctx: MutationCtx, agent: Doc<"agents">, config: AgentConfig): Promise<AgentConfig> {
	// Night Owl's connector is retired: drop its grants so agents (and versions from before) still save and restore. Not COMPAT: old versions keep them forever.
	const tidy = { ...config, name: config.name.trim(), description: config.description.trim(), tools: config.tools.filter((id) => toolGroup(id) !== "night-owl") };
	const problem = validateAgentConfig(tidy, await allowedModels(ctx, agent.model));
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
		const names = await namesOf(ctx, agents.map((a) => a.updatedBy));
		const connectors = await connectorStates(ctx, member);
		return Promise.all(
			agents.map(async (a) => ({
				...a,
				/** Its picture's URL (not the storage id), or null for its initials. */
				image: await imageUrl(ctx, a.image),
				updatedByName: names.get(a.updatedBy) ?? "",
				access: describeToolAccess(a, toActor(member), connectors),
				/** Set while it's in Trash: who deleted it, when, and whether you can restore it. */
				trash: a.archived ? await trashInfo(ctx, member, a._id) : null,
			})),
		);
	},
});

/**
 * What owners can pick from when editing an agent: models (AI Gateway's, cached; modelCatalog.ts), and tool groups. Each
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
		const { models, fetchedAt } = await catalogModels(ctx);
		return { models, fetchedAt, defaultModel, groups: [...builtin, ...connectors] };
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
		const names = await namesOf(ctx, versions.map((v) => v.savedBy));
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
	handler: async (ctx) => createAgent(ctx, await requirePermission(ctx, "agents.manage")),
});

export const update = mutation({
	args: { agentId: v.id("agents"), expectedVersion: v.number(), config: agentConfig },
	handler: async (ctx, { agentId, expectedVersion, config }) => updateAgent(ctx, await requirePermission(ctx, "agents.manage"), agentId, expectedVersion, config),
});

/** Brings back an old version by saving it as the newest one. History is never rewritten. */
export const restore = mutation({
	args: { agentId: v.id("agents"), version: v.number(), expectedVersion: v.number() },
	handler: async (ctx, { agentId, version, expectedVersion }) => {
		const owner = await requirePermission(ctx, "agents.manage");
		const agent = await requireLiveAgent(ctx, owner, agentId);
		checkVersion(agent.version, expectedVersion);
		const old = await ctx.db
			.query("agentVersions")
			.withIndex("by_agent", (q) => q.eq("agentId", agentId).eq("version", version))
			.first();
		if (!old) throw new ConvexError("That version doesn't exist.");
		await saveVersion(ctx, agent, await clean(ctx, agent, old.config), owner.userId);
	},
});

/** COMPAT(0.1.0-alpha.8): alpha.7 apps' Archive/Restore agent go through Trash. */
export const setArchived = mutation({
	args: { agentId: v.id("agents"), archived: v.boolean() },
	handler: async (ctx, { agentId, archived }) => {
		const owner = await requirePermission(ctx, "agents.manage");
		await setAgentTrashed(ctx, { member: owner }, agentId, archived);
	},
});

export async function createAgent(ctx: MutationCtx, member: Member, withoutTools = false) {
	checkPermission(member, "agents.manage");
	return insertAgent(ctx, member.workspaceId, member.userId, { ...blankAgent, ...(withoutTools && { tools: [] }) });
}

export async function updateAgent(ctx: MutationCtx, member: Member, agentId: Id<"agents">, expectedVersion: number, config: AgentConfig) {
	checkPermission(member, "agents.manage");
	const agent = await requireLiveAgent(ctx, member, agentId);
	checkVersion(agent.version, expectedVersion);
	await saveVersion(ctx, agent, await clean(ctx, agent, config), member.userId);
}

/**
 * Moves an agent to Trash, or back (owners). In Trash it leaves chat and runs nothing; its chats
 * and memories stay until it's deleted forever. The last agent stays: automations and chat need one.
 */
export async function setAgentTrashed(ctx: MutationCtx, who: Who, agentId: Id<"agents">, archived: boolean) {
	const { member } = who;
	checkPermission(member, "agents.manage");
	const agent = await requireAgent(ctx, member, agentId);
	if (agent.archived === archived) return;
	if (archived) {
		const active = await ctx.db
			.query("agents")
			.withIndex("by_workspace_active", (q) => q.eq("workspaceId", member.workspaceId).eq("archived", false))
			.take(2);
		if (active.length <= 1) throw new ConvexError("Keep at least one agent.");
	}
	await toggleTrash(ctx, who, archived, { kind: "agent", id: agentId, name: agent.name });
	await ctx.db.patch(agent._id, { archived });
}
