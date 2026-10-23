import { type ToolSet, tool } from "ai";
import type { AgentConfig } from "./agent-config";
import { builtinTools } from "./builtin-tools";
import { models } from "./models";
import { type PluginService, pluginMetaTools } from "./plugin-tools";
import { findPlugin } from "./plugins";
import { type ToolContext, type ToolDef, isGranted, modelToolName, toolGroup } from "./tools";
import type { Actor, Role } from "./types";

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
	/** Connected plugins' names and usage notes, shown by plugins_search. */
	services: PluginService[] = [],
): ToolSet {
	const tools: ToolSet = {};
	const run = (t: ToolDef, input: unknown) => (t.returnsData ? withRef(t.execute(input, ctx), ctx) : t.execute(input, ctx));
	const resolved = resolveTools(agent, ctx.actor, available);
	for (const t of resolved.filter((t) => t.source.type === "builtin")) {
		tools[modelToolName(t.id)] = tool({
			description: t.description,
			inputSchema: t.input,
			execute: (input) => run(t, input),
			...(t.toModelOutput && { toModelOutput: t.toModelOutput }),
		});
	}
	// Plugin tools load on demand (see plugin-tools.ts). Present whenever the agent is
	// granted a plugin, connected or not, so the tool list stays the same turn to turn.
	const pluginTools = resolved.filter((t) => t.source.type === "plugin");
	if (pluginTools.length > 0 || grantedPluginIds(agent).length > 0) Object.assign(tools, pluginMetaTools(pluginTools, services, run));
	return tools;
}

/** Wraps a data tool's result as `{ ref, data }`. Errors pass through unchanged. */
async function withRef(output: Promise<unknown>, ctx: ToolContext) {
	const data = await output;
	if (data && typeof data === "object" && "error" in data) return data;
	return { ref: ctx.results.save(data), data };
}

/** Plugins an agent's grants reach, so the runner only connects to those. */
export const grantedPluginIds = (agent: Pick<AgentConfig, "tools">) =>
	[...new Set(agent.tools.map(toolGroup))].filter((group) => !!findPlugin(group));
