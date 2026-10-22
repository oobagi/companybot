import { type ToolSet, tool } from "ai";
import { builtinTools } from "./builtin-tools";
import { models } from "./models";
import type { ToolContext, ToolDef } from "./tools";
import type { Actor } from "./types";

/** What an owner edits. Each workspace stores its own agents; saves are versioned. */
export interface AgentConfig {
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/** Built-in tool ids this agent may use, e.g. ["memory.search"]. */
	tools: string[];
}

export interface AgentDefinition extends AgentConfig {
	id: string;
}

export const defineAgent = (agent: AgentConfig) => agent;

/** Returns a message people can read, or null if the config is fine. */
export function validateAgentConfig(config: AgentConfig): string | null {
	const name = config.name.trim();
	if (!name) return "Give the agent a name.";
	if (name.length > 40) return "Keep the name under 40 characters.";
	if (config.description.length > 200) return "Keep the description under 200 characters.";
	if (config.instructions.length > 20_000) return "Instructions are too long (20,000 characters max).";
	if (!models.some((m) => m.id === config.model)) return "Pick a model from the list.";
	const unknown = config.tools.find((id) => !builtinTools.some((t) => t.id === id));
	if (unknown) return `Unknown tool: ${unknown}`;
	return null;
}

export type ToolAccess = { id: string; visible: true } | { id: string; visible: false; reason: "role" | "not_found" };

/**
 * Which of an agent's tools this person can use. A tool is visible only if the
 * agent grants it and the person's role allows it. Hidden tools never reach the model.
 */
export function describeToolAccess(agent: Pick<AgentConfig, "tools">, actor: Actor): ToolAccess[] {
	return agent.tools.map((id): ToolAccess => {
		const def = builtinTools.find((t) => t.id === id);
		if (!def) return { id, visible: false, reason: "not_found" };
		if (def.roles && !def.roles.includes(actor.role)) return { id, visible: false, reason: "role" };
		return { id, visible: true };
	});
}

export function resolveTools(agent: Pick<AgentConfig, "tools">, actor: Actor): ToolDef[] {
	const visible = new Set(describeToolAccess(agent, actor).flatMap((a) => (a.visible ? [a.id] : [])));
	return builtinTools.filter((t) => visible.has(t.id));
}

/** Builds the AI SDK tool set for one run. Model-facing names use "_" (e.g. memory_search). */
export function buildToolSet(agent: Pick<AgentConfig, "tools">, ctx: ToolContext): ToolSet {
	const tools: ToolSet = {};
	for (const t of resolveTools(agent, ctx.actor)) {
		tools[t.id.replace(".", "_")] = tool({
			description: t.description,
			inputSchema: t.input,
			execute: (input) => t.execute(input, ctx),
		});
	}
	return tools;
}
