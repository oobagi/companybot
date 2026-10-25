/**
 * Business records: clients, deals, tasks, calls, and any type a workspace adds.
 * Every type is data (a record type plus its fields), so a new type or field is
 * a row, never a migration. Pure rules here; storage in backend/convex/recordOps.ts.
 * See wiki/data.md.
 */

export const fieldKinds = [
	"text",
	"number",
	"currency",
	"date",
	"checkbox",
	"choice",
	"email",
	"phone",
	"url",
	"user",
	"link",
] as const;
export type FieldKind = (typeof fieldKinds)[number];

/**
 * A stored value. Empty values (and unchecked boxes) aren't stored. Dates are "YYYY-MM-DD";
 * currency is `Money`; choices, people and links are ids.
 */
export type FieldValue = string | number | boolean | string[] | Money;

/**
 * An amount and its own currency, like Stripe and HubSpot store it: changing the workspace's
 * currency never relabels it. `minor` is the amount in the currency's smallest unit (ISO 4217,
 * like Stripe): $12.50 is 1250, ¥100 is 100, KWD 1.250 is 1250. Keys in this order, as Convex
 * returns them, so `sameValue` can compare JSON.
 */
export interface Money {
	minor: number;
	/** ISO 4217, one of `currencyCodes`. */
	currency: string;
}

export interface ChoiceOption {
	/** Stable: stored on records, so renaming an option changes nothing else. */
	id: string;
	label: string;
	/** Removed from the field. Records keep it and it can be filtered on, but it can't be set again. */
	retired?: boolean;
}

/** What someone picks when they add a field. */
export interface FieldConfig {
	label: string;
	kind: FieldKind;
	/** `choice` only. */
	options?: ChoiceOption[];
	/** `link` only: the record type it points at. */
	linkType?: string;
	/** `choice`, `user` and `link` only: holds several. */
	multiple?: boolean;
}

export interface Field extends FieldConfig {
	/** Where its value lives on a record (`values[key]`). Set once from the label; never changes. */
	key: string;
}

/** Every type has it. Its value is the record's title. */
export const NAME_KEY = "name";

export const FIELD_LABEL_MAX = 60;
export const FIELDS_PER_TYPE_MAX = 100;
export const OPTIONS_MAX = 100;
export const TEXT_MAX = 10_000;
/** Most values a `multiple` field holds. */
export const MULTI_MAX = 50;
/**
 * Most a record's values may take, as JSON bytes. History stores a change's old and new
 * values together, so this keeps both the record and any history entry well under
 * Convex's 1 MiB document limit, and a page of records under a query's read limit.
 */
export const RECORD_MAX_BYTES = 128 * 1024;
/** Text up to this long is indexed as is; longer text by a prefix plus a hash of the rest. */
const INDEX_CHARS = 100;
const INDEX_PREFIX = 80;

export const valuesBytes = (values: Record<string, FieldValue>) => new TextEncoder().encode(JSON.stringify(values)).length;

/** The workspace's currency when it hasn't picked one. New amounts default to the workspace's. */
export const DEFAULT_CURRENCY = "USD";

/** ISO 4217 codes for currencies in use. */
export const currencyCodes = (
	"AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF " +
	"CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL " +
	"HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD " +
	"MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG " +
	"QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD " +
	"TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
).split(" ");

/** ISO 4217 minor-unit digits that aren't 2. */
const minorDigitsOf: Record<string, number> = {
	...Object.fromEntries("BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV XAF XOF XPF".split(" ").map((c) => [c, 0])),
	...Object.fromEntries("BHD IQD JOD KWD LYD OMR TND".split(" ").map((c) => [c, 3])),
};

/** Decimals in a currency's smallest unit: JPY 0, USD 2, KWD 3. */
export const minorDigits = (code: string) => minorDigitsOf[code] ?? 2;

/** An amount for people, in the currency's own decimals: "$1,250.50", "¥100", "KWD 1.250". */
export function formatMoney({ minor, currency }: Money, locale?: string) {
	const digits = minorDigits(currency);
	// Built as an exact decimal string, so large amounts don't pick up float error.
	const units = String(Math.abs(minor)).padStart(digits + 1, "0");
	const decimal = `${minor < 0 ? "-" : ""}${units.slice(0, units.length - digits)}${digits ? `.${units.slice(-digits)}` : ""}`;
	return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
		decimal as Intl.StringNumericLiteral,
	);
}

export const isCurrencyCode = (code: unknown): code is string => typeof code === "string" && currencyCodes.includes(code);

/** A key from a label: "Roof type" → "roof_type", unique among `taken`. */
export function keyOf(label: string, taken: Iterable<string>) {
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 40) || "field";
	const safe = /^[a-z]/.test(base) ? base : `f_${base}`;
	const used = new Set(taken);
	let key = safe;
	for (let n = 2; used.has(key); n++) key = `${safe}_${n}`;
	return key;
}

/** Trims labels and gives new options an id. `options` may come without ids (labels only). */
export function normalizeFieldConfig(config: Omit<FieldConfig, "options"> & { options?: (Omit<ChoiceOption, "id"> & { id?: string })[] }): FieldConfig {
	const ids: string[] = [];
	const options = config.options?.map((o) => {
		const id = o.id || keyOf(o.label, ids);
		ids.push(id);
		return { id, label: o.label.trim(), ...(o.retired && { retired: true }) };
	});
	return {
		label: config.label.trim(),
		kind: config.kind,
		...(options && { options }),
		...(config.linkType && { linkType: config.linkType }),
		...(config.multiple && { multiple: true }),
	};
}

/** The first problem with a field's setup, in a line, or null. */
export function fieldConfigError(config: FieldConfig): string | null {
	const { label, kind, options, linkType, multiple } = config;
	if (!label) return "Give the field a name.";
	if (label.length > FIELD_LABEL_MAX) return `Keep the field name under ${FIELD_LABEL_MAX} characters.`;
	if (/[\r\n]/.test(label)) return "Keep the field name to one line.";
	if (!fieldKinds.includes(kind)) return `A field is one of: ${fieldKinds.join(", ")}.`;
	if (kind === "choice") {
		if (!options?.length) return "A choice field needs at least one option.";
		if (options.length > OPTIONS_MAX) return `A choice field holds up to ${OPTIONS_MAX} options.`;
		if (options.every((o) => o.retired)) return "A choice field needs at least one option.";
		if (options.some((o) => !o.label)) return "Every option needs a name.";
		const labels = options.filter((o) => !o.retired).map((o) => o.label.toLowerCase());
		if (new Set(labels).size !== labels.length) return "Two options have the same name.";
		if (new Set(options.map((o) => o.id)).size !== options.length) return "Two options have the same id.";
	} else if (options) return "Only choice fields have options.";
	if (kind === "link" && !linkType) return "Pick the record type this field links to.";
	if (kind !== "link" && linkType) return "Only link fields point at a record type.";
	if (multiple && !["choice", "user", "link"].includes(kind)) return "Only choice, person and link fields can hold several.";
	return null;
}

export type Normalized = { value: FieldValue | null } | { error: string };

/**
 * `input`: what a person or agent typed. Currency: an amount in whole units ("1,250.50",
 * "EUR 12.50", 12.5, or `{ amount, currency? }`); without a code it's the workspace's.
 * `stored`: a value from storage being set again, e.g. by undo (currency as `Money`).
 * `filter`: a value to match; retired options are allowed, to find records still using them.
 */
export type ValueMode = "input" | "stored" | "filter";

const isEmpty = (raw: unknown) => raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0);

/**
 * Turns what a person or agent typed into the stored value (null clears it), or says
 * what's wrong. Choices accept an option's id or label. `user` and `link` ids are
 * checked against the workspace by the backend.
 */
export function normalizeValue(field: Field, raw: unknown, mode: ValueMode = "input", currency = DEFAULT_CURRENCY): Normalized {
	if (isEmpty(raw)) return { value: null };
	const label = `“${field.label}”`;
	if (field.multiple) {
		const items = Array.isArray(raw) ? raw : [raw];
		if (items.length > MULTI_MAX) return { error: `${label} holds up to ${MULTI_MAX}.` };
		const out: string[] = [];
		for (const item of items) {
			const one = normalizeOne(field, item, label, mode, currency);
			if ("error" in one) return one;
			if (typeof one.value === "string" && !out.includes(one.value)) out.push(one.value);
		}
		return { value: out.length ? out : null };
	}
	if (Array.isArray(raw)) return { error: `${label} holds one value.` };
	return normalizeOne(field, raw, label, mode, currency);
}

function normalizeOne(field: Field, raw: unknown, label: string, mode: ValueMode, currency: string): Normalized {
	const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : null;
	switch (field.kind) {
		case "text":
			if (text === null) return { error: `${label} is text.` };
			if (text.length > TEXT_MAX) return { error: `Keep ${label} under ${TEXT_MAX.toLocaleString("en-US")} characters.` };
			return { value: text || null };
		case "number": {
			const n = typeof raw === "number" ? raw : text ? Number(text.replace(/[,\s]/g, "")) : Number.NaN;
			return Number.isFinite(n) ? { value: n } : { error: `${label} is a number.` };
		}
		case "currency": {
			const money = mode === "stored" ? (raw as Money | null) : toMoney(raw, currency);
			if (!money || !isCurrencyCode(money.currency)) {
				return { error: money ? `${label} needs a currency code like USD or EUR.` : `${label} is an amount like 1250.50.` };
			}
			if (!Number.isSafeInteger(money.minor)) return { error: `${label} is an amount like 1250.50.` };
			return { value: { minor: money.minor, currency: money.currency } };
		}
		case "date": {
			const day = text?.slice(0, 10) ?? "";
			const ok = /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
			return ok ? { value: day } : { error: `${label} is a date like 2026-10-25.` };
		}
		case "checkbox":
			// Unchecked is empty, like any other empty value.
			if (raw === true || text === "true") return { value: true };
			if (raw === false || text === "false") return { value: null };
			return { error: `${label} is true or false.` };
		case "choice": {
			const options = field.options?.filter((o) => mode === "filter" || !o.retired) ?? [];
			const option = options.find((o) => o.id === text || o.label.toLowerCase() === text?.toLowerCase());
			if (!option) return { error: `${label} is one of: ${options.map((o) => o.label).join(", ")}.` };
			return { value: option.id };
		}
		case "email":
			if (!text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { error: `${label} is an email address.` };
			return { value: text.toLowerCase() };
		case "phone":
			if (!text || !/^\+?[\d\s().-]+$/.test(text) || text.replace(/\D/g, "").length < 7)
				return { error: `${label} is a phone number.` };
			return { value: text };
		case "url": {
			const href = text && !/^[a-z]+:\/\//i.test(text) ? `https://${text}` : text;
			try {
				const url = new URL(href ?? "");
				if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
				return { value: url.href };
			} catch {
				return { error: `${label} is a web address.` };
			}
		}
		case "user":
		case "link":
			return text ? { value: text } : { error: `${label} is an id.` };
	}
}

/** What someone typed as an amount, with its currency code if they gave one. */
function toMoney(raw: unknown, currency: string): Money | null {
	if (raw && typeof raw === "object" && "amount" in raw) {
		const { amount, currency: code } = raw as { amount: unknown; currency?: unknown };
		return toMoney(amount, typeof code === "string" ? code.toUpperCase() : currency);
	}
	const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
	const match = text?.match(/^(?:([a-z]{3})\s*)?([^a-z]*?)(?:\s*([a-z]{3}))?$/i);
	if (!match) return null;
	const code = (match[1] ?? match[3])?.toUpperCase() ?? currency;
	return { minor: toMinor(match[2]!, minorDigits(code)), currency: code };
}

/**
 * Whole units ("1,250.505", 12.5) to the smallest unit with `digits` decimals, rounding half
 * away from zero on the exact decimal (USD 1.005 → 101, JPY 99.5 → 100). NaN if it isn't an
 * amount or isn't a safe integer.
 */
function toMinor(text: string | null, digits: number) {
	const match = text?.replace(/[$€£¥,\s]/g, "").match(/^(-?)(\d*)(?:\.(\d*))?$/);
	const [, sign, whole = "", frac = ""] = match ?? [];
	if (!whole && !frac) return Number.NaN;
	let minor = BigInt(whole + frac.padEnd(digits, "0").slice(0, digits));
	if (Number(frac[digits] ?? 0) >= 5) minor += 1n;
	if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return Number.NaN;
	return Number(sign ? -minor : minor) || 0;
}

/** One index entry for a value: text and ids by `str`, numbers by `num`, links by `ref`. */
export type IndexEntry = { str: string } | { num: number } | { ref: string } | { str: string; num: number };

/** How a stored value is indexed, so lists can filter and sort by any field without a scan. */
export function indexEntries(field: Field, value: FieldValue | null | undefined): IndexEntry[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((v) => indexEntries({ ...field, multiple: false }, v));
	switch (field.kind) {
		case "number":
			return [{ num: value as number }];
		case "currency":
			// Grouped by currency, then by amount: amounts only compare within one currency.
			return [{ str: (value as Money).currency, num: (value as Money).minor }];
		case "checkbox":
			return [{ num: 1 }];
		case "link":
			return [{ ref: String(value) }];
		case "phone":
			return [{ str: String(value).replace(/\D/g, "") }];
		case "text":
		case "email":
		case "url":
			return [{ str: textKey(String(value)) }];
		default:
			return [{ str: String(value) }];
	}
}

/**
 * Case-insensitive. Short text is its own key; longer text keys by its first 80 characters
 * plus a hash of all of it, so equal keys almost always mean equal text (check with
 * `sameText`) and sorting goes by the first 80 characters.
 */
function textKey(value: string) {
	const lower = value.toLowerCase();
	return lower.length <= INDEX_CHARS ? lower : `${lower.slice(0, INDEX_PREFIX)}#${hash(lower)}`;
}

/** Two FNV-1a passes: 16 hex characters. Not secure; text keys catch collisions with `sameText`. */
export function hash(text: string) {
	const fnv = (seed: number) => {
		let h = seed;
		for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
		return (h >>> 0).toString(16).padStart(8, "0");
	};
	return fnv(2166136261) + fnv(0x9747b28c);
}

/** Whether a stored text-like value equals what a filter asked for, beyond its index key. */
export const sameText = (field: Field, stored: FieldValue | undefined, wanted: FieldValue) =>
	!["text", "email", "url"].includes(field.kind) || String(stored).toLowerCase() === String(wanted).toLowerCase();

/** Text worth searching: the title and other text-like values. */
export function searchTextOf(fields: Field[], values: Record<string, FieldValue>) {
	const kinds: FieldKind[] = ["text", "email", "phone", "url"];
	return fields
		.filter((f) => kinds.includes(f.kind) && typeof values[f.key] === "string")
		.map((f) => values[f.key] as string)
		.join("\n")
		.slice(0, TEXT_MAX);
}

export const sameValue = (a: FieldValue | null | undefined, b: FieldValue | null | undefined) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---- Built-in types ----

/** A type every workspace starts with. `linkType` names another built-in by key. */
export interface RecordTypeDef {
	key: string;
	name: string;
	plural: string;
	fields: Field[];
}

const options = (...labels: string[]) => labels.map((label) => ({ id: keyOf(label, []), label }));

export const recordTypeCatalog: RecordTypeDef[] = [
	{
		key: "client",
		name: "Client",
		plural: "Clients",
		fields: [
			{ key: NAME_KEY, label: "Name", kind: "text" },
			{ key: "status", label: "Status", kind: "choice", options: options("Lead", "Active", "Past") },
			{ key: "email", label: "Email", kind: "email" },
			{ key: "phone", label: "Phone", kind: "phone" },
			{ key: "address", label: "Address", kind: "text" },
			{ key: "website", label: "Website", kind: "url" },
			{ key: "owner", label: "Owner", kind: "user" },
		],
	},
	{
		key: "deal",
		name: "Deal",
		plural: "Deals",
		fields: [
			{ key: NAME_KEY, label: "Name", kind: "text" },
			{ key: "client", label: "Client", kind: "link", linkType: "client" },
			{ key: "stage", label: "Stage", kind: "choice", options: options("New", "Qualified", "Proposal", "Won", "Lost") },
			{ key: "value", label: "Value", kind: "currency" },
			{ key: "close_date", label: "Close date", kind: "date" },
			{ key: "owner", label: "Owner", kind: "user" },
		],
	},
	{
		key: "task",
		name: "Task",
		plural: "Tasks",
		fields: [
			{ key: NAME_KEY, label: "Task", kind: "text" },
			{ key: "status", label: "Status", kind: "choice", options: options("To do", "Doing", "Done") },
			{ key: "due", label: "Due", kind: "date" },
			{ key: "assignee", label: "Assignee", kind: "user" },
			{ key: "client", label: "Client", kind: "link", linkType: "client" },
			{ key: "deal", label: "Deal", kind: "link", linkType: "deal" },
		],
	},
	{
		key: "call",
		name: "Call",
		plural: "Calls",
		fields: [
			{ key: NAME_KEY, label: "Title", kind: "text" },
			{ key: "client", label: "Client", kind: "link", linkType: "client" },
			{ key: "deal", label: "Deal", kind: "link", linkType: "deal" },
			{ key: "direction", label: "Direction", kind: "choice", options: options("Inbound", "Outbound") },
			{ key: "date", label: "Date", kind: "date" },
			{ key: "minutes", label: "Minutes", kind: "number" },
			{ key: "summary", label: "Summary", kind: "text" },
		],
	},
];
