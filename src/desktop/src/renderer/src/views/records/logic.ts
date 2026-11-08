import type { Field, FieldKind, FieldValue, Money } from "@companybot/core/records";
import { formatDate, formatMoney, kindLabels, minorToDecimal } from "@companybot/core/records";
import { moneyOf, parseDay, parseNumber } from "@companybot/core/field-change";

// Pure rules for the record screens: columns, filters, sorting and how values read.
// Shared by every database, built-in or added later. See wiki/data.md.

/** A field as the app gets it from `recordTypes.list` (key, kind, options…), plus its id. */
export type TypeField = Field & { _id: string; archived?: boolean; canEdit?: boolean; /** Its kind is changing: values are converting, so they can't be edited. */ changing?: true };
/** Names for user and record ids in a row's values. */
/** `locked`: a record in a database you can't see; its name isn't sent (backend `resolveRefs`). */
export type Refs = Record<string, { name: string; archived?: true; locked?: true }>;

/** Built-in types have their own tab; types owners add live under /records/<key>. */
/** The route of a type's list, or of one record. */
export const recordPath = (typeKey: string, recordId?: string) => ["records", typeKey, ...(recordId ? [recordId] : [])];

export { kindLabels } from "@companybot/core/records";

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

/** "a date field", "an amount field": the field's kind as people say it. */
function aKind(field: Field) {
	const kind = kindLabels[field.kind].toLowerCase();
	return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
}

/**
 * Why a filter no longer fits its field, or undefined if it does. One made before the field
 * changed may not ("is abc" on what's now a number); lists drop it and say why.
 */
export function filterProblem(filter: Filter, field: Field): string | undefined {
	if (!opsFor(field).includes(filter.op)) return `it's ${aKind(field)} field now, and that filter doesn't work on those`;
	if (filter.op === "anyOf") {
		if (!Array.isArray(filter.value)) return `it's ${aKind(field)} field now, and that filter doesn't work on those`;
		if (field.kind === "choice" && !filter.value.every((v) => field.options?.some((o) => o.id === v))) return "an option it picked was removed";
		return undefined;
	}
	if (!needsValue(filter.op)) return undefined;
	if (Array.isArray(filter.value)) return `it's ${aKind(field)} field now, and that filter doesn't work on those`;
	const text = filter.value.trim();
	if (!text) return undefined;
	const valid = field.kind === "number" ? parseNumber(text) !== null : field.kind === "currency" ? moneyOf(text, "USD") !== null : field.kind === "date" ? parseDay(text) !== null : true;
	return valid ? undefined : `“${text}” isn't ${field.kind === "currency" ? "an amount" : `a ${field.kind}`}`;
}

/**
 * A filter made before its field turned into a choice, as one on the option with its text for a
 * label ("is Test" → "is any of Test"), like the values converted; undefined if it can't be.
 */
export function refitFilter<F extends Filter>(filter: F, field: Field): F | undefined {
	if (field.kind !== "choice" || filter.op !== "is" || Array.isArray(filter.value)) return undefined;
	const text = filter.value.trim().toLowerCase();
	const option = field.options?.find((o) => !o.retired && o.label.trim().toLowerCase() === text);
	return option && { ...filter, op: "anyOf", value: [option.id] };
}

/** Why a list can't be sorted by the field now, or undefined if it can. */
export function sortProblem(field: Field): string | undefined {
	if (sortable(field)) return undefined;
	return field.multiple ? "it holds several values now, and those can't be sorted" : `it's ${aKind(field)} field now, and those can't be sorted`;
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
			if (ref.locked) return "Locked record";
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
