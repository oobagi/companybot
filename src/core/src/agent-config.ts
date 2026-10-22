/** What an owner edits. Each workspace stores its own agents; saves are versioned. */
export interface AgentConfig {
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/**
	 * Tool grants: exact ids ("memory.search", "gmail.send") or whole groups
	 * ("memory.*", "gmail.*"). See `isGranted` in tools.ts.
	 */
	tools: string[];
}

export const agentConfigKeys = ["name", "description", "instructions", "model", "tools"] as const satisfies readonly (keyof AgentConfig)[];

/** Just the config fields, from a stored agent row or anything else that carries extra ones. */
export const pickAgentConfig = (from: AgentConfig): AgentConfig =>
	Object.fromEntries(agentConfigKeys.map((k) => [k, from[k]])) as unknown as AgentConfig;
