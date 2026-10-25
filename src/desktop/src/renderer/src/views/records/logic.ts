import type { Field, FieldKind, FieldValue, Money } from "@companybot/core/records";
import { formatMoney } from "@companybot/core/records";

// Pure rules for the record screens: columns, filters, sorting and how values read.
// Shared by every record type, built-in or added later. See wiki/data.md.

/** A field as the app gets it from `recordTypes.list` (key, kind, options…), plus its id. */
export type TypeField = Field & { _id: string; archived?: boolean; canEdit?: boolean };
/** Names for user and record ids in a row's values. */
export type Refs = Record<string, { name: string; archived?: true }>;

/** Built-in types have their own tab; types owners add live under /records/<key>. */
export const builtinTabs: Record<string, string> = { client: "clients", deal: "deals", task: "tasks", call: "calls" };

/** The route of a type's list, or of one record. */
export const recordPath = (typeKey: string, recordId?: string) => [
	...(builtinTabs[typeKey] ? [builtinTabs[typeKey]!] : ["records", typeKey]),
	...(recordId ? [recordId] : []),
];

export const kindLabels: Record<FieldKind, string> = {
	text: "Text",
	number: "Number",
	currency: "Amount",
	date: "Date",
	checkbox: "Checkbox",
	choice: "Choice",
	email: "Email",
	phone: "Phone",
	url: "Website",
	user: "Person",
	link: "Link to a record",
};

/** Name, then the next few live fields. */
export const defaultColumns = (fields: TypeField[], count = 4) =>
	fields
		.filter((f) => !f.archived)
		.slice(0, count + 1)
		.map((f) => f.key);

/** Lists can sort by single-valued fields other than links (and checkboxes, which only list the checked). */
export const sortable = (field: Field) => !field.multiple && field.kind !== "link" && field.kind !== "checkbox";

// ---- Filters ----

export type Op = "is" | "anyOf" | "gt" | "gte" | "lt" | "lte" | "empty" | "notEmpty" | "checked" | "unchecked";

export const opLabels: Record<Op, string> = {
	is: "is",
	anyOf: "is any of",
	gt: "is more than",
	gte: "is at least",
	lt: "is less than",
	lte: "is at most",
	empty: "is empty",
	notEmpty: "is not empty",
	checked: "is checked",
	unchecked: "is not checked",
};

/** A filter as someone builds it in the bar. `value` is text, or ids for "any of". */
export interface Filter {
	field: string;
	op: Op;
	value: string | string[];
}

const rangeKinds: FieldKind[] = ["number", "currency", "date"];
const anyOfKinds: FieldKind[] = ["choice", "user", "link"];

/** What a field can be filtered by, first one the default. Matches records.list's rules. */
export function opsFor(field: Field): Op[] {
	if (field.kind === "checkbox") return ["checked", "unchecked"];
	if (anyOfKinds.includes(field.kind)) return ["anyOf", "empty", "notEmpty"];
	if (rangeKinds.includes(field.kind) && !field.multiple) return ["is", "gte", "lte", "gt", "lt", "empty", "notEmpty"];
	return ["is", "empty", "notEmpty"];
}

export const needsValue = (op: Op) => !["empty", "notEmpty", "checked", "unchecked"].includes(op);

/** The list condition for a filter, or null while it's missing a value. */
export function toCondition({ field, op, value }: Filter): Record<string, unknown> & { field: string } | null {
	if (op === "empty" || op === "unchecked") return { field, empty: true };
	if (op === "notEmpty" || op === "checked") return { field, empty: false };
	if (op === "anyOf") return Array.isArray(value) && value.length ? { field, in: value } : null;
	const text = Array.isArray(value) ? "" : value.trim();
	if (!text) return null;
	return { field, [op === "is" ? "eq" : op]: text };
}

// ---- Values ----

const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** A "YYYY-MM-DD" day for people: "Oct 25, 2026". */
export const formatDay = (day: string) => dateFormat.format(new Date(`${day}T00:00:00Z`));

/**
 * One stored value as text. Links and people read from `refs`; a record that's gone or
 * archived says so. Options that were removed from the field still show, marked "(removed)".
 */
export function valueText(field: Field | undefined, value: FieldValue | null | undefined, refs: Refs = {}): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map((v) => valueText(field && { ...field, multiple: false }, v, refs)).join(", ");
	switch (field?.kind) {
		case "currency":
			return formatMoney(value as Money);
		case "date":
			return formatDay(String(value));
		case "checkbox":
			return value ? "Yes" : "";
		case "number":
			return typeof value === "number" ? value.toLocaleString() : String(value);
		case "choice": {
			const option = field.options?.find((o) => o.id === value);
			return option ? `${option.label}${option.retired ? " (removed)" : ""}` : String(value);
		}
		case "user":
		case "link": {
			const ref = refs[String(value)];
			if (!ref) return field.kind === "user" ? "Someone" : "…";
			return ref.archived ? `${ref.name} (archived)` : ref.name;
		}
		default:
			return typeof value === "object" ? JSON.stringify(value) : String(value);
	}
}

/** What an amount editor starts from: "1250.50" in the amount's own decimals. */
export function moneyInput(money: Money | undefined, digits: number) {
	if (!money) return "";
	const units = String(Math.abs(money.minor)).padStart(digits + 1, "0");
	return `${money.minor < 0 ? "-" : ""}${units.slice(0, units.length - digits)}${digits ? `.${units.slice(-digits)}` : ""}`;
}

// ---- History ----

/** "Ada", or "Companybot, for Ada" when an agent made the change for them. */
export const whoLabel = (entry: { user: string; agent: string | null }) => (entry.agent ? `${entry.agent}, for ${entry.user}` : entry.user);

export const actionLabels: Record<string, string> = { created: "Created", updated: "Changed", archived: "Archived", restored: "Restored" };
