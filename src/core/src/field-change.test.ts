import { describe, expect, it } from "vitest";
import {
	type ConvertContext,
	conditionFits,
	convertValue,
	countChange,
	emptyCounts,
	moneyOf,
	optionMaker,
	parseDay,
	parseNumber,
	shapeChanged,
} from "./field-change";
import type { Field, FieldKind, FieldValue } from "./records";

const f = (kind: FieldKind, extra: Partial<Field> = {}): Field => ({ key: "x", label: "X", kind, ...extra });
const ctx: ConvertContext = { currency: "USD" };
const value = (from: Field, to: Field, v: FieldValue, c: ConvertContext = ctx) => {
	const result = convertValue(from, to, v, c);
	return "unknown" in result ? "unknown" : result.value;
};

describe("changing a field's kind", () => {
	it("keeps how anything reads when it becomes text", () => {
		const text = f("text");
		expect(value(f("number"), text, 1234.5)).toBe("1234.5");
		expect(value(f("currency"), text, { minor: 123456, currency: "USD" })).toBe("$1,234.56");
		expect(value(f("currency"), text, { minor: 1250, currency: "EUR" })).toBe("€12.50");
		expect(value(f("date"), text, "2026-11-15")).toBe("Nov 15, 2026");
		expect(value(f("checkbox"), text, true)).toBe("Yes");
		const choice = f("choice", { multiple: true, options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] });
		expect(value(choice, text, ["a", "b"])).toBe("Alpha, Beta");
		expect(value(f("url"), text, "https://acme.com/")).toBe("https://acme.com/");
	});

	it("names people and linked records, or waits for the names", () => {
		const names: ConvertContext = { ...ctx, name: (id) => ({ u1: "Ada", r1: "Acme" })[id] };
		expect(value(f("user"), f("text"), "u1", names)).toBe("Ada");
		expect(value(f("link", { linkType: "t", multiple: true }), f("text"), ["r1"], names)).toBe("Acme");
		expect(value(f("user"), f("text"), "u1")).toBe("unknown");
	});

	it("parses text into numbers, amounts and dates, clearing what doesn't parse", () => {
		expect(value(f("text"), f("number"), "1,234")).toBe(1234);
		expect(value(f("text"), f("number"), "$1,234.56")).toBe(1234.56);
		expect(value(f("text"), f("number"), "-12.5")).toBe(-12.5);
		expect(value(f("text"), f("number"), "n/a")).toBe(null);
		expect(value(f("text"), f("currency"), "$1,234.56")).toEqual({ minor: 123456, currency: "USD" });
		expect(value(f("text"), f("currency"), "EUR 12.50")).toEqual({ minor: 1250, currency: "EUR" });
		expect(value(f("text"), f("currency"), "40 gbp")).toEqual({ minor: 4000, currency: "GBP" });
		expect(value(f("text"), f("currency"), "€5")).toEqual({ minor: 500, currency: "EUR" });
		expect(value(f("text"), f("currency"), "1.005")).toEqual({ minor: 101, currency: "USD" });
		expect(value(f("text"), f("currency"), "soon")).toBe(null);
		expect(value(f("text"), f("date"), "Nov 15, 2026")).toBe("2026-11-15");
		expect(value(f("text"), f("date"), "nope")).toBe(null);
	});

	it("uses the workspace's currency unless the text names one", () => {
		expect(moneyOf("12", "JPY")).toEqual({ minor: 12, currency: "JPY" });
		expect(moneyOf("$12", "CAD")).toEqual({ minor: 1200, currency: "CAD" });
		expect(moneyOf("$12", "EUR")).toEqual({ minor: 1200, currency: "USD" });
		expect(moneyOf("12 XYZ", "USD")).toBe(null);
	});

	it("reads days in common forms", () => {
		expect(parseDay("2026-11-15T10:00:00Z")).toBe("2026-11-15");
		expect(parseDay("2026/11/15")).toBe("2026-11-15");
		expect(parseDay("11/15/2026")).toBe("2026-11-15");
		expect(parseDay("15 November 2026")).toBe("2026-11-15");
		expect(parseDay("November 3rd, 2026")).toBe("2026-11-03");
		expect(parseDay("2026-02-30")).toBe(null);
		expect(parseNumber("1e5")).toBe(null);
	});

	it("parses checkboxes, emails, phones and websites", () => {
		expect(value(f("text"), f("checkbox"), "Yes")).toBe(true);
		expect(value(f("text"), f("checkbox"), "no")).toBe(null);
		expect(convertValue(f("text"), f("checkbox"), "maybe", ctx)).toEqual({ value: null, lost: ["maybe"] });
		expect(value(f("number"), f("checkbox"), 0)).toBe(null);
		expect(value(f("checkbox"), f("number"), true)).toBe(1);
		expect(value(f("text"), f("email"), "Ada@Acme.com")).toBe("ada@acme.com");
		expect(value(f("text"), f("email"), "ada at acme")).toBe(null);
		expect(value(f("text"), f("phone"), "+1 (555) 010-2000")).toBe("+1 (555) 010-2000");
		expect(value(f("text"), f("url"), "acme.com")).toBe("https://acme.com/");
		expect(value(f("currency"), f("number"), { minor: 1250, currency: "KWD" })).toBe(1.25);
		expect(value(f("number"), f("currency"), 12.5)).toEqual({ minor: 1250, currency: "USD" });
	});

	it("makes an option per distinct value, in any case, up to the limit", () => {
		const maker = optionMaker();
		const c = { ...ctx, option: maker.option };
		const one = f("choice");
		expect(value(f("text"), one, "Open", c)).toBe("open");
		expect(value(f("text"), one, "OPEN", c)).toBe("open");
		expect(value(f("text"), one, "Closed", c)).toBe("closed");
		expect(maker.made).toEqual(["Open", "Closed"]);
		expect(value(f("text"), one, "x".repeat(101), c)).toBe(null);
		expect(value(f("text"), f("choice", { multiple: true }), "Open, Won", c)).toEqual(["open", "won"]);
		expect(value(f("number"), one, 3, c)).toBe("f_3");
		const full = optionMaker(Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })));
		expect(value(f("text"), one, "New", { ...ctx, option: full.option })).toBe(null);
	});

	it("keeps the first of several, and wraps one into several", () => {
		const several = f("choice", { multiple: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
		const one = { ...several, multiple: false };
		expect(convertValue(several, one, ["a", "b"], ctx)).toEqual({ value: "a", lost: ["B"] });
		expect(value(one, several, "a")).toEqual(["a"]);
		expect(value(f("user", { multiple: true }), f("user"), ["u1", "u2"])).toBe("u1");
	});

	it("matches people and records by name, and needs the lookups to do so", () => {
		const team: ConvertContext = { ...ctx, person: (t) => (t.toLowerCase() === "ada" ? "u1" : null), record: (t) => (t === "Acme" ? "r1" : null) };
		expect(value(f("text"), f("user"), "Ada", team)).toBe("u1");
		expect(value(f("text"), f("user"), "Bob", team)).toBe(null);
		expect(value(f("text"), f("user"), "Ada")).toBe("unknown");
		expect(value(f("text"), f("link", { linkType: "t" }), "Acme", team)).toBe("r1");
		// Another database: by name, through the old one's names.
		const names = { ...team, name: (id: string) => (id === "old1" ? "Acme" : undefined) };
		expect(value(f("link", { linkType: "a" }), f("link", { linkType: "t" }), "old1", names)).toBe("r1");
	});

	it("counts what converts, what's cleared and what only partly fits", () => {
		const counts = emptyCounts();
		countChange(counts, { value: 1, lost: [] });
		countChange(counts, { value: null, lost: ["n/a"] });
		countChange(counts, { value: "a", lost: ["B"] });
		expect(counts).toEqual({ checked: 3, converted: 2, cleared: 1, partly: 1, examples: ["n/a", "B"] });
	});

	it("knows which changes rewrite values and which filters still fit", () => {
		expect(shapeChanged(f("text"), f("text"))).toBe(false);
		expect(shapeChanged(f("choice"), f("choice", { multiple: true }))).toBe(true);
		expect(shapeChanged(f("link", { linkType: "a" }), f("link", { linkType: "b" }))).toBe(true);
		expect(conditionFits(f("text"), f("number"), { field: "x", empty: true })).toBe(true);
		expect(conditionFits(f("text"), f("number"), { field: "x", eq: "a" })).toBe(false);
		expect(conditionFits(f("choice"), f("choice", { multiple: true }), { field: "x", in: ["a"] })).toBe(true);
		expect(conditionFits(f("number"), f("number"), { field: "x", gte: 1 })).toBe(true);
	});
});
