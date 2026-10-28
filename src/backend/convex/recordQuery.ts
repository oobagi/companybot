import { type FieldValue, MULTI_MAX, NAME_KEY, hash, indexEntries, normalizeValue, sameText } from "@companybot/core";
import type { PaginationResult } from "convex/server";
import { ConvexError, getDocumentSize } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { toField } from "./recordOps";
import { emptyPage } from "./lib";

// Record lists with any combination of filters (AND) and one sort. See wiki/data.md.
//
// Plan: one index drives the scan, in the order the list comes back; every condition is
// then checked against the record itself. The driver is the sort field when there is a
// sort; otherwise the most selective equality or "any of" condition (found by counting a
// few index rows), then the most selective range, then every record by creation time.
// Index rows end in the record's creation time (`at`), then its id, so equality lists keep
// "newest first", several "any of" streams merge by it, and ties page like any other key.
//
// Work is bounded: everything a request reads (link targets, selectivity probes, index
// rows, records) counts against one budget, sized to leave room for resolving names after.
// If it runs out before the page fills, it returns what it found with `isDone: false` and
// a cursor to carry on, like Convex's own filtered pagination.

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
/** One board column: a single-option choice field's option id, or null for records without one. */
export type Group = { field: string; option: string | null };

export const CONDITIONS_MAX = 10;
export const ANY_OF_MAX = 50;
/** Index rows a request reads, probes and link checks included. */
const SCAN_ROWS = 1_000;
/** Bytes a request reads before toRows resolves names (up to 4 MB more), within Convex's 16 MiB. */
const SCAN_BYTES = 6 * 1024 * 1024;
/** Index ranges a request reads, leaving room under Convex's 4,096 for resolving names. */
const SCAN_RANGES = 2_500;
/**
 * The most a record document can be: values (RECORD_MAX_BYTES), plus its title and search
 * text (each at most TEXT_MAX characters), with room to spare. No record is read without this much budget left.
 */
const DOC_MAX = 256 * 1024;
/** Index rows read at a time, shared by a plan's streams. */
const CHUNK = 100;
/** Index rows counted, across all candidates, when picking the driver. */
const PROBE_ROWS = 400;

type Fields = Doc<"recordFields">[];
type Values = Record<string, FieldValue>;
type Entry = { str?: string; num?: number; ref?: string };
/** A position in a stream: its index fields after the prefix (then the record id, for `records`). */
type Key = (string | number)[];
type Bound = { v: string | number; incl: boolean };
type Row = Doc<"records"> | Doc<"recordValues">;
type Item = { row: Row; key: Key };

/**
 * One index range, read in order of `keys` (the index fields after `prefix`). `recordValues`
 * keys end in `recordId`, so every position is unique. `records` indexes can't hold `_id`, so
 * rows tied on every key (only in imports) are read as a group and taken in `_id` order.
 */
interface Stream {
	table: "records" | "recordValues";
	index: string;
	prefix: [string, unknown][];
	keys: string[];
	lo?: Bound;
	hi?: Bound;
}

/** What one request has read so far. Every read goes through it. */
class Budget {
	rows = 0;
	bytes = 0;
	ranges = 0;
	/** Room for `ranges` more ranges, `rows` more index rows and `bytes` more bytes. */
	has(ranges: number, rows = 0, bytes = 0) {
		return this.ranges + ranges <= SCAN_RANGES && this.rows + rows <= SCAN_ROWS && this.bytes + bytes <= SCAN_BYTES;
	}
	read(rows: (Row | Doc<"recordTypes">)[]) {
		this.ranges++;
		this.rows += rows.length;
		for (const row of rows) this.bytes += getDocumentSize(row);
	}
}

/** Whether linked records are live. Archived records have no index rows, so one small row answers it. */
class Liveness {
	private known = new Map<string, boolean>();
	constructor(
		private ctx: QueryCtx,
		private budget: Budget,
	) {}
	async type(id: Id<"recordTypes">) {
		if (!this.known.has(id)) {
			const type = await this.ctx.db.get(id);
			this.budget.read(type ? [type] : []);
			this.known.set(id, !!type && !type.archived);
		}
		return this.known.get(id)!;
	}
	async of(id: string) {
		const cached = this.known.get(id);
		if (cached !== undefined) return cached;
		const recordId = this.ctx.db.normalizeId("records", id);
		const rows = recordId
			? await this.ctx.db
					.query("recordValues")
					.withIndex("by_record", (q) => q.eq("recordId", recordId))
					.take(1)
			: [];
		this.budget.read(rows);
		this.known.set(id, rows.length > 0);
		return rows.length > 0;
	}
}

/** A condition, checked and ready: what it accepts, and how it could drive the scan. */
interface Check {
	field: Doc<"recordFields">;
	test: (values: Values) => boolean | Promise<boolean>;
	/** Most link targets `test` may look up for one record. */
	lookups: number;
	/** The condition as resolved (values as the index stores them, currency included), for cursors. */
	resolved: unknown;
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
	const s = (index: string, prefix: [string, unknown][]): Stream => ({ table: "recordValues", index, prefix, keys: ["at", "recordId"] });
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
			? { ...base, index: "by_field_money", prefix: [["fieldId", field._id], ["str", code]], keys: ["num", "at", "recordId"] }
			: { ...base, index: "by_field_money", prefix: [["fieldId", field._id]], keys: ["str", "num", "at", "recordId"] };
	if (field.kind === "number" || field.kind === "checkbox")
		return { ...base, index: "by_field_num", prefix: [["fieldId", field._id]], keys: ["num", "at", "recordId"] };
	return { ...base, index: "by_field_str", prefix: [["fieldId", field._id]], keys: ["str", "at", "recordId"] };
}

/** Checks one condition and works out how it can be tested and driven. Link targets are looked up within the budget. */
export async function compile(fields: Fields, c: Condition, currency: string, live: Liveness): Promise<Check> {
	const field = fields.find((f) => f.key === c.field && !f.archived);
	if (!field) throw new ConvexError(`There's no field “${c.field}”.`);
	const name = `“${field.label}”`;
	const entries = (values: Values) => indexEntries(toField(field), values[field.key]) as Entry[];
	const targetLive = field.kind !== "link" || (await live.type(field.linkTypeId!));
	const kinds = (["eq", "in", "empty"] as const).filter((k) => c[k] !== undefined);
	const range = (["gt", "gte", "lt", "lte"] as const).filter((k) => c[k] !== undefined);
	if (kinds.length + (range.length ? 1 : 0) !== 1) throw new ConvexError(`Give ${name} one condition: eq, in, a range, or empty.`);

	if (c.empty !== undefined) {
		const want = c.empty;
		if (field.kind === "link") {
			// Links to archived records count as gone (wiki/data.md), so "empty" means no live target.
			const hasLive = async (v: Values) => {
				for (const e of entries(v)) if (targetLive && (await live.of(e.ref!))) return true;
				return false;
			};
			return { field, resolved: { field: field._id, empty: want }, lookups: MULTI_MAX, test: async (v) => (await hasLive(v)) !== want };
		}
		// Only single values can drive "has a value": several would list a record more than once.
		return {
			field,
			resolved: { field: field._id, empty: want },
			lookups: 0,
			test: (v) => (v[field.key] === undefined) === want,
			...(!want && !field.multiple && { rangeStream: valueStream(field) }),
		};
	}
	if (c.eq !== undefined || c.in !== undefined) {
		if (c.in !== undefined && !anyOfKinds.includes(field.kind)) throw new ConvexError(`“Any of” works on choice, person and link fields, not ${name}.`);
		const raws = c.in ?? [c.eq];
		if (raws.length === 0 || raws.length > ANY_OF_MAX) throw new ConvexError(`Pick 1 to ${ANY_OF_MAX} values for ${name}.`);
		let wanted = raws.map((raw) => entryOf(field, raw, currency));
		const resolved = { field: field._id, any: wanted };
		// Links to an archived record match nothing (wiki/data.md).
		if (field.kind === "link") {
			const kept = [];
			for (const e of wanted) if (targetLive && (await live.of(e.ref!))) kept.push(e);
			wanted = kept;
		}
		// Long text keys by a hash, so a match is checked against the text itself.
		const text = c.eq !== undefined && (normalizeValue(toField(field), c.eq, "filter", currency) as { value: FieldValue }).value;
		return {
			field,
			resolved,
			lookups: 0,
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
		resolved: { field: field._id, lo, hi },
		lookups: 0,
		test: (v) =>
			entries(v).some((e) => {
				if (field.kind === "date") return inRange(e.str!);
				return (field.kind === "number" || e.str === code) && inRange(e.num!);
			}),
		rangeStream: valueStream(field, lo && { v: lo.v, incl: lo.incl }, hi && { v: hi.v, incl: hi.incl }, code),
	};
}

/** Validate saved filters without listing records or choosing a scan plan. */
export async function validateView(ctx: QueryCtx, fields: Fields, conditions: Condition[], sort: Sort | undefined, currency: string) {
	if (conditions.length > CONDITIONS_MAX) throw new ConvexError(`Use up to ${CONDITIONS_MAX} filters.`);
	const live = new Liveness(ctx, new Budget());
	for (const c of conditions) {
		const values = [c.eq, ...(c.in ?? []), c.gt, c.gte, c.lt, c.lte].filter((v) => v !== undefined);
		if (values.some((v) => !["string", "number", "boolean"].includes(typeof v))) throw new ConvexError("View filters use text, numbers or booleans.");
		if ((c.gt !== undefined && c.gte !== undefined) || (c.lt !== undefined && c.lte !== undefined)) throw new ConvexError("Use one lower and one upper bound per range.");
		await compile(fields, c, currency, live);
	}
	if (sort && !["createdAt", "updatedAt"].includes(sort.field)) {
		const field = fields.find((f) => f.key === sort.field && !f.archived);
		if (!field || field.multiple || field.kind === "link" || field.kind === "checkbox") throw new ConvexError("Pick a sortable field.");
	}
}

function keyOf(s: Stream, row: Row): Key {
	const r = row as unknown as Record<string, string | number | undefined>;
	return s.table === "records" ? [...s.keys.map((k) => r[k]!), r._id!] : s.keys.map((k) => r[k]!);
}

const compareKeys = (a: Key, b: Key) => {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
	return 0;
};

/** One range of `s`, through the budget. `range` narrows it past the prefix. */
async function read(ctx: QueryCtx, budget: Budget, s: Stream, order: "asc" | "desc", limit: number, range: (r: any) => any) {
	const rows: Row[] = await ctx.db
		.query(s.table)
		// The index and its fields vary by stream, so the range is built untyped.
		.withIndex(s.index as any, (q: any) => {
			let r = q;
			for (const [f, value] of s.prefix) r = r.eq(f, value);
			return range(r);
		})
		.order(order)
		.take(limit);
	budget.read(rows);
	return rows;
}

/**
 * Every `records` row tied with `key` on all its index fields (imports can repeat a creation
 * time). There's no `_id` to seek by, so the group is read whole, as far as the budget allows.
 */
async function tie(ctx: QueryCtx, budget: Budget, s: Stream, order: "asc" | "desc", key: Key) {
	const room = Math.max(1, Math.floor((SCAN_BYTES - budget.bytes) / DOC_MAX));
	const rows = await read(ctx, budget, s, order, room + 1, (r) => {
		for (const [i, k] of s.keys.entries()) r = r.eq(k, key[i]);
		return r;
	});
	if (rows.length > room) throw new ConvexError("Too many records share one time to list this way. Filter them, or sort by a field.");
	return rows.map((row) => ({ row, key: keyOf(s, row) }));
}

/**
 * The stream's rows after `after`, in order, about `limit` of them. `more`: there may be more.
 * For `records`, only whole groups of tied rows come back, so ties can be taken in id order.
 */
async function readStream(ctx: QueryCtx, budget: Budget, s: Stream, order: "asc" | "desc", after: Key | undefined, limit: number) {
	const sign = order === "asc" ? 1 : -1;
	const n = s.keys.length;
	const grouped = s.table === "records";
	const items: Item[] = after && grouped ? (await tie(ctx, budget, s, order, after)).filter((i) => compareKeys(i.key, after) * sign > 0) : [];
	// A lexicographic seek past `after`: one range per key position.
	let rest: Item[] = [];
	for (const p of after ? s.keys.map((_, i) => n - 1 - i) : [0]) {
		if (rest.length >= limit) break;
		const rows = await read(ctx, budget, s, order, limit - rest.length, (r) => {
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
		});
		rest.push(...rows.map((row) => ({ row, key: keyOf(s, row) })));
	}
	const more = rest.length >= limit;
	if (more && grouped) {
		// The last group may go on past the read: leave it for next time, or read it whole if it's all there is.
		const last = rest.at(-1)!.key;
		const first = rest.findIndex((i) => compareKeys(i.key.slice(0, n), last.slice(0, n)) === 0);
		rest = first > 0 ? rest.slice(0, first) : await tie(ctx, budget, s, order, last);
	}
	items.push(...rest);
	items.sort((a, b) => compareKeys(a.key, b.key) * sign);
	return { items, more };
}

/**
 * The streams for a plan id: "t" type, "u" updated, "s" sort field, or "c<i>" condition i.
 * Live records by creation time come from their name rows (every live record has one), so
 * ties page by id; archived ones, which have no index rows, from the records themselves.
 */
function streamsFor(plan: string, typeId: Id<"recordTypes">, archived: boolean, fields: Fields, checks: Check[], sortStream?: Stream): Stream[] | undefined {
	const name = fields.find((f) => f.key === NAME_KEY);
	if (plan === "t" && !archived && name)
		return [{ table: "recordValues", index: "by_field_at", prefix: [["fieldId", name._id]], keys: ["at", "recordId"] }];
	if (plan === "t" || plan === "u")
		return [
			{
				table: "records",
				index: plan === "t" ? "by_type" : "by_type_updated",
				prefix: [["typeId", typeId], ["archived", archived]],
				keys: plan === "t" ? ["_creationTime"] : ["updatedAt", "_creationTime"],
			},
		];
	if (plan === "s") return sortStream && [sortStream];
	const check = /^c\d+$/.test(plan) ? checks[Number(plan.slice(1))] : undefined;
	return check?.eqStreams ?? (check?.rangeStream && [check.rangeStream]);
}

/**
 * Picks the driver: the sort, else the fewest rows among equalities, else among ranges,
 * else the type. Counting is shared out of PROBE_ROWS and read through the budget.
 */
async function choosePlan(ctx: QueryCtx, budget: Budget, checks: Check[], sort: Sort | undefined, sortStream: Stream | undefined) {
	if (sortStream) return "s";
	if (sort?.field === "updatedAt") return "u";
	if (sort?.field === "createdAt") return "t";
	const candidates = checks.filter((c) => c.eqStreams ?? c.rangeStream).length;
	const cap = Math.max(1, Math.floor(PROBE_ROWS / Math.max(1, candidates)));
	const count = async (streams: Stream[]) => {
		let n = 0;
		for (const s of streams) {
			if (n > cap || !budget.has(1, cap + 1 - n)) return Number.POSITIVE_INFINITY;
			n += (await read(ctx, budget, s, "asc", cap + 1 - n, (r) => r)).length;
		}
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

/** A board column as a condition. Removed options still list the records that keep them. */
function groupCondition(fields: Fields, { field: key, option }: Group): Condition {
	const field = fields.find((f) => f.key === key && !f.archived);
	if (field?.kind !== "choice" || field.multiple) throw new ConvexError("Group a board by a live choice field that holds one option.");
	if (option === null) return { field: key, empty: true };
	if (!field.options?.some((o) => o.id === option)) throw new ConvexError(`“${field.label}” has no such option.`);
	return { field: key, eq: option };
}

type Cursor = { q: string; p: string; a?: Key };

function parseCursor(raw: string, fingerprint: string): Cursor {
	let cursor: Cursor | undefined;
	try {
		cursor = JSON.parse(raw);
	} catch {}
	// A cursor only continues the list it came from: same workspace, type, filters and sort.
	if (!cursor || cursor.q !== fingerprint || typeof cursor.p !== "string" || (cursor.a !== undefined && !Array.isArray(cursor.a)))
		throw new ConvexError("That page is out of date. Start the list again.");
	return cursor;
}

/**
 * One page of `typeId`'s records matching every condition. Order: the sort if given;
 * otherwise newest first, unless a range drives the scan, which lists in that field's order.
 * Never more than `pageMax` records, even when an `endCursor` asks for more.
 */
export async function findRecords(
	ctx: QueryCtx,
	{ workspaceId, typeId, archived, fields, conditions: filters, group, sort, currency, pageMax, paginationOpts }: {
		workspaceId: Id<"workspaces">;
		typeId: Id<"recordTypes">;
		archived: boolean;
		fields: Fields;
		conditions: Condition[];
		/** A board column, on top of the view's filters and outside their limit. */
		group?: Group;
		sort?: Sort;
		currency: string;
		pageMax: number;
		paginationOpts: { numItems: number; cursor: string | null; endCursor?: string | null };
	},
): Promise<PaginationResult<Doc<"records">>> {
	if (filters.length > CONDITIONS_MAX) throw new ConvexError(`Use up to ${CONDITIONS_MAX} filters.`);
	const conditions = group ? [...filters, groupCondition(fields, group)] : filters;
	const budget = new Budget();
	const live = new Liveness(ctx, budget);
	const checks: Check[] = [];
	for (const c of conditions) checks.push(await compile(fields, c, currency, live));
	// Conditions as resolved, so a cursor stops working if what they mean changes (say, the workspace's currency).
	const fingerprint = hash(JSON.stringify([workspaceId, typeId, archived, checks.map((c) => c.resolved), sort ?? null]));
	const start = paginationOpts.cursor ? parseCursor(paginationOpts.cursor, fingerprint) : undefined;
	const endCursor = paginationOpts.endCursor ?? undefined;
	const endAt = endCursor ? parseCursor(endCursor, fingerprint) : undefined;
	if (start && endAt && start.p !== endAt.p) throw new ConvexError("That page is out of date. Start the list again.");
	const byField = sort && !["createdAt", "updatedAt"].includes(sort.field);
	// Archived records have no index rows, so their lists scan the type and check every condition.
	if (archived && byField) throw new ConvexError("Archived records can't be sorted by a field.");
	let sortStream: Stream | undefined;
	if (byField) {
		const field = fields.find((f) => f.key === sort.field && !f.archived);
		if (!field) throw new ConvexError(`There's no field “${sort.field}”.`);
		if (field.multiple || field.kind === "link") throw new ConvexError(`Lists can't be sorted by “${field.label}”.`);
		// Sorting by a field lists records that have it, so "is empty" on it matches nothing.
		if (conditions.some((c) => c.field === field.key && c.empty === true)) return emptyPage();
		// A range on the sort field narrows the scan (and picks the currency).
		const own = checks.find((c) => c.field._id === field._id && (c.rangeStream?.lo || c.rangeStream?.hi));
		sortStream = own?.rangeStream ?? valueStream(field);
	}
	const order = sort?.order ?? (byField ? "asc" : "desc");

	const plan =
		start?.p ?? endAt?.p ?? (archived ? (sort?.field === "updatedAt" ? "u" : "t") : await choosePlan(ctx, budget, checks, sort, sortStream));
	const streams = streamsFor(plan, typeId, archived, fields, checks, sortStream);
	if (!streams) throw new ConvexError("That page is out of date. Start the list again.");
	// Ranges drive in their own order; everything else in the asked (or newest-first) order.
	const streamOrder = plan.startsWith("c") && !checks[Number(plan.slice(1))]!.eqStreams ? "asc" : order;
	const sign = streamOrder === "asc" ? 1 : -1;
	const cursor = (a: Key | undefined) => JSON.stringify({ q: fingerprint, p: plan, a } satisfies Cursor);
	const end = endAt?.a;
	const limit = end ? pageMax : Math.min(paginationOpts.numItems, pageMax);
	const lookups = checks.reduce((n, c) => n + c.lookups, 0);

	let after = start?.a;
	const page: Doc<"records">[] = [];
	// Stopped before the end: carry on from `after`. Within an `endCursor` page, ask the client to split it there.
	const stop = (): PaginationResult<Doc<"records">> =>
		endCursor ? { page, isDone: false, continueCursor: endCursor, splitCursor: cursor(after), pageStatus: "SplitRequired" } : { page, isDone: false, continueCursor: cursor(after) };

	// A k-way merge: each stream keeps a buffer, refilled only once it's used up, so no row is dropped.
	const state = streams.map((s) => ({ s, buffer: [] as Item[], more: true }));
	for (;;) {
		for (const st of state) {
			if (st.buffer.length || !st.more) continue;
			let take = Math.max(2, Math.floor(CHUNK / state.filter((x) => x.more).length));
			// Records come whole, so read only as many as the budget has room for.
			if (st.s.table === "records") take = Math.min(take, Math.floor((SCAN_BYTES - budget.bytes) / DOC_MAX) - (after ? 1 : 0));
			if (take < 1 || !budget.has(st.s.keys.length + 2, take, st.s.table === "records" ? DOC_MAX : 0)) return stop();
			({ items: st.buffer, more: st.more } = await readStream(ctx, budget, st.s, streamOrder, after, take));
		}
		let next: (typeof state)[number] | undefined;
		for (const st of state)
			if (st.buffer.length && (!next || compareKeys(st.buffer[0]!.key, next.buffer[0]!.key) * sign < 0)) next = st;
		if (!next) return { page, isDone: true, continueCursor: endCursor ?? cursor(after) };
		const { row, key } = next.buffer[0]!;
		if (after && compareKeys(key, after) * sign <= 0) {
			next.buffer.shift(); // the same record from another "any of" stream
			continue;
		}
		if (end && compareKeys(key, end) * sign > 0) return { page, isDone: false, continueCursor: endCursor! };
		const fromIndex = "recordId" in row;
		if (!budget.has(lookups + (fromIndex ? 1 : 0), lookups, fromIndex ? DOC_MAX : 0)) return stop();
		next.buffer.shift();
		after = key;
		const record = fromIndex ? await ctx.db.get(row.recordId) : row;
		if (fromIndex) budget.read(record ? [record] : []);
		if (!record || record.archived !== archived) continue;
		let match = true;
		for (const c of checks) if (!(await c.test(record.values))) match = false;
		if (match) page.push(record);
		if (page.length >= limit) return end ? (compareKeys(after, end) === 0 ? { page, isDone: false, continueCursor: endCursor! } : stop()) : stop();
	}
}
