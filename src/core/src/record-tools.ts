import { z } from "zod";
import { fieldKinds } from "./records";
import { type ToolDef, defineTool, resultText as text } from "./tools";

/**
 * Agents use the CRM as the person they're helping: "add Acme Roofing as a client", "move
 * the Acme deal to won", "what deals close this month?". The backend runs calls through the
 * same rules as the app (recordOps, databaseViews), re-reading the person's role each call, and history names both.
 * Expected problems come back as `{ error }` for the model to fix or explain.
 */
export interface RecordStore {
	types(input?: { trashed?: boolean }): Promise<RecordTypesResult>;
	history(input: { id?: string; cursor?: string; source?: "records" | "agents"; change?: string; limit?: number }): Promise<unknown>;
	/** One request's worth of a list or search. `numItems` is at most 50. */
	find(input: RecordFindInput & { numItems: number }): Promise<RecordPage | { error: string }>;
	get(input: { id: string }): Promise<unknown>;
	save(input: RecordSaveInput): Promise<unknown>;
	undo(input: { change: string }): Promise<unknown>;
	saveField(input: FieldSaveInput): Promise<unknown>;
	saveDatabase(input: DatabaseSaveInput): Promise<unknown>;
	views(input: { type: string }): Promise<unknown>;
	saveView(input: ViewSaveInput): Promise<unknown>;
}

export interface RecordTypesResult {
	/** The workspace's currency: amounts written without a code are in it. */
	currency: string;
	types: {
		type: string;
		name: string;
		plural: string;
		version: number;
		inTrash?: boolean;
		fields: { key: string; label: string; kind: string; options?: string[]; choices?: { id: string; label: string; retired?: boolean }[]; position?: number; inTrash?: boolean; linksTo?: string; multiple?: true }[];
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
	type: z.string().optional().describe('Database, e.g. "deal" or "Clients". Optional only with `search`.'),
	search: z.string().optional().describe("Words to match in names and text fields, best first, up to 20. Can't be combined with filters or sort."),
	filters: z.array(filter).max(10).optional().describe("All must match"),
	sort: z
		.object({ field: z.string().describe('"createdAt", "updatedAt", or a field key'), order: z.enum(["asc", "desc"]) })
		.optional()
		.describe("Sorting by a field lists only records that have a value for it. Default: newest first."),
	trashed: z.boolean().optional().describe("List the database's records in Trash instead"),
	limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
	cursor: z.string().optional().describe("From a previous result with more: true, to get the next page of the same list"),
});
export type RecordFindInput = z.infer<typeof findInput>;

const saveInput = z.object({
	id: z.string().optional().describe("The record to change. Omit to create one."),
	type: z.string().optional().describe('Database for a new record, e.g. "client"'),
	values: z.record(z.string(), value).optional().describe("Field key or label → value. Only the fields given change. New records need a name."),
	trash: z.boolean().optional().describe("true deletes the record: it goes to Trash, restorable for 30 days. false restores it from Trash. On its own, without values."),
});
export type RecordSaveInput = z.infer<typeof saveInput>;

export const fieldInput = z.object({
	type: z.string().describe('Database, e.g. "client"'),
	field: z.string().optional().describe("An existing field's key or label, to rename it or change its options. Omit to add a field."),
	label: z.string().optional().describe('The field\'s name, e.g. "Roof type". Required when adding.'),
	kind: z.enum(fieldKinds).optional().describe("Required when adding; can't change later. user = a teammate; link = another record."),
	options: z
		.array(z.union([z.string(), z.strictObject({ id: z.string().optional(), label: z.string() })])).max(100)
		.optional()
		.describe("Choice fields: every option, in order. Use {id,label} from records_types choices to rename without changing stored values. When changing, list all to keep: one left out is retired (records keep it; it can't be picked)."),
	position: z.number().int().min(1).max(100).optional().describe("Move an existing field to this display position, starting at 1 after Name (owners)."),
	linksTo: z.string().optional().describe("Link fields: the database it points at"),
	multiple: z.boolean().optional().describe("Choice, user and link fields: holds several"),
	trash: z.boolean().optional().describe("true deletes `field` (to Trash: records keep its values until it's gone for good); false restores it. On its own."),
});
export type FieldSaveInput = z.infer<typeof fieldInput>;

export const databaseInput = z.object({
	type: z.string().optional().describe("Existing database key or id. Omit to create."),
	name: z.string().max(120).optional().describe('The name people see, e.g. "Projects"; required when creating'),
	singular: z.string().max(120).optional().describe('One entry, e.g. "Project". Omit to guess it from name.'),
	trash: z.boolean().optional().describe("true deletes the database with its records (to Trash, restorable for 30 days); false restores it. On its own."),
	version: z.number().int().optional().describe("Current version from records_types; required when changing"),
});
export type DatabaseSaveInput = z.infer<typeof databaseInput>;

export const viewInput = z.object({
	type: z.string().describe("Database key or id"),
	id: z.string().optional().describe("View id from records_views. Omit to create."),
	version: z.number().int().optional().describe("Current version from records_views; required when changing or deleting"),
	remove: z.boolean().optional().describe("Delete this saved view"),
	name: z.string().max(120).optional(),
	filters: z.array(filter).max(10).optional().describe("All must match. Field keys or labels; choice labels, teammate names or me, linked record exact names or ids."),
	sort: z.object({ field: z.string(), order: z.enum(["asc", "desc"]) }).nullable().optional().describe("null clears sorting"),
	columns: z.array(z.string()).max(100).optional().describe("Field keys in display order, including name"),
});
export type ViewSaveInput = z.infer<typeof viewInput>;

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

/** A result that's an `{ error }`: labels fall back to the tool's title. */
const failed = (output: unknown) => text(output, "error") !== undefined;

/** "Find 1 deal", "Find 20+ clients", "Find no records". */
function foundLabel(output: unknown) {
	const page = output as Partial<RecordPage> | undefined;
	if (!page || failed(page) || !Array.isArray(page.rows) || !page.type || !page.typeName) return;
	const n = page.rows.length;
	return `Find ${n || "no"}${page.more ? "+" : ""} ${(n === 1 && !page.more ? page.typeName : page.type).toLowerCase()}`;
}

/** "Create deal Reroof main warehouse", "Save Acme Roofing", "Delete Acme Roofing". */
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
	return `${input.trash === undefined ? "Save" : input.trash ? "Delete" : "Restore"} ${name}`;
}

/** "Add field Roof type to Clients", "Update field Stage on Deals". */
function fieldLabel(input: FieldSaveInput, output: unknown) {
	if (failed(output)) return;
	const label = text(output, "label") ?? (input.field ? undefined : input.label);
	const types = text(output, "typePlural");
	if (!label) return;
	if (!input.field) return `Add field ${label}${types ? ` to ${types}` : ""}`;
	return `${input.trash === undefined ? "Update" : input.trash ? "Delete" : "Restore"} field ${label}${types ? ` on ${types}` : ""}`;
}

export const recordTools: ToolDef[] = [
	defineTool({
		id: "records.types",
		title: "Look up databases",
		description:
			"The workspace's databases (clients, deals, tasks, calls, and any the team added) with every field: key, label, kind, choice options, and what links point at. Also the workspace's currency. Call it before your first records tool in a conversation.",
		input: z.object({ trashed: z.boolean().optional().describe("Databases in Trash instead; fields include trashed fields and stable choice ids") }),
		readOnly: true,
		execute: (input, { records }) => records.types(input),
	}),
	defineTool({
		id: "records.find",
		title: "Find records",
		description:
			"List one database's records with filters and a sort, or search names and text. Rows have the record's `_id` and each field's value as people read it, by field key (dates like \"Nov 15, 2026\"; filter and save them as \"YYYY-MM-DD\"). If more is true there are more matches: call again with cursor before saying how many there are. Long results are trimmed for you (it says so); widgets showing the ref still get every row in full.",
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
		id: "records.history",
		title: "Read history and Activity",
		description: "Read a record's full history by id, or the workspace Activity feed without id. Paged newest first, with raw old/new values and undo ids. source agents reads visible agent tool activity; outputs remain private to the person it acted for. Continue with continueCursor as cursor until isDone. Long results are trimmed; use fewer rows or change with an entry id to read full JSON in 20,000-character chunks (start/next).",
		input: z.object({ id: z.string().optional(), source: z.enum(["records", "agents"]).optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(20).optional(), change: z.string().optional().describe("One recordHistory entry id for full detail"), start: z.number().int().min(0).optional() }),
		readOnly: true,
		riskFor: ({ source }) => source === "agents" ? "inside" : "none",
		returnsData: true,
		async execute({ start = 0, ...input }, { records }) {
			const result = await records.history(input);
			if (input.change && !failed(result)) {
				const json = JSON.stringify(result);
				const end = start + 20_000;
				return { change: input.change, json: json.slice(start, end), ...(json.length > end && { more: true, next: end }) };
			}
			if (result && typeof result === "object" && "page" in result) {
				const { page, ...rest } = result;
				return { ...rest, rows: page };
			}
			return result;
		},
		toModelOutput: ({ output }) => {
			const data = output && typeof output === "object" && "data" in output ? output.data : output;
			const detail = data && typeof data === "object" && "json" in data;
			return { type: "json", value: (detail ? output : forModel(output, 20_000)) as never };
		},
	}),
	defineTool({
		id: "records.save",
		title: "Save a record",
		description:
			"Create a record, change some of its fields, delete it (to Trash) or restore it from Trash. Runs right away and is logged with your name and the person's; returns a change id records_undo takes. Find first so you don't create a duplicate.",
		input: saveInput,
		execute: (input, { records }) => records.save(input),
		label: savedLabel,
	}),
	defineTool({
		id: "records.undo",
		title: "Undo a record change",
		description:
			"Reverse one change by its change id (from records_save or records_get): old values back, a deleted record restored, a new record deleted (to Trash). Refused if what it changed has changed again since.",
		input: z.object({ change: z.string() }),
		execute: (input, { records }) => records.undo(input),
		label: (_input, output) => (failed(output) || !text(output, "name") ? undefined : `Undo a change to ${text(output, "name")}`),
	}),
	defineTool({
		id: "records.save_field",
		title: "Save a field",
		description:
			'Add a field to a database ("start tracking roof type on clients"), rename one, change its choice options, delete it (to Trash) or restore it. Only after the person asked for it or confirmed it.',
		input: fieldInput,
		execute: (input, { records }) => records.saveField(input),
		label: fieldLabel,
	}),
	defineTool({
		id: "records.save_database",
		title: "Save a database",
		description: "Create, rename, delete (to Trash) or restore a database, when asked. Owners only. Changes are logged in Activity; record undo does not undo database changes.",
		input: databaseInput,
		permission: "fields.manage",
		execute: (input, { records }) => records.saveDatabase(input),
	}),
	defineTool({
		id: "records.views",
		title: "Look up saved views",
		description: "The database's shared saved views, with ids, versions, filters, sort and columns. Read before changing one. Field keys and filter values are stored ids, not display labels.",
		input: z.object({ type: z.string() }),
		readOnly: true,
		returnsData: true,
		execute: (input, { records }) => records.views(input),
		toModelOutput: ({ output }) => ({ type: "json", value: forModel(output, RECORD_TEXT_MAX) as never }),
	}),
	defineTool({
		id: "records.save_view",
		title: "Save a database view",
		description: "Create, rename, change or delete a named filter, sort and columns for everyone in the workspace, when asked. New views need a name; default columns include Name. Changes run right away and are logged in Activity; record undo does not undo view changes. Filters accept field keys or labels, choice labels, teammates by name or me, and linked records by exact name or id.",
		input: viewInput,
		permission: "records.edit",
		execute: (input, { records }) => records.saveView(input),
	}),
];
