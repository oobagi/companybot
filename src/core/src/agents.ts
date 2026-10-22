import { type ToolSet, tool } from "ai";
import { builtinTools } from "./builtin-tools";
import { models } from "./models";
import { findPlugin } from "./plugins";
import { type ToolContext, type ToolDef, isGranted, modelToolName, toolGroup } from "./tools";
import type { Actor, Role } from "./types";

/** What an owner edits. Each workspace stores its own agents; saves are versioned. */
export interface AgentConfig {
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/**
	 * Tool grants: exact ids ("memory.search", "gmail.send") or whole groups
	 * ("memory.*", "gmail.*"). See `isGranted`.
	 */
	tools: string[];
}

export interface AgentDefinition extends AgentConfig {
	id: string;
}

export const defineAgent = (agent: AgentConfig) => agent;

const builtinGroups = new Set(builtinTools.map((t) => toolGroup(t.id)));

/** A grant names a built-in tool, a built-in group, or a catalog plugin. */
function isKnownGrant(grant: string) {
	const group = toolGroup(grant);
	if (!group) return false;
	if (grant.endsWith(".*")) return builtinGroups.has(group) || !!findPlugin(group);
	return builtinTools.some((t) => t.id === grant) || !!findPlugin(group);
}

/** Returns a message people can read, or null if the config is fine. */
export function validateAgentConfig(config: AgentConfig): string | null {
	const name = config.name.trim();
	if (!name) return "Give the agent a name.";
	if (name.length > 40) return "Keep the name under 40 characters.";
	if (config.description.length > 200) return "Keep the description under 200 characters.";
	if (config.instructions.length > 20_000) return "Instructions are too long (20,000 characters max).";
	if (!models.some((m) => m.id === config.model)) return "Pick a model from the list.";
	const unknown = config.tools.find((id) => !isKnownGrant(id));
	if (unknown) return `Unknown tool: ${unknown}`;
	return null;
}

/** Where a plugin stands for this person, from the backend. */
export interface PluginState {
	id: string;
	/** Roles the workspace allows to use it. */
	roles: Role[];
	/** Has a usable connection for this person (theirs, or the workspace's). */
	connected: boolean;
}

export type ToolAccess =
	| { id: string; visible: true }
	| { id: string; visible: false; reason: "role" | "not_found" | "not_installed" | "not_connected" };

/**
 * For each of an agent's grants, whether this person can use it and why not.
 * A tool reaches the model only if the agent grants it, the person's role allows
 * it, and (for plugins) the plugin is installed, allowed, and connected.
 */
export function describeToolAccess(
	agent: Pick<AgentConfig, "tools">,
	actor: Actor,
	plugins: PluginState[] = [],
): ToolAccess[] {
	return agent.tools.flatMap((id): ToolAccess[] => {
		const group = toolGroup(id);
		if (findPlugin(group)) {
			const state = plugins.find((p) => p.id === group);
			if (!state) return [{ id, visible: false, reason: "not_installed" }];
			if (!state.roles.includes(actor.role)) return [{ id, visible: false, reason: "role" }];
			if (!state.connected) return [{ id, visible: false, reason: "not_connected" }];
			return [{ id, visible: true }];
		}
		// Built-in grants are listed tool by tool, so a group shows which of its tools are hidden.
		const defs = builtinTools.filter((t) => (id.endsWith(".*") ? toolGroup(t.id) === group : t.id === id));
		if (defs.length === 0) return [{ id, visible: false, reason: "not_found" }];
		return defs.map((d) =>
			d.roles && !d.roles.includes(actor.role) ? { id: d.id, visible: false, reason: "role" } : { id: d.id, visible: true },
		);
	});
}

/**
 * The tools this agent can use for this person, out of `available` (built-ins plus
 * whatever plugin tools were loaded for the turn). Plugin role checks happen when
 * plugins are loaded; tool-level `roles` are checked here.
 */
export function resolveTools(
	agent: Pick<AgentConfig, "tools">,
	actor: Actor,
	available: ToolDef[] = builtinTools,
): ToolDef[] {
	return available.filter((t) => isGranted(agent.tools, t.id) && (!t.roles || t.roles.includes(actor.role)));
}

/** Builds the AI SDK tool set for one run. */
export function buildToolSet(
	agent: Pick<AgentConfig, "tools">,
	ctx: ToolContext,
	available: ToolDef[] = builtinTools,
): ToolSet {
	const tools: ToolSet = {};
	for (const t of resolveTools(agent, ctx.actor, available)) {
		tools[modelToolName(t.id)] = tool({
			description: t.description,
			inputSchema: t.input,
			execute: (input) => t.execute(input, ctx),
			...(t.toModelOutput && { toModelOutput: t.toModelOutput }),
		});
	}
	return tools;
}

/** Plugins an agent's grants reach, so the runner only connects to those. */
export const grantedPluginIds = (agent: Pick<AgentConfig, "tools">) =>
	[...new Set(agent.tools.map(toolGroup))].filter((group) => !!findPlugin(group));
