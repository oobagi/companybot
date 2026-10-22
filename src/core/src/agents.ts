import { type ToolSet, tool } from "ai";
import { builtinTools } from "./builtin-tools";
import type { ToolContext, ToolDef } from "./tools";
import type { Actor } from "./types";

export interface AgentDefinition {
	id: string;
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/** Built-in tool ids this agent may use, e.g. ["memory.search"]. */
	tools: string[];
}

export const defineAgent = (agent: AgentDefinition) => agent;

export type ToolAccess = { id: string; visible: true } | { id: string; visible: false; reason: "role" | "not_found" };

/**
 * Which of an agent's tools this person can use. A tool is visible only if the
 * agent grants it and the person's role allows it. Hidden tools never reach the model.
 */
export function describeToolAccess(agent: AgentDefinition, actor: Actor): ToolAccess[] {
	return agent.tools.map((id): ToolAccess => {
		const def = builtinTools.find((t) => t.id === id);
		if (!def) return { id, visible: false, reason: "not_found" };
		if (def.roles && !def.roles.includes(actor.role)) return { id, visible: false, reason: "role" };
		return { id, visible: true };
	});
}

export function resolveTools(agent: AgentDefinition, actor: Actor): ToolDef[] {
	const visible = new Set(describeToolAccess(agent, actor).flatMap((a) => (a.visible ? [a.id] : [])));
	return builtinTools.filter((t) => visible.has(t.id));
}

/** Builds the AI SDK tool set for one run. Model-facing names use "_" (e.g. memory_search). */
export function buildToolSet(agent: AgentDefinition, ctx: ToolContext): ToolSet {
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
