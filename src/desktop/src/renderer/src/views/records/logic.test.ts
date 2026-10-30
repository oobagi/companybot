import type { Field } from "@companybot/core/records";
import { describe, expect, it } from "vitest";
import { defaultColumns, fromConditions, moneyInput, opsFor, recordPath, sortable, toCondition, valueText, whoLabel } from "./logic";

const field = (kind: Field["kind"], extra: Partial<Field> = {}): Field => ({ key: kind, label: kind, kind, ...extra });
const stage = field("choice", {
	options: [
		{ id: "won", label: "Won" },
		{ id: "old", label: "Old", retired: true },
	],
});

describe("record screens", () => {
	it("routes built-in types to their tabs and added types under /records", () => {
		expect(recordPath("client")).toEqual(["records", "client"]);
		expect(recordPath("deal", "abc")).toEqual(["records", "deal", "abc"]);
		expect(recordPath("job", "abc")).toEqual(["records", "job", "abc"]);
	});

	it("shows the name and the next few live fields by default", () => {
		const fields = ["name", "a", "b", "c", "d", "e"].map((key) => ({ ...field("text"), key, _id: key, archived: key === "b" }));
		expect(defaultColumns(fields)).toEqual(["name", "a", "c", "d", "e"]);
	});

	it("offers the operators records.list takes for each kind", () => {
		expect(opsFor(field("text"))).toEqual(["is", "empty", "notEmpty"]);
		expect(opsFor(field("currency"))).toContain("gte");
		expect(opsFor(field("date", { multiple: true }))).not.toContain("gte");
		expect(opsFor(field("choice"))[0]).toBe("anyOf");
		expect(opsFor(field("checkbox"))).toEqual(["checked", "unchecked"]);
	});

	it("turns filters into list conditions, skipping ones without a value", () => {
		expect(toCondition({ field: "stage", op: "anyOf", value: ["won"] })).toEqual({ field: "stage", in: ["won"] });
		expect(toCondition({ field: "stage", op: "anyOf", value: [] })).toBeNull();
		expect(toCondition({ field: "value", op: "gte", value: " EUR 100 " })).toEqual({ field: "value", gte: "EUR 100" });
		expect(toCondition({ field: "name", op: "is", value: "" })).toBeNull();
		expect(toCondition({ field: "name", op: "is", value: "Acme" })).toEqual({ field: "name", eq: "Acme" });
		expect(toCondition({ field: "done", op: "unchecked", value: "" })).toEqual({ field: "done", empty: true });
		expect(toCondition({ field: "owner", op: "notEmpty", value: "" })).toEqual({ field: "owner", empty: false });
	});

	it("restores saved filters without losing numeric zero, ids or either range bound", () => {
		const conditions = [{ field: "number", gte: 0, lt: 10 }, { field: "choice", in: ["won"] }, { field: "owner", empty: true }];
		const filters = fromConditions(conditions);
		expect(filters).toHaveLength(4);
		expect(filters.map(toCondition)).toEqual([{ field: "number", gte: "0" }, { field: "number", lt: "10" }, { field: "choice", in: ["won"] }, { field: "owner", empty: true }]);
		const fields = [{ ...stage, _id: "stage" }];
		expect(fromConditions([{ field: "choice", eq: "won" }], fields)).toEqual([{ field: "choice", op: "anyOf", value: ["won"] }]);
		expect(fromConditions([{ field: "checkbox", empty: false }], [{ ...field("checkbox"), _id: "c" }])).toEqual([{ field: "checkbox", op: "checked", value: "" }]);
	});

	it("sorts only by single values that aren't links or checkboxes", () => {
		expect(sortable(field("currency"))).toBe(true);
		expect(sortable(field("link"))).toBe(false);
		expect(sortable(field("choice", { multiple: true }))).toBe(false);
		expect(sortable(field("checkbox"))).toBe(false);
	});

	it("reads values for people: money with its currency, removed options, deleted links", () => {
		expect(valueText(field("currency"), { minor: 125050, currency: "USD" })).toMatch(/1,250\.50/);
		expect(valueText(field("currency"), { minor: 100, currency: "JPY" })).toMatch(/100/);
		expect(valueText(stage, "won")).toBe("Won");
		expect(valueText(stage, "old")).toBe("Old (removed)");
		expect(valueText(field("link"), ["a", "b"], { a: { name: "Acme" }, b: { name: "Bolt", archived: true } })).toBe("Acme, Bolt (deleted)");
		expect(valueText(field("date"), "2026-10-25")).toMatch(/2026/);
		expect(valueText(field("text"), undefined)).toBe("");
	});

	it("edits amounts in the currency's own decimals", () => {
		expect(moneyInput({ minor: 125050, currency: "USD" }, 2)).toBe("1250.50");
		expect(moneyInput({ minor: 5, currency: "USD" }, 2)).toBe("0.05");
		expect(moneyInput({ minor: -1250, currency: "KWD" }, 3)).toBe("-1.250");
		expect(moneyInput({ minor: 100, currency: "JPY" }, 0)).toBe("100");
		expect(moneyInput(undefined, 2)).toBe("");
	});

	it("names who made a change, and the agent that did it for them", () => {
		expect(whoLabel({ user: "Jaden", agent: null })).toBe("Jaden");
		expect(whoLabel({ user: "Jaden", agent: "Companybot" })).toBe("Companybot, for Jaden");
	});
});
