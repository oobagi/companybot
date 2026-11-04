import { describe, expect, it } from "vitest";
import { addStep, emptyUsage, formatUsd, gatewayCost, isUsageMonth, monthLabel, recentMonths, usageMonth } from "./usage";

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

	it("counts months in UTC and lists the recent ones across a year end", () => {
		expect(usageMonth(Date.UTC(2026, 9, 31, 23, 59))).toBe("2026-10");
		expect(usageMonth(Date.UTC(2026, 10, 1))).toBe("2026-11");
		expect(recentMonths(Date.UTC(2027, 1, 15), 4)).toEqual(["2027-02", "2027-01", "2026-12", "2026-11"]);
		expect(monthLabel("2026-10")).toBe("October 2026");
		expect(["2026-10", "2026-13", "2026-1", "x"].map(isUsageMonth)).toEqual([true, false, false, false]);
	});

	it("rounds dollars to cents, and says so when it's less", () => {
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(0.0004)).toBe("<$0.01");
		expect(formatUsd(0.0149)).toBe("$0.01");
		expect(formatUsd(12.345)).toBe("$12.35");
		expect(formatUsd(1234.5)).toBe("$1,234.50");
	});
});
