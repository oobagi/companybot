import { type ToolSet, tool } from "ai";
import type { Plugin, PluginRegistry, PluginTool, ToolContext } from "./plugins";
import type { Actor } from "./types";

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/** Tool ids this agent may use, e.g. ["memory.save"]. */
	tools: string[];
}

export const defineAgent = (agent: AgentDefinition) => agent;

export type ToolAccess =
	| { id: string; visible: true }
	| { id: string; visible: false; reason: "not_found" | "not_installed" | "role" };

/**
 * Which of an agent's tools this actor can use right now. A tool is visible
 * only if the agent grants it, its plugin is installed, and the actor's role
 * is allowed. Hidden tools are never sent to the model.
 */
export function describeToolAccess(agent: AgentDefinition, actor: Actor, registry: PluginRegistry): ToolAccess[] {
	return agent.tools.map((id): ToolAccess => {
		const found = registry.findTool(id);
		if (!found) return { id, visible: false, reason: "not_found" };
		if (!registry.isInstalled(found.plugin.id)) return { id, visible: false, reason: "not_installed" };
		if (found.tool.roles && !found.tool.roles.includes(actor.role)) return { id, visible: false, reason: "role" };
		return { id, visible: true };
	});
}

export function resolveTools(
	agent: AgentDefinition,
	ctx: ToolContext,
	registry: PluginRegistry,
): { plugin: Plugin; tool: PluginTool }[] {
	return describeToolAccess(agent, ctx.actor, registry).flatMap((access) => {
		const found = access.visible ? registry.findTool(access.id) : undefined;
		return found ? [found] : [];
	});
}

/** Builds the AI SDK tool set for one run. Model-facing names use "_" (e.g. memory_save). */
export function buildToolSet(agent: AgentDefinition, ctx: ToolContext, registry: PluginRegistry): ToolSet {
	const tools: ToolSet = {};
	for (const { plugin, tool: t } of resolveTools(agent, ctx, registry)) {
		tools[`${plugin.id}_${t.name}`] = tool({
			description: t.description,
			inputSchema: t.input,
			execute: (input) => t.execute(input, ctx),
		});
	}
	return tools;
}
