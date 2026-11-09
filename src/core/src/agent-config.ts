/** What people with agents.manage edit. Each workspace stores its own agents; saves are versioned. */
export interface AgentConfig {
	name: string;
	description: string;
	instructions: string;
	/** AI Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
	model: string;
	/** How hard the model thinks before it answers. Unset (agents saved before it existed) is `defaultReasoning`. */
	reasoning?: Reasoning;
	/**
	 * Tool grants: exact ids ("memory.search", "gmail.send") or whole groups
	 * ("memory.*", "gmail.*"). See `isGranted` in tools.ts.
	 */
	tools: string[];
	/** When customers email or text it (Inbox): `send` sends its replies right away; `check` (unset) keeps each as a draft for staff to send. */
	customerReplies?: CustomerReplies;
	/** Topics it never answers customers about itself: it passes the conversation to staff instead. */
	handOffTopics?: string[];
}

export const customerReplyModes = ["send", "check"] as const;
export type CustomerReplies = (typeof customerReplyModes)[number];
/** At most this many topics, each this long: they go into every customer turn's prompt. */
export const HAND_OFF_TOPICS_MAX = 30;
export const HAND_OFF_TOPIC_MAX = 120;

/** The levels offered, as AI SDK's `reasoning` call option; AI Gateway maps each to the model's own setting. */
export const reasonings = ["none", "low", "medium", "high"] as const;
export type Reasoning = (typeof reasonings)[number];
export const defaultReasoning: Reasoning = "medium";

export const agentConfigKeys = ["name", "description", "instructions", "model", "reasoning", "tools", "customerReplies", "handOffTopics"] as const satisfies readonly (keyof AgentConfig)[];

/** Just the config fields, from a stored agent row or anything else that carries extra ones. */
export const pickAgentConfig = (from: AgentConfig): AgentConfig => ({
	...(Object.fromEntries(agentConfigKeys.map((k) => [k, from[k]])) as unknown as AgentConfig),
	reasoning: from.reasoning ?? defaultReasoning,
	customerReplies: from.customerReplies ?? "check",
	handOffTopics: from.handOffTopics ?? [],
});

/** Trimmed, without blanks or repeats (case aside), capped. */
export function cleanTopics(topics: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of topics) {
		const t = raw.trim().replace(/\s+/g, " ").slice(0, HAND_OFF_TOPIC_MAX);
		if (!t || seen.has(t.toLowerCase())) continue;
		seen.add(t.toLowerCase());
		out.push(t);
	}
	return out.slice(0, HAND_OFF_TOPICS_MAX);
}
