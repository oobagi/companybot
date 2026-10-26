import { describe, expect, it } from "vitest";
import { addStep, emptyUsage, gatewayCost } from "./usage";

describe("usage", () => {
	const step = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
		({ inputTokens, outputTokens, inputTokenDetails: { cacheReadTokens } }) as Parameters<typeof addStep>[1];

	it("sums calls, and counts context as the first input plus all output", () => {
		const usage = emptyUsage("anthropic/claude-haiku-5.5");
		addStep(usage, step(1000, 50), { gateway: { cost: "0.0012" } });
		addStep(usage, step(1800, 200, 1000), { gateway: { cost: "0.0008" } });
		expect(usage).toMatchObject({ steps: 2, inputTokens: 2800, cachedInputTokens: 1000, outputTokens: 250 });
		expect(usage.contextTokens).toBe(1250);
		expect(usage.costUsd).toBeCloseTo(0.002);
	});

	it("treats a missing or odd cost as zero", () => {
		expect(gatewayCost(undefined)).toBe(0);
		expect(gatewayCost({ gateway: { cost: "n/a" } })).toBe(0);
	});
});
