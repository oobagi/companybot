import { describe, expect, it } from "vitest";
import {
	type Field,
	type ValueMode,
	fieldConfigError,
	formatDate,
	formatMoney,
	indexEntries,
	keyOf,
	minorDigits,
	normalizeFieldConfig,
	normalizeValue,
	recordTypeCatalog,
	searchTextOf,
	singularOf,
} from "./records";

describe("records", () => {
	const field = (kind: Field["kind"], extra: Partial<Field> = {}): Field => ({ key: "f", label: "F", kind, ...extra });
	const value = (f: Field, raw: unknown, mode?: ValueMode, currency?: string) => normalizeValue(f, raw, mode, currency);

	it("makes keys from labels that are safe, stable and unique", () => {
		expect(keyOf("Roof type", [])).toBe("roof_type");
		expect(keyOf("Roof type", ["roof_type", "roof_type_2"])).toBe("roof_type_3");
		expect(keyOf("2nd phone", [])).toBe("f_2nd_phone");
		expect(["Projects", "Companies", "Boxes", "Classes", "Staff", "People", "Sales people", "Status", "Statuses", "Buses", "COMPANIES"].map(singularOf))
			.toEqual(["Project", "Company", "Box", "Class", "Staff", "Person", "Sales person", "Status", "Status", "Bus", "COMPANY"]);
		expect(keyOf("!!!", [])).toBe("field");
		expect(keyOf("_secret", [])).toBe("secret");
	});

	it("checks field setups", () => {
		expect(fieldConfigError(normalizeFieldConfig({ label: " Roof ", kind: "choice", options: [{ label: "Flat" }] }))).toBeNull();
		expect(fieldConfigError({ label: "", kind: "text" })).toMatch("name");
		expect(fieldConfigError({ label: "x".repeat(61), kind: "text" })).toMatch("under 60");
		expect(fieldConfigError({ label: "A", kind: "choice", options: [{ id: "a", label: "A" }, { id: "b", label: "a" }] })).toMatch("same name");
		expect(fieldConfigError({ label: "A", kind: "text", options: [{ id: "a", label: "A" }] })).toMatch("Only choice");
		expect(fieldConfigError({ label: "A", kind: "text", multiple: true })).toMatch("several");
		expect(fieldConfigError({ label: "A", kind: "link" })).toMatch("database");
		expect(fieldConfigError({ label: "A", kind: "blob" as Field["kind"] })).toMatch("one of");
	});

	it("normalizes values, and empty ones clear", () => {
		expect(value(field("text"), "  hi ")).toEqual({ value: "hi" });
		expect(value(field("text"), "")).toEqual({ value: null });
		expect(value(field("number"), "1,200")).toEqual({ value: 1200 });
		expect(value(field("number"), "1e3")).toEqual({ value: 1000 });
		expect(value(field("date"), "2026-10-25T10:00:00Z")).toEqual({ value: "2026-10-25" });
		expect(value(field("date"), "10/25/2026")).toHaveProperty("error");
		expect(value(field("checkbox"), true)).toEqual({ value: true });
		expect(value(field("checkbox"), false)).toEqual({ value: null });
		expect(value(field("email"), " A@B.co ")).toEqual({ value: "a@b.co" });
		expect(value(field("phone"), "12")).toHaveProperty("error");
		expect(value(field("url"), "javascript:alert(1)")).toHaveProperty("error");
		expect(value(field("url"), "acme.com/x")).toEqual({ value: "https://acme.com/x" });
		const stage = field("choice", { options: [{ id: "won", label: "Won" }] });
		expect(value(stage, "WON")).toEqual({ value: "won" });
		expect(value(stage, ["won"])).toHaveProperty("error");
		expect(value({ ...stage, multiple: true }, ["Won", "won"])).toEqual({ value: ["won"] });
		expect(value({ ...stage, multiple: true }, [])).toEqual({ value: null });
	});

	it("stores each amount in its currency's smallest unit, rounding the exact decimal", () => {
		const money = field("currency");
		const usd = (minor: number) => ({ value: { minor, currency: "USD" } });
		expect(value(money, 1.005)).toEqual(usd(101));
		expect(value(money, "$1,250.50")).toEqual(usd(125050));
		expect(value(money, "-1.005")).toEqual(usd(-101));
		expect(value(money, ".5")).toEqual(usd(50));
		expect(value(money, 19.994)).toEqual(usd(1999));
		expect(value(money, Number.MAX_VALUE)).toHaveProperty("error");
		expect(value(money, "90071992547409.92")).toHaveProperty("error");
		expect(value(money, "abc")).toHaveProperty("error");
		// The workspace's currency is only the default; a code in the input wins.
		expect(value(money, 12, "input", "EUR")).toEqual({ value: { minor: 1200, currency: "EUR" } });
		expect(value(money, "€12.50 eur")).toEqual({ value: { minor: 1250, currency: "EUR" } });
		expect(value(money, "JPY 100", "input", "EUR")).toEqual({ value: { minor: 100, currency: "JPY" } });
		expect(value(money, { amount: "3.10", currency: "gbp" })).toEqual({ value: { minor: 310, currency: "GBP" } });
		// Each currency rounds to its own decimals (ISO 4217): yen has none, dinars three.
		expect(value(money, "JPY 99.5")).toEqual({ value: { minor: 100, currency: "JPY" } });
		expect(value(money, "JPY 1,250")).toEqual({ value: { minor: 1250, currency: "JPY" } });
		expect(value(money, { amount: "1.2345", currency: "KWD" })).toEqual({ value: { minor: 1235, currency: "KWD" } });
		expect(value(money, "BHD .5")).toEqual({ value: { minor: 500, currency: "BHD" } });
		expect(value(money, 7, "input", "KRW")).toEqual({ value: { minor: 7, currency: "KRW" } });
		expect(value(money, "XYZ 10")).toEqual({ error: "“F” needs a currency code like USD or EUR." });
		// Stored values come back as they were, currency included.
		expect(value(money, { minor: 101, currency: "EUR" }, "stored", "USD")).toEqual({ value: { minor: 101, currency: "EUR" } });
		expect(value(money, 101, "stored")).toHaveProperty("error");
		expect(value(money, { minor: 1.5, currency: "USD" }, "stored")).toHaveProperty("error");
	});

	it("shows amounts in their currency's own decimals", () => {
		expect(formatMoney({ minor: 125050, currency: "USD" }, "en-US")).toBe("$1,250.50");
		expect(formatMoney({ minor: -5, currency: "USD" }, "en-US")).toBe("-$0.05");
		expect(formatMoney({ minor: 100, currency: "JPY" }, "en-US")).toBe("¥100");
		expect(formatMoney({ minor: 1250, currency: "KWD" }, "en-US").replace(/\s/, " ")).toBe("KWD 1.250");
		expect(formatMoney({ minor: 9007199254740991, currency: "USD" }, "en-US")).toBe("$90,071,992,547,409.91");
		expect([minorDigits("JPY"), minorDigits("USD"), minorDigits("KWD")]).toEqual([0, 2, 3]);
	});

	it("shows dates as the calendar day stored, whatever the time zone", () => {
		expect(formatDate("2026-11-15", "en-US")).toBe("Nov 15, 2026");
		expect(formatDate("2026-01-01", "en-US")).toBe("Jan 1, 2026");
		expect(formatDate("2026-12-31", "en-GB")).toBe("31 Dec 2026");
		expect(formatDate("soon", "en-US")).toBe("soon");
		expect(formatDate("2026-13-45", "en-US")).toBe("2026-13-45");
	});

	it("can't set retired options, but can filter by them", () => {
		const stage = field("choice", { options: [{ id: "won", label: "Won" }, { id: "old", label: "Old", retired: true }] });
		expect(value(stage, "old")).toHaveProperty("error");
		expect(value(stage, "old", "stored")).toHaveProperty("error");
		expect(value(stage, "Old", "filter")).toEqual({ value: "old" });
		expect(fieldConfigError({ label: "S", kind: "choice", options: [{ id: "a", label: "A", retired: true }] })).toMatch("at least one");
	});

	it("indexes values for sorting and exact matches", () => {
		const long = "x".repeat(100);
		const [a] = indexEntries(field("text"), `${long}One`) as { str: string }[];
		expect(a!.str).toMatch(new RegExp(`^${"x".repeat(80)}#[0-9a-f]{16}$`));
		expect(indexEntries(field("text"), `${long}ONE`)).toEqual([a]);
		expect(indexEntries(field("text"), `${long}Two`)).not.toEqual([a]);
		expect(indexEntries(field("text"), "Acme ROOFING")).toEqual([{ str: "acme roofing" }]);
		expect(indexEntries(field("phone"), "(555) 123-4567")).toEqual([{ str: "5551234567" }]);
		expect(indexEntries(field("currency"), { minor: 1250, currency: "EUR" })).toEqual([{ str: "EUR", num: 1250 }]);
		expect(indexEntries(field("link", { multiple: true }), ["a", "b"])).toEqual([{ ref: "a" }, { ref: "b" }]);
		expect(indexEntries(field("text"), undefined)).toEqual([]);
	});

	it("searches text-like values only", () => {
		const fields = [field("text", { key: "name" }), field("number", { key: "n" }), field("email", { key: "e" })];
		expect(searchTextOf(fields, { name: "Acme", n: 3, e: "a@b.co" })).toBe("Acme\na@b.co");
	});

	it("ships built-in types whose fields are valid and links point at other built-ins", () => {
		const keys = recordTypeCatalog.map((t) => t.key);
		for (const type of recordTypeCatalog) {
			expect(type.fields[0]?.key).toBe("name");
			for (const f of type.fields) {
				expect(fieldConfigError(f)).toBeNull();
				if (f.linkType) expect(keys).toContain(f.linkType);
			}
		}
	});
});
