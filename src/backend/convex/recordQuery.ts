import { type FieldValue, indexEntries, normalizeValue, sameText } from "@companybot/core";
import type { PaginationResult } from "convex/server";
import { ConvexError, getDocumentSize } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { toField } from "./recordOps";

// Record lists with any combination of filters (AND) and one sort. See wiki/data.md.
//
// Plan: one index drives the scan, in the order the list comes back; every condition is
// then checked against the record itself. The driver is the sort field when there is a
// sort; otherwise the most selective equality or "any of" condition (found by counting a
// few index rows), then the most selective range, then the type's own index. Equality
// rows are ordered by the record's creation time (`at`), so they keep "newest first",
// and several "any of" streams merge by it.
//
// Work is bounded: a request reads at most SCAN_ROWS index rows or SCAN_BYTES of records.
// If that runs out before the page fills, it returns what it found with `isDone: false`
// and a cursor to carry on, like Convex's own filtered pagination.

export interface Condition {
	field: string;
	eq?: unknown;
	in?: unknown[];
	gt?: unknown;
	gte?: unknown;
	lt?: unknown;
	lte?: unknown;
	/** true: has no value; false: has one. */
	empty?: boolean;
}
export type Sort = { field: string; order: "asc" | "desc" };

export const CONDITIONS_MAX = 10;
export const ANY_OF_MAX = 50;
const SCAN_ROWS = 1_000;
const SCAN_BYTES = 6 * 1024 * 1024;
/** Index rows read at a time from each stream. */
const CHUNK = 100;
/** Index rows counted per candidate when picking the driver. */
const PROBE = 200;

type Fields = Doc<"recordFields">[];
type Values = Record<string, FieldValue>;
type Entry = { str?: string; num?: number; ref?: string };
type Key = (string | number)[];
type Bound = { v: string | number; incl: boolean };

/** One index range, read in order of `keys` (the index fields after `prefix`; the last is unique per record). */
interface Stream {
	table: "records" | "recordValues";
	index: string;
	prefix: [string, unknown][];
	keys: string[];
	lo?: Bound;
	hi?: Bound;
}

/** A condition, checked and ready: what it accepts, and how it could drive the scan. */
interface Check {
	field: Doc<"recordFields">;
	test: (values: Values) => boolean;
	/** Equality or "any of": one stream per value, each ordered by `at`. */
	eqStreams?: Stream[];
	/** Range or "has a value": one stream, ordered by the value. */
	rangeStream?: Stream;
}

const rangeKinds = ["number", "currency", "date"];
const anyOfKinds = ["choice", "user", "link"];

/** A condition's value as the index stores it, checked like a saved value. */
function entryOf(field: Doc<"recordFields">, raw: unknown, currency: string): Entry {
	const result = normalizeValue({ ...toField(field), multiple: false }, raw, "filter", currency);
	if ("error" in result) throw new ConvexError(result.error);
	const [entry] = indexEntries(toField(field), result.value);
	if (!entry) throw new ConvexError(`Pick a value for “${field.label}”.`);
	return entry;
}

const sameEntry = (a: Entry, b: Entry) => a.str === b.str && a.num === b.num && a.ref === b.ref;

/** Where rows for this field and value live, ordered by `at`. */
function eqStream(field: Doc<"recordFields">, e: Entry): Stream {
	const s = (index: string, prefix: [string, unknown][]): Stream => ({ table: "recordValues", index, prefix, keys: ["at"] });
	if (field.kind === "link") return s("by_ref", [["ref", e.ref], ["fieldId", field._id]]);
	if (field.kind === "currency") return s("by_field_money", [["fieldId", field._id], ["str", e.str], ["num", e.num]]);
	if (e.num !== undefined) return s("by_field_num", [["fieldId", field._id], ["num", e.num]]);
	return s("by_field_str", [["fieldId", field._id], ["str", e.str]]);
}

/** Rows for this field in value order, optionally within bounds (and one currency). */
function valueStream(field: Doc<"recordFields">, lo?: Bound, hi?: Bound, code?: string): Stream {
	const base = { table: "recordValues" as const, lo, hi };
	if (field.kind === "currency")
		return code
			? { ...base, index: "by_field_money", prefix: [["fieldId", field._id], ["str", code]], keys: ["num", "at"] }
			: { ...base, index: "by_field_money", prefix: [["fieldId", field._id]], keys: ["str", "num", "at"] };
	if (field.kind === "number" || field.kind === "checkbox") return { ...base, index: "by_field_num", prefix: [["fieldId", field._id]], keys: ["num", "at"] };
	return { ...base, index: "by_field_str", prefix: [["fieldId", field._id]], keys: ["str", "at"] };
}

/** Checks one condition and works out how it can be tested and driven. */
export async function compile(ctx: QueryCtx, fields: Fields, c: Condition, currency: string): Promise<Check> {
	const field = fields.find((f) => f.key === c.field && !f.archived);
	if (!field) throw new ConvexError(`There's no field “${c.field}”.`);
	const name = `“${field.label}”`;
	const entries = (values: Values) => indexEntries(toField(field), values[field.key]) as Entry[];
	const kinds = (["eq", "in", "empty"] as const).filter((k) => c[k] !== undefined);
	const range = (["gt", "gte", "lt", "lte"] as const).filter((k) => c[k] !== undefined);
	if (kinds.length + (range.length ? 1 : 0) !== 1) throw new ConvexError(`Give ${name} one condition: eq, in, a range, or empty.`);

	if (c.empty !== undefined) {
		const want = c.empty;
		// Only single values can drive "has a value": several would list a record more than once.
		return { field, test: (v) => (v[field.key] === undefined) === want, ...(!want && !field.multiple && field.kind !== "link" && { rangeStream: valueStream(field) }) };
	}
	if (c.eq !== undefined || c.in !== undefined) {
		if (c.in !== undefined && !anyOfKinds.includes(field.kind)) throw new ConvexError(`“Any of” works on choice, person and link fields, not ${name}.`);
		const raws = c.in ?? [c.eq];
		if (raws.length === 0 || raws.length > ANY_OF_MAX) throw new ConvexError(`Pick 1 to ${ANY_OF_MAX} values for ${name}.`);
		let wanted = raws.map((raw) => entryOf(field, raw, currency));
		// Links to an archived record match nothing (wiki/data.md).
		if (field.kind === "link") {
			const live = [];
			for (const e of wanted) if (!(await ctx.db.get(e.ref as Id<"records">))?.archived) live.push(e);
			wanted = live;
		}
		// Long text keys by a hash, so a match is checked against the text itself.
		const text = c.eq !== undefined && (normalizeValue(toField(field), c.eq, "filter", currency) as { value: FieldValue }).value;
		return {
			field,
			test: (v) => entries(v).some((e) => wanted.some((w) => sameEntry(e, w))) && (!text || sameText(toField(field), v[field.key], text)),
			eqStreams: wanted.map((e) => eqStream(field, e)),
		};
	}
	if (field.multiple || !rangeKinds.includes(field.kind)) throw new ConvexError(`Ranges work on number, amount and date fields, not ${name}.`);
	const bound = (raw: unknown, incl: boolean): (Bound & { code?: string }) | undefined => {
		if (raw === undefined) return undefined;
		const e = entryOf(field, raw, currency);
		return field.kind === "date" ? { v: e.str!, incl } : { v: e.num!, incl, ...(field.kind === "currency" && { code: e.str }) };
	};
	const lo = bound(c.gt, false) ?? bound(c.gte, true);
	const hi = bound(c.lt, false) ?? bound(c.lte, true);
	if (lo?.code && hi?.code && lo.code !== hi.code) throw new ConvexError("Compare amounts in one currency.");
	const code = lo?.code ?? hi?.code;
	const inRange = (x: string | number) =>
		(!lo || (lo.incl ? x >= lo.v : x > lo.v)) && (!hi || (hi.incl ? x <= hi.v : x < hi.v));
	return {
		field,
		test: (v) =>
			entries(v).some((e) => {
				if (field.kind === "date") return inRange(e.str!);
				return (field.kind === "number" || e.str === code) && inRange(e.num!);
			}),
		rangeStream: valueStream(field, lo && { v: lo.v, incl: lo.incl }, hi && { v: hi.v, incl: hi.incl }, code),
	};
}

/** Index rows after `after` (exclusive), in order, up to `limit`. A lexicographic seek: one range per key position. */
async function seek(ctx: QueryCtx, s: Stream, order: "asc" | "desc", after: Key | undefined, limit: number) {
	const out: (Doc<"records"> | Doc<"recordValues">)[] = [];
	const positions = after ? s.keys.map((_, i) => s.keys.length - 1 - i) : [0];
	for (const p of positions) {
		if (out.length >= limit) break;
		const rows = await ctx.db
			.query(s.table)
			// The index and its fields vary by stream, so the range is built untyped.
			// biome-ignore lint/suspicious/noExplicitAny: see above
			.withIndex(s.index as any, (q: any) => {
				let r = q;
				for (const [f, value] of s.prefix) r = r.eq(f, value);
				for (let i = 0; i < p; i++) r = r.eq(s.keys[i], after![i]);
				const k = s.keys[p];
				let lo = p === 0 ? s.lo : undefined;
				let hi = p === 0 ? s.hi : undefined;
				if (after) {
					if (order === "asc") lo = { v: after[p]!, incl: false };
					else hi = { v: after[p]!, incl: false };
				}
				if (lo) r = lo.incl ? r.gte(k, lo.v) : r.gt(k, lo.v);
				if (hi) r = hi.incl ? r.lte(k, hi.v) : r.lt(k, hi.v);
				return r;
			})
			.order(order)
			.take(limit - out.length);
		out.push(...rows);
	}
	return out;
}

const keyOf = (s: Stream, row: Record<string, unknown>) => s.keys.map((k) => row[k] as string | number);
const compareKeys = (a: Key, b: Key) => {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
	return 0;
};

/** The streams for a plan id: "t" type, "u" updated, "s" sort field, or "c<i>" condition i. */
function streamsFor(plan: string, typeId: Id<"recordTypes">, archived: boolean, checks: Check[], sortStream?: Stream): Stream[] {
	if (plan === "t" || plan === "u")
		return [{ table: "records", index: plan === "t" ? "by_type" : "by_type_updated", prefix: [["typeId", typeId], ["archived", archived]], keys: plan === "t" ? ["_creationTime"] : ["updatedAt", "_creationTime"] }];
	if (plan === "s" && sortStream) return [sortStream];
	const check = checks[Number(plan.slice(1))];
	const streams = check?.eqStreams ?? (check?.rangeStream && [check.rangeStream]);
	if (!streams) throw new ConvexError("That page is out of date. Start the list again.");
	return streams;
}

/** Picks the driver: the sort, else the fewest rows among equalities, else among ranges, else the type. */
async function choosePlan(ctx: QueryCtx, checks: Check[], sort: Sort | undefined, sortStream: Stream | undefined) {
	if (sortStream) return "s";
	if (sort?.field === "updatedAt") return "u";
	const count = async (streams: Stream[]) => {
		let n = 0;
		for (const s of streams) n += (await seek(ctx, s, "asc", undefined, PROBE + 1 - n)).length;
		return n;
	};
	for (const kind of ["eqStreams", "rangeStream"] as const) {
		let best: { plan: string; n: number } | undefined;
		for (const [i, check] of checks.entries()) {
			const streams = kind === "eqStreams" ? check.eqStreams : check.rangeStream && [check.rangeStream];
			if (!streams) continue;
			const n = await count(streams);
			if (!best || n < best.n) best = { plan: `c${i}`, n };
		}
		if (best) return best.plan;
	}
	return "t";
}

/**
 * One page of `typeId`'s records matching every condition. Order: the sort if given;
 * otherwise newest first, unless a range drives the scan, which lists in that field's order.
 */
export async function findRecords(
	ctx: QueryCtx,
	{ typeId, archived, fields, conditions, sort, currency, paginationOpts }: {
		typeId: Id<"recordTypes">;
		archived: boolean;
		fields: Fields;
		conditions: Condition[];
		sort?: Sort;
		currency: string;
		paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null };
	},
): Promise<PaginationResult<Doc<"records">>> {
	if (conditions.length > CONDITIONS_MAX) throw new ConvexError(`Use up to ${CONDITIONS_MAX} filters.`);
	const checks = await Promise.all(conditions.map((c) => compile(ctx, fields, c, currency)));
	const byField = sort && !["createdAt", "updatedAt"].includes(sort.field);
	// Archived records have no index rows, so their lists scan the type and check every condition.
	if (archived && byField) throw new ConvexError("Archived records can't be sorted by a field.");
	let sortStream: Stream | undefined;
	if (byField) {
		const field = fields.find((f) => f.key === sort.field && !f.archived);
		if (!field) throw new ConvexError(`There's no field “${sort.field}”.`);
		if (field.multiple || field.kind === "link") throw new ConvexError(`Lists can't be sorted by “${field.label}”.`);
		// Sorting by a field lists records that have it, so "is empty" on it matches nothing.
		if (conditions.some((c) => c.field === field.key && c.empty === true)) return { page: [], isDone: true, continueCursor: "" };
		// A range on the sort field narrows the scan (and picks the currency).
		const own = checks.find((c) => c.field._id === field._id && (c.rangeStream?.lo || c.rangeStream?.hi));
		sortStream = own?.rangeStream ?? valueStream(field);
	}
	const order = sort?.order ?? (byField ? "asc" : "desc");

	const start = paginationOpts.cursor ? (JSON.parse(paginationOpts.cursor) as { p: string; a?: Key }) : undefined;
	const end = paginationOpts.endCursor ? (JSON.parse(paginationOpts.endCursor) as { a?: Key }).a : undefined;
	const plan = start?.p ?? (archived ? (sort?.field === "updatedAt" ? "u" : "t") : await choosePlan(ctx, checks, sort, sortStream));
	const streams = streamsFor(plan, typeId, archived, checks, sortStream);
	// Ranges drive in their own order; everything else in the asked (or newest-first) order.
	const streamOrder = plan.startsWith("c") && !checks[Number(plan.slice(1))]!.eqStreams ? "asc" : order;
	const cursor = (a: Key | undefined) => JSON.stringify({ p: plan, a });

	let after = start?.a;
	let active = streams;
	const page: Doc<"records">[] = [];
	let rows = 0;
	let bytes = 0;
	const sign = streamOrder === "asc" ? 1 : -1;
	const beyond = (key: Key) => end !== undefined && compareKeys(key, end) * sign > 0;
	for (;;) {
		const limit = Math.max(1, Math.floor(Math.min(CHUNK, SCAN_ROWS - rows) / active.length));
		if (rows >= SCAN_ROWS || bytes >= SCAN_BYTES) return { page, isDone: false, continueCursor: cursor(after) };
		const reads = await Promise.all(active.map((s) => seek(ctx, s, streamOrder, after, limit)));
		rows += reads.reduce((n, read) => n + read.length, 0);
		// A stream that came back short is used up. Full ones may have more, so nothing past
		// the earliest of their last keys is safe to take yet.
		let frontier: Key | undefined;
		for (const [i, read] of reads.entries()) {
			if (read.length < limit) continue;
			const last = keyOf(active[i]!, read.at(-1)!);
			if (!frontier || compareKeys(last, frontier) * sign < 0) frontier = last;
		}
		const merged = reads
			.flatMap((read, i) => read.map((row) => ({ row, key: keyOf(active[i]!, row) })))
			.filter(({ key }) => !frontier || compareKeys(key, frontier) * sign <= 0)
			.sort((a, b) => compareKeys(a.key, b.key) * sign);
		active = active.filter((_, i) => reads[i]!.length === limit);
		for (const { row, key } of merged) {
			if (after && compareKeys(key, after) === 0) continue; // the same record from another "any of" stream
			if (beyond(key)) return { page, isDone: false, continueCursor: paginationOpts.endCursor! };
			after = key;
			const record = "recordId" in row ? await ctx.db.get(row.recordId) : row;
			if (!record) continue;
			bytes += getDocumentSize(record);
			if (record.archived === archived && checks.every((c) => c.test(record.values))) page.push(record);
			if (!end && page.length >= paginationOpts.numItems) return { page, isDone: false, continueCursor: cursor(after) };
		}
		if (!frontier) return { page, isDone: true, continueCursor: end ? paginationOpts.endCursor! : cursor(after) };
	}
}
