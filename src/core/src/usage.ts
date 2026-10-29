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

/** What a paid call was for. Every one is recorded through the backend's `recordUsage` (usage.ts). */
export const usageKinds = ["chat", "summary", "search", "image", "dictation"] as const;
export type UsageKind = (typeof usageKinds)[number];

export const usageKindLabels: Record<UsageKind, string> = {
	chat: "Replies",
	summary: "Chat summaries",
	search: "Web search",
	image: "Images",
	dictation: "Dictation",
};

/** The month a time falls in, as billing counts it: "2026-10", in UTC. */
export const usageMonth = (time: number) => new Date(time).toISOString().slice(0, 7);

export const isUsageMonth = (month: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

/** The month of `time` and the ones before it, newest first. */
export function recentMonths(time: number, count = 6) {
	const now = new Date(time);
	return Array.from({ length: count }, (_, i) => usageMonth(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
}

/** "October 2026". */
export const monthLabel = (month: string) =>
	new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Dollars for a total: cents, with "<$0.01" for a real but tiny amount. */
export function formatUsd(n: number) {
	if (n <= 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
