/**
 * Changing a field's setup after it's made: its kind (Text → Choice), whether it holds several,
 * or the database it links to. Existing values convert the way Notion converts them, but the old
 * values are kept so the change can be undone. Pure rules here, shared by the server (which runs
 * the change in batches), the app's preview and agents. See wiki/data.md → Changing a field.
 */
import {
	type ChoiceOption,
	type Field,
	type FieldValue,
	type Money,
	MULTI_MAX,
	OPTIONS_MAX,
	TEXT_MAX,
	autoColor,
	formatDate,
	formatMoney,
	isCurrencyCode,
	keyOf,
	minorDigits,
	minorToDecimal,
	normalizeValue,
} from "./records";

/** What a field's values depend on. Its label and key never matter to them. */
export type FieldShape = Pick<Field, "kind" | "options" | "linkType" | "multiple">;

/** Whether going from `a` to `b` rewrites values: a new kind, one ↔ several, or another linked database. */
export const shapeChanged = (a: FieldShape, b: FieldShape) =>
	a.kind !== b.kind || !!a.multiple !== !!b.multiple || (a.linkType ?? null) !== (b.linkType ?? null);

/** Longest text that becomes a choice option; longer text doesn't fit and is cleared. */
export const OPTION_LABEL_MAX = 100;

/** What converting needs from outside: names and lookups the server has. */
export interface ConvertContext {
	/** The workspace's currency: amounts become this unless their text names another. */
	currency: string;
	/** A person's or record's name, for people and links becoming text. `undefined`: not known here. */
	name?: (id: string) => string | undefined;
	/** A teammate matching this name or email: their id, null for none, `undefined` if it can't be looked up here. */
	person?: (text: string) => string | null | undefined;
	/** A record in the field's new database named exactly this: its id, null for none or several, `undefined` if it can't be looked up here. */
	record?: (text: string) => string | null | undefined;
	/** → Choice: the option with this label (any case), made if there's room; null once the field is full. */
	option?: (label: string) => string | null;
}

/**
 * A value in its new shape (null: empty), with what didn't fit, as people read it ("n/a").
 * `unknown`: it needs a lookup this context can't do (while the server is still converting).
 */
export type Converted = { value: FieldValue | null; lost: string[] } | { unknown: true };

const several = (shape: FieldShape) => !!shape.multiple;

/** The value as people read it, one string per item. `undefined` when a name isn't known here. */
function textsOf(from: Field, value: FieldValue, ctx: ConvertContext): string[] | undefined {
	const items = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	// Asks for every name before giving up, so one lookup round finds them all.
	let unknown = false;
	for (const item of items) {
		if (typeof item === "object") out.push(formatMoney(item as Money, "en-US"));
		else if (typeof item === "boolean") out.push(item ? "Yes" : "No");
		else if (typeof item === "number") out.push(String(item));
		else if (from.kind === "date") out.push(formatDate(item, "en-US"));
		else if (from.kind === "choice") out.push(from.options?.find((o) => o.id === item)?.label ?? item);
		else if (from.kind === "user" || from.kind === "link") {
			const name = ctx.name?.(item);
			if (name === undefined) unknown = true;
			else if (name) out.push(name);
		} else out.push(item);
	}
	if (unknown) return undefined;
	return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * One value of `from` in the shape of `to`. Anything → Text keeps how it reads. Text → Number,
 * Amount, Date, Checkbox, Email, Phone or Website parses it, forgivingly ("$1,234.56" → 1234.56).
 * → Choice makes an option per distinct value; → Person matches a teammate's name or email;
 * → Link matches a record's exact name. Several → one keeps the first; one → several wraps.
 * What doesn't fit is cleared and listed in `lost`.
 */
export function convertValue(from: Field, to: Field, value: FieldValue, ctx: ConvertContext): Converted {
	// Same kind and database: only one ↔ several changes, and ids stay.
	if (from.kind === to.kind && (from.linkType ?? null) === (to.linkType ?? null)) {
		const items = Array.isArray(value) ? value : [value];
		if (several(to)) return { value: items.length ? (items.slice(0, MULTI_MAX) as string[]) : null, lost: [] };
		const [first, ...rest] = items;
		const lost = rest.length ? (textsOf(from, rest as FieldValue, ctx) ?? rest.map(String)) : [];
		return { value: first ?? null, lost };
	}
	const direct = directValue(from, to, value, ctx);
	if (direct) return direct;
	let parts = textsOf(from, value, ctx);
	if (!parts) return { unknown: true };
	if (to.kind === "text") {
		const text = parts.join(", ").slice(0, TEXT_MAX);
		return { value: text || null, lost: [] };
	}
	// Text becoming several picks reads "a, b" as two.
	if (several(to) && ["text", "email", "phone", "url"].includes(from.kind)) parts = parts.flatMap((p) => p.split(/\s*[,\n;]\s*/)).filter(Boolean);
	const kept: FieldValue[] = [];
	const lost: string[] = [];
	let unknown = false;
	for (const part of parts) {
		const one = several(to) || kept.length === 0 ? parseAs(to, part, ctx) : null;
		if (one === undefined) {
			unknown = true;
			continue;
		}
		if (one === null) {
			lost.push(part);
			continue;
		}
		if (one === EMPTY) continue;
		if (!kept.some((k) => JSON.stringify(k) === JSON.stringify(one))) kept.push(one);
	}
	if (unknown) return { unknown: true };
	if (!several(to)) return { value: kept[0] ?? null, lost };
	const ids = kept.slice(0, MULTI_MAX) as string[];
	return { value: ids.length ? ids : null, lost: [...lost, ...kept.slice(MULTI_MAX).map(String)] };
}

/** Conversions that don't go through text: amounts and numbers, checkboxes as numbers. */
function directValue(from: Field, to: Field, value: FieldValue, ctx: ConvertContext): Converted | null {
	if (from.kind === "currency" && to.kind === "number") {
		const money = value as Money;
		return { value: Number(minorToDecimal(money.minor, minorDigits(money.currency))), lost: [] };
	}
	if (from.kind === "number" && to.kind === "currency") {
		const money = moneyOf(String(value), ctx.currency);
		return money ? { value: money, lost: [] } : { value: null, lost: [String(value)] };
	}
	if (from.kind === "number" && to.kind === "checkbox") return { value: value !== 0 ? true : null, lost: [] };
	if (from.kind === "checkbox" && to.kind === "number") return { value: 1, lost: [] };
	return null;
}

/** Parsed, but nothing to store: "No" for a checkbox. */
const EMPTY = Symbol("empty");

/** One piece of text as a value of `to`; null if it doesn't fit, `undefined` if it needs a lookup this context can't do. */
function parseAs(to: Field, text: string, ctx: ConvertContext): FieldValue | null | undefined | typeof EMPTY {
	switch (to.kind) {
		case "number":
			return parseNumber(text);
		case "currency":
			return moneyOf(text, ctx.currency);
		case "date":
			return parseDay(text);
		case "checkbox": {
			const t = text.toLowerCase();
			if (["yes", "y", "true", "1", "x", "✓", "✔", "checked", "done", "on"].includes(t)) return true;
			if (["no", "n", "false", "0", "unchecked", "off", "-"].includes(t)) return EMPTY;
			return null;
		}
		case "email":
		case "phone":
		case "url": {
			const result = normalizeValue({ key: "x", label: "x", kind: to.kind }, text);
			return "error" in result ? null : result.value;
		}
		case "choice":
			if (text.length > OPTION_LABEL_MAX) return null;
			return ctx.option ? ctx.option(text) : undefined;
		case "user":
			return ctx.person ? ctx.person(text) : undefined;
		case "link":
			return ctx.record ? ctx.record(text) : undefined;
		case "text":
			return text;
	}
}

/** The bare number in "1,234", "$1,234.56", "-12.5", "EUR 40", "40 %", or null. */
function numberText(text: string) {
	const bare = text
		.trim()
		.replace(/^[a-z]{3}\s+|\s+[a-z]{3}$/i, "")
		.replace(/[$€£¥₹,\s%]/g, "")
		.replace(/^\+/, "");
	return /^-?(\d+\.?\d*|\.\d+)$/.test(bare) ? bare : null;
}

/** "1,234", "$1,234.56", "-12.5", "EUR 40", "40 %" → a number, or null. */
export function parseNumber(text: string): number | null {
	const bare = numberText(text);
	const n = bare === null ? Number.NaN : Number(bare);
	return Number.isFinite(n) ? n : null;
}

const symbols: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };
const dollars = ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"];

/** "$1,234.56", "EUR 12.50", "12.50 eur", "€40" → an amount; without a currency named, the workspace's. */
export function moneyOf(text: string, currency: string): Money | null {
	let rest = text.trim();
	let code: string | undefined;
	const named = rest.match(/^([a-z]{3})\s*(.+)$/i) ?? rest.match(/^(.+?)\s*([a-z]{3})$/i);
	if (named) {
		const [a, b] = [named[1]!, named[2]!];
		const which = isCurrencyCode(a.toUpperCase()) ? a : isCurrencyCode(b.toUpperCase()) ? b : null;
		if (!which) return null;
		code = which.toUpperCase();
		rest = which === a ? b : a;
	}
	const symbol = rest.match(/[€£¥₹$]/)?.[0];
	if (!code && symbol) code = symbol === "$" ? (dollars.includes(currency) ? currency : "USD") : symbols[symbol];
	const bare = numberText(rest);
	if (bare === null) return null;
	// The same exact rounding as typing an amount (half away from zero, in the currency's decimals).
	const result = normalizeValue({ key: "x", label: "x", kind: "currency" }, `${code ?? currency} ${bare}`);
	return "error" in result ? null : (result.value as Money);
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A day from text: "2026-11-15" (or with a time after it), "2026/11/15", "11/15/2026" (month first),
 * "Nov 15, 2026", "15 November 2026". Null if it isn't one.
 */
export function parseDay(text: string): string | null {
	const t = text.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
	let y: number | undefined, m: number | undefined, d: number | undefined;
	let match: RegExpMatchArray | null;
	if ((match = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[t\s])/))) [y, m, d] = [+match[1]!, +match[2]!, +match[3]!];
	else if ((match = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) [m, d, y] = [+match[1]!, +match[2]!, +match[3]!];
	else if ((match = t.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) [m, d, y] = [months.indexOf(match[1]!.slice(0, 3)) + 1, +match[2]!, +match[3]!];
	else if ((match = t.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/))) [d, m, y] = [+match[1]!, months.indexOf(match[2]!.slice(0, 3)) + 1, +match[3]!];
	if (!y || !m || !d) return null;
	if (y < 100) y += 2000;
	const at = new Date(Date.UTC(y, m - 1, d));
	if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
	return at.toISOString().slice(0, 10);
}

/**
 * Options for a field becoming a choice: `start` (typed by the person, or kept from before), then one
 * per distinct value met, matched by label in any case, up to OPTIONS_MAX. `made` lists the new ones; each
 * new one takes the next color in turn, as an added option does.
 */
export function optionMaker(start: ChoiceOption[] = []) {
	const options = start.map((o) => ({ ...o }));
	const made: string[] = [];
	const option = (label: string) => {
		const found = options.find((o) => !o.retired && o.label.toLowerCase() === label.toLowerCase());
		if (found) return found.id;
		if (options.length >= OPTIONS_MAX) return null;
		const id = keyOf(label, options.map((o) => o.id));
		options.push({ id, label, color: autoColor(options.length) });
		made.push(label);
		return id;
	};
	return { option, options, made };
}

/** Counts for a change, as the preview and the change itself report them. */
export interface ChangeCounts {
	/** Records with a value that were looked at. */
	checked: number;
	/** Values that took the new shape (unchanged ones included). */
	converted: number;
	/** Values that didn't fit at all and were cleared. */
	cleared: number;
	/** Values that kept some of what they had: several → one, or "a, n/a" → one choice. */
	partly: number;
	/** A few of the values that didn't fit, as people read them. */
	examples: string[];
}

export const emptyCounts = (): ChangeCounts => ({ checked: 0, converted: 0, cleared: 0, partly: 0, examples: [] });

const EXAMPLES_MAX = 5;

/** Adds one converted value to the counts. */
export function countChange(counts: ChangeCounts, result: { value: FieldValue | null; lost: string[] }) {
	counts.checked++;
	if (result.value === null && result.lost.length) counts.cleared++;
	else {
		counts.converted++;
		if (result.lost.length) counts.partly++;
	}
	for (const text of result.lost) {
		const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text;
		if (counts.examples.length < EXAMPLES_MAX && !counts.examples.includes(shown)) counts.examples.push(shown);
	}
}

/** Adds counts from a batch. */
export function addCounts(a: ChangeCounts, b: ChangeCounts): ChangeCounts {
	const examples = [...a.examples];
	for (const e of b.examples) if (examples.length < EXAMPLES_MAX && !examples.includes(e)) examples.push(e);
	return { checked: a.checked + b.checked, converted: a.converted + b.converted, cleared: a.cleared + b.cleared, partly: a.partly + b.partly, examples };
}

/** A list condition, as saved views and lists hold them. */
export interface Condition {
	field: string;
	eq?: unknown;
	in?: unknown[];
	gt?: unknown;
	gte?: unknown;
	lt?: unknown;
	lte?: unknown;
	empty?: boolean;
}

/**
 * Whether a filter on a field still fits after its setup changes. "Is empty" / "is not empty" always do.
 * Values were checked against the old kind or database, so they're kept only when those stay; ranges
 * stop fitting once it holds several.
 */
export function conditionFits(from: FieldShape, to: FieldShape, c: Condition) {
	if (c.eq === undefined && c.in === undefined && [c.gt, c.gte, c.lt, c.lte].every((x) => x === undefined)) return true;
	if (from.kind !== to.kind || (from.linkType ?? null) !== (to.linkType ?? null)) return false;
	const range = [c.gt, c.gte, c.lt, c.lte].some((x) => x !== undefined);
	return !(range && to.multiple);
}

/**
 * A saved filter on the field once it changes: as it was if it still fits; text "is X" becomes the
 * option labeled X when text turns into a choice, and one option becomes its label going back, as
 * values convert. Otherwise null: it's dropped.
 */
export function convertCondition(from: FieldShape, to: FieldShape, c: Condition): Condition | null {
	if (conditionFits(from, to, c)) return c;
	const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
	if (to.kind === "choice" && from.kind !== "choice" && typeof c.eq === "string") {
		const option = to.options?.find((o) => !o.retired && same(o.label, c.eq as string));
		return option ? { field: c.field, eq: option.id } : null;
	}
	const picked = c.eq !== undefined ? [c.eq] : c.in;
	if (from.kind === "choice" && to.kind === "text" && picked?.length === 1) {
		const option = from.options?.find((o) => o.id === picked[0]);
		return option ? { field: c.field, eq: option.label } : null;
	}
	return null;
}

/** Lists sort by single-valued fields other than links and checkboxes. */
export const sortsBy = (shape: FieldShape) => !shape.multiple && shape.kind !== "link" && shape.kind !== "checkbox";

/** Boards group by a choice field holding one option. */
export const groupsBy = (shape: FieldShape) => shape.kind === "choice" && !shape.multiple;

/** How a change reads: "Text → Choice", "holds one → holds several", "Clients → Deals". */
export function describeChange(from: FieldShape, to: FieldShape, kindLabel: (k: Field["kind"]) => string, databaseName: (id: string) => string = (id) => id) {
	const parts: string[] = [];
	if (from.kind !== to.kind) parts.push(`${kindLabel(from.kind)} → ${kindLabel(to.kind)}`);
	if (!!from.multiple !== !!to.multiple && from.kind === to.kind) parts.push(to.multiple ? "holds one → holds several" : "holds several → holds one");
	if (from.kind === "link" && to.kind === "link" && from.linkType !== to.linkType) parts.push(`${databaseName(from.linkType!)} → ${databaseName(to.linkType!)}`);
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}
