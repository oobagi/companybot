import { z } from "zod";
import { fieldKinds } from "./records";
import { type ToolDef, defineTool } from "./tools";

/**
 * Agents use the CRM as the person they're helping: "add Acme Roofing as a client", "move
 * the Acme deal to won", "what deals close this month?". Six tools cover it, so the tool list
 * stays small and fixed. The backend runs every call through the same record rules as the
 * app (recordOps), re-reading the person's role each call, and history names both.
 * Expected problems come back as `{ error }` for the model to fix or explain.
 */
export interface RecordStore {
	types(): Promise<RecordTypesResult>;
	/** One request's worth of a list or search. `numItems` is at most 50. */
	find(input: RecordFindInput & { numItems: number }): Promise<RecordPage | { error: string }>;
	get(input: { id: string }): Promise<unknown>;
	save(input: RecordSaveInput): Promise<unknown>;
	undo(input: { change: string }): Promise<unknown>;
	saveField(input: FieldSaveInput): Promise<unknown>;
}

export interface RecordTypesResult {
	/** The workspace's currency: amounts written without a code are in it. */
	currency: string;
	types: {
		type: string;
		name: string;
		plural: string;
		fields: { key: string; label: string; kind: string; options?: string[]; linksTo?: string; multiple?: true }[];
	}[];
}

/**
 * A record as list tools return it: `_id` (and `_type` in a search across types), then each
 * field's value as people read it, by key. Field keys start with a letter, so they never clash.
 */
export type RecordRow = { _id: string; _type?: string; [key: string]: string | number | undefined };

export interface RecordPage {
	/** The type's plural ("Deals"), or "Records" for a search across types. */
	type: string;
	/** Its singular ("Deal", "Record"). */
	typeName: string;
	rows: RecordRow[];
	more: boolean;
	cursor?: string;
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const value = z
	.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(z.string()),
		z.object({ amount: z.union([z.string(), z.number()]), currency: z.string().optional() }),
	])
	.describe(
		'Text, number, "YYYY-MM-DD" date, true/false, a choice\'s label, a teammate ("me", a name or email), a linked record\'s exact name or id, an amount (1250.50 in the workspace\'s currency, or "EUR 1250.50"), a list for fields holding several, or null to clear',
	);

const filter = z.object({
	field: z.string().describe("Field key or label"),
	eq: scalar.optional(),
	in: z.array(scalar).max(50).optional().describe("Any of these: choice, teammate and link fields"),
	gt: scalar.optional(),
	gte: scalar.optional(),
	lt: scalar.optional(),
	lte: scalar.optional().describe('Ranges work on number, amount and date fields. Dates as "YYYY-MM-DD".'),
	empty: z.boolean().optional().describe("true: has no value; false: has one"),
});

const findInput = z.object({
	type: z.string().optional().describe('Record type, e.g. "deal" or "Clients". Optional only with `search`.'),
	search: z.string().optional().describe("Words to match in names and text fields, best first, up to 20. Can't be combined with filters or sort."),
	filters: z.array(filter).max(10).optional().describe("All must match"),
	sort: z
		.object({ field: z.string().describe('"createdAt", "updatedAt", or a field key'), order: z.enum(["asc", "desc"]) })
		.optional()
		.describe("Sorting by a field lists only records that have a value for it. Default: newest first."),
	archived: z.boolean().optional().describe("List archived records instead"),
	limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
	cursor: z.string().optional().describe("From a previous result with more: true, to get the next page of the same list"),
});
export type RecordFindInput = z.infer<typeof findInput>;

const saveInput = z.object({
	id: z.string().optional().describe("The record to change. Omit to create one."),
	type: z.string().optional().describe('Record type for a new record, e.g. "client"'),
	values: z.record(z.string(), value).optional().describe("Field key or label → value. Only the fields given change. New records need a name."),
	archived: z.boolean().optional().describe("true archives the record (hidden from lists, kept with its history); false restores it. On its own, without values."),
});
export type RecordSaveInput = z.infer<typeof saveInput>;

const fieldInput = z.object({
	type: z.string().describe('Record type, e.g. "client"'),
	field: z.string().optional().describe("An existing field's key or label, to rename it or change its options. Omit to add a field."),
	label: z.string().optional().describe('The field\'s name, e.g. "Roof type". Required when adding.'),
	kind: z.enum(fieldKinds).optional().describe("Required when adding; can't change later. user = a teammate; link = another record."),
	options: z
		.array(z.string())
		.optional()
		.describe("Choice fields: every option, in order. When changing, list all to keep: one left out is retired (records keep it; it can't be picked)."),
	linksTo: z.string().optional().describe("Link fields: the record type it points at"),
	multiple: z.boolean().optional().describe("Choice, user and link fields: holds several"),
});
export type FieldSaveInput = z.infer<typeof fieldInput>;

/** Requests one records_find call makes to fill its page, since a page can come back short. */
const FIND_REQUESTS = 5;

/**
 * What the model sees of a data result, in JSON characters: a page of 50 records with long
 * text can be megabytes, every byte of it billed and kept in the conversation. The full
 * result stays in the ResultStore, so widgets showing the ref get everything.
 */
export const MODEL_OUTPUT_MAX = 24_000;
/** Longest text value the model sees, at first: in a list, and on one record. */
const ROW_TEXT_MAX = 300;
const RECORD_TEXT_MAX = 2_000;
const TEXT_MIN = 80;

/**
 * Fits a data tool's `{ ref, data }` into MODEL_OUTPUT_MAX: cuts long text (shorter and shorter
 * until it fits, down to TEXT_MIN), then drops rows from the end, and says what it trimmed.
 * Errors pass through.
 */
export function forModel(output: unknown, textMax: number): unknown {
	if (!output || typeof output !== "object" || !("ref" in output) || !("data" in output)) return output;
	const { ref, data } = output as { ref: string; data: unknown };
	let cut = 0;
	const clip = (v: unknown, max: number): unknown => {
		if (typeof v === "string" && v.length > max) {
			cut++;
			return `${v.slice(0, max)}… (cut from ${v.length} characters)`;
		}
		if (Array.isArray(v)) return v.map((x) => clip(x, max));
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, max)]));
		return v;
	};
	const size = (v: unknown) => JSON.stringify(v).length;
	let max = textMax;
	let view = clip(data, max) as Record<string, unknown>;
	while (size(view) > MODEL_OUTPUT_MAX && max > TEXT_MIN) {
		max = Math.max(TEXT_MIN, Math.floor(max / 2));
		cut = 0;
		view = clip(data, max) as Record<string, unknown>;
	}
	const notes = cut ? [`${cut} long values cut to ${max} characters`] : [];
	const rows = view && typeof view === "object" && Array.isArray(view.rows) ? (view.rows as unknown[]) : null;
	if (rows && size(view) > MODEL_OUTPUT_MAX) {
		let room = MODEL_OUTPUT_MAX - size({ ...view, rows: [] }) - 300;
		const kept = [];
		for (const row of rows) {
			room -= size(row) + 1;
			if (room < 0) break;
			kept.push(row);
		}
		notes.push(`showing ${kept.length} of ${rows.length} rows`);
		view = { ...view, rows: kept };
	}
	if (notes.length === 0) return output;
	return { ref, data: { ...view, trimmed: `Trimmed to save space: ${notes.join("; ")}. Widgets using ${ref} show everything; ask for fewer rows, or open one record, to read more.` } };
}

/** A string at `key` of a tool's input or result, if there is one. */
function text(from: unknown, key: string) {
	const v = from && typeof from === "object" ? (from as Record<string, unknown>)[key] : undefined;
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** A result that's an `{ error }`: labels fall back to the tool's title. */
const failed = (output: unknown) => text(output, "error") !== undefined;

/** "Find 1 deal", "Find 20+ clients", "Find no records". */
function foundLabel(output: unknown) {
	const page = output as Partial<RecordPage> | undefined;
	if (!page || failed(page) || !Array.isArray(page.rows) || !page.type || !page.typeName) return;
	const n = page.rows.length;
	return `Find ${n || "no"}${page.more ? "+" : ""} ${(n === 1 && !page.more ? page.typeName : page.type).toLowerCase()}`;
}

/** "Create deal Reroof main warehouse", "Save Acme Roofing", "Archive Acme Roofing". */
function savedLabel(input: RecordSaveInput, output: unknown) {
	if (failed(output)) return;
	const name = text(output, "name");
	if (!input.id) {
		const type = text(output, "typeName") ?? input.type;
		const values = input.values ?? {};
		const given = name ?? text(values, "name") ?? text(values, "Name");
		return type && given ? `Create ${type.toLowerCase()} ${given}` : undefined;
	}
	if (!name) return;
	return `${input.archived === undefined ? "Save" : input.archived ? "Archive" : "Restore"} ${name}`;
}

/** "Add field Roof type to Clients", "Update field Stage on Deals". */
function fieldLabel(input: FieldSaveInput, output: unknown) {
	if (failed(output)) return;
	const label = text(output, "label") ?? (input.field ? undefined : input.label);
	const types = text(output, "typePlural");
	if (!label) return;
	return input.field ? `Update field ${label}${types ? ` on ${types}` : ""}` : `Add field ${label}${types ? ` to ${types}` : ""}`;
}

export const recordTools: ToolDef[] = [
	defineTool({
		id: "records.types",
		title: "Look up record types",
		description:
			"The workspace's record types (clients, deals, tasks, calls, and any the team added) with every field: key, label, kind, choice options, and what links point at. Also the workspace's currency. Call it before your first records tool in a conversation.",
		input: z.object({}),
		readOnly: true,
		execute: (_input, { records }) => records.types(),
	}),
	defineTool({
		id: "records.find",
		title: "Find records",
		description:
			"List one type's records with filters and a sort, or search names and text. Rows have the record's `_id` and each field's value as people read it, by field key (dates like \"Nov 15, 2026\"; filter and save them as \"YYYY-MM-DD\"). If more is true there are more matches: call again with cursor before saying how many there are. Long results are trimmed for you (it says so); widgets showing the ref still get every row in full.",
		input: findInput,
		readOnly: true,
		returnsData: true,
		async execute(input, { records }) {
			const limit = input.limit ?? 20;
			const rows: RecordRow[] = [];
			let type = "";
			let typeName = "";
			let cursor = input.cursor;
			let more = true;
			// A rare combination of filters can take several requests to fill a page.
			for (let i = 0; i < FIND_REQUESTS && more && rows.length < limit; i++) {
				const page = await records.find({ ...input, cursor, numItems: limit - rows.length });
				if ("error" in page) return page;
				rows.push(...page.rows);
				({ type, typeName, more, cursor } = page);
			}
			return { type, typeName, rows, more, ...(more && { cursor }) };
		},
		toModelOutput: ({ output }) => ({ type: "json", value: forModel(output, ROW_TEXT_MAX) as never }),
		label: (_input, output) => foundLabel(output),
	}),
	defineTool({
		id: "records.get",
		title: "Open a record",
		description:
			"One record by id: every field, linked records with their ids, records that link to it (e.g. a client's deals), and its latest changes, each with a change id records_undo takes.",
		input: z.object({ id: z.string() }),
		readOnly: true,
		returnsData: true,
		execute: (input, { records }) => records.get(input),
		toModelOutput: ({ output }) => ({ type: "json", value: forModel(output, RECORD_TEXT_MAX) as never }),
		label: (_input, output) => (failed(output) || !text(output, "name") ? undefined : `Open ${text(output, "name")}`),
	}),
	defineTool({
		id: "records.save",
		title: "Save a record",
		description:
			"Create a record, change some of its fields, or archive or restore it. Runs right away and is logged with your name and the person's; returns a change id records_undo takes. Find first so you don't create a duplicate.",
		input: saveInput,
		execute: (input, { records }) => records.save(input),
		label: savedLabel,
	}),
	defineTool({
		id: "records.undo",
		title: "Undo a record change",
		description:
			"Reverse one change by its change id (from records_save or records_get): old values back, an archive restored, a new record archived. Refused if what it changed has changed again since.",
		input: z.object({ change: z.string() }),
		execute: (input, { records }) => records.undo(input),
		label: (_input, output) => (failed(output) || !text(output, "name") ? undefined : `Undo a change to ${text(output, "name")}`),
	}),
	defineTool({
		id: "records.save_field",
		title: "Save a field",
		description:
			'Add a field to a record type ("start tracking roof type on clients"), or rename one or change its choice options. Only after the person asked for it or confirmed it.',
		input: fieldInput,
		execute: (input, { records }) => records.saveField(input),
		label: fieldLabel,
	}),
];
