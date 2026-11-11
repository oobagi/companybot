import { describe, expect, it } from "vitest";
import { rankAt, rankBetween } from "./rank";

describe("rank", () => {
	it("starts newer records first, apart even in the same millisecond", () => {
		const older = rankAt(1_700_000_000_000, "abc");
		const newer = rankAt(1_700_000_000_001, "abc");
		expect(newer < older).toBe(true);
		expect(rankAt(5, "a") === rankAt(5, "b")).toBe(false);
		expect(older.endsWith("0")).toBe(false);
	});

	it("always fits one between two, at either end, however many times", () => {
		let a = rankAt(1_700_000_000_000, "x");
		const b = rankAt(1_699_999_999_999, "y");
		for (let i = 0; i < 200; i++) {
			const mid = rankBetween(a, b);
			expect(a < mid && mid < b).toBe(true);
			a = mid;
		}
		let first = b;
		for (let i = 0; i < 50; i++) {
			const before = rankBetween(undefined, first);
			expect(before < first && !before.endsWith("0")).toBe(true);
			first = before;
		}
		let last = b;
		for (let i = 0; i < 50; i++) {
			const after = rankBetween(last, undefined);
			expect(after > last).toBe(true);
			last = after;
		}
	});

	it("refuses two out of order", () => {
		expect(() => rankBetween("b", "a")).toThrow();
	});
});
