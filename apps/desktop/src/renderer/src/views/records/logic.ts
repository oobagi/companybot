import type { Field, FieldKind, FieldValue, Money } from "@companybot/core/records";
import { formatDate, formatMoney, minorToDecimal } from "@companybot/core/records";

// Pure rules for the record screens: columns, filters, sorting and how values read.
// Shared by every database, built-in or added later. See wiki/data.md.

/** A field as the app gets it from `recordTypes.list` (key, kind, options…), plus its id. */
export type TypeField = Field & { _id: string; archived?: boolean; canEdit?: boolean };
/** Names for user and record ids in a row's values. */
export type Refs = Record<string, { name: string; archived?: true }>;

/** Built-in types have their own tab; types owners add live under /records/<key>. */
/** The route of a type's list, or of one record. */
export const recordPath = (typeKey: string, recordId?: string) => ["records", typeKey, ...(recordId ? [recordId] : [])];

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

/** Boards group by a choice field that holds one option, so each card sits in one column. */
export const groupable = (field: Field) => field.kind === "choice" && !field.multiple;

// ---- Filters ----

type Op = "is" | "anyOf" | "gt" | "gte" | "lt" | "lte" | "empty" | "notEmpty" | "checked" | "unchecked";

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

/** Saved conditions back into the existing filter controls; ranges may have two bounds. */
export function fromConditions(conditions: { field: string; eq?: unknown; in?: unknown[]; empty?: boolean; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }[], fields: TypeField[] = []): Filter[] {
	return conditions.flatMap((c): Filter[] => {
		const kind = fields.find((f) => f.key === c.field)?.kind;
		const checkbox = kind === "checkbox";
		if (c.empty !== undefined) return [{ field: c.field, op: checkbox ? (c.empty ? "unchecked" : "checked") : c.empty ? "empty" : "notEmpty", value: "" }];
		if (c.in) return [{ field: c.field, op: "anyOf", value: c.in.map(String) }];
		if (c.eq !== undefined) {
			if (checkbox) return [{ field: c.field, op: c.eq ? "checked" : "unchecked", value: "" }];
			if (kind && anyOfKinds.includes(kind)) return [{ field: c.field, op: "anyOf", value: [String(c.eq)] }];
			return [{ field: c.field, op: "is", value: String(c.eq) }];
		}
		return (["gt", "gte", "lt", "lte"] as const).filter((op) => c[op] !== undefined).map((op) => ({ field: c.field, op, value: String(c[op]) }));
	});
}

// ---- Values ----

/**
 * One stored value as text. Links and people read from `refs`; a record in Trash or
 * deleted says so. Options that were removed from the field still show, marked "(removed)".
 */
export function valueText(field: Field | undefined, value: FieldValue | null | undefined, refs: Refs = {}): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map((v) => valueText(field && { ...field, multiple: false }, v, refs)).join(", ");
	switch (field?.kind) {
		case "currency":
			return formatMoney(value as Money);
		case "date":
			return formatDate(String(value));
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
	return money ? minorToDecimal(money.minor, digits) : "";
}

// ---- History ----

/** "Ada", or "Companybot, for Ada" when an agent made the change for them. */
export const whoLabel = (entry: { user: string; agent: string | null }) => (entry.agent ? `${entry.agent}, for ${entry.user}` : entry.user);

/** History actions in words. `archived` is the stored name for moving to Trash. */
export const actionLabels: Record<string, string> = { created: "Created", updated: "Changed", archived: "Archived", restored: "Restored", deleted: "Deleted" };
