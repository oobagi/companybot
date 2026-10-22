import type { LanguageModelUsage, ProviderMetadata } from "ai";

/** What one reply used, summed over its model calls (steps). */
export type ReplyUsage = {
	model: string;
	steps: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	/**
	 * Roughly what this conversation weighs on the next turn: the first call's input
	 * (instructions, summary, history, the new message) plus everything the reply wrote.
	 * Tool results from inside the turn aren't carried forward, so they don't count.
	 */
	contextTokens: number;
	/** USD, as AI Gateway billed it. */
	costUsd: number;
};

export const emptyUsage = (model: string): ReplyUsage => ({
	model,
	steps: 0,
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	contextTokens: 0,
	costUsd: 0,
});

export function addStep(usage: ReplyUsage, step: LanguageModelUsage, metadata: ProviderMetadata | undefined) {
	const input = step.inputTokens ?? 0;
	const output = step.outputTokens ?? 0;
	if (usage.steps === 0) usage.contextTokens = input;
	usage.steps++;
	usage.inputTokens += input;
	usage.cachedInputTokens += step.inputTokenDetails?.cacheReadTokens ?? 0;
	usage.outputTokens += output;
	usage.contextTokens += output;
	usage.costUsd += gatewayCost(metadata);
}

/** AI Gateway reports each call's cost as a decimal string in USD. */
export function gatewayCost(metadata: ProviderMetadata | undefined): number {
	const cost = Number(metadata?.gateway?.cost);
	return Number.isFinite(cost) ? cost : 0;
}
