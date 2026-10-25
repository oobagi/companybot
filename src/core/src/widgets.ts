import { z } from "zod";
import { type ToolContext, type ToolDef, defineTool, modelToolName } from "./tools";

/**
 * Widgets are UI the agent places in its reply: tables, stat tiles, and so on.
 *
 * Each widget is a tool ("widgets.table"). The model calls it with typed input;
 * the runner stores the result as a widget part of the message, in order with the
 * text; the app renders the matching component. The model never writes markup, so
 * there's nothing to parse and props are always valid.
 *
 * Widgets can show data by ref instead of copying it: data tools' results come
 * with a ref ("r1"), and `prepare` looks it up (see ResultStore). Stored props are
 * always concrete, so the app never needs the original result.
 *
 * Add one: defineWidget here, add it to `widgetCatalog`, and add its component to
 * the desktop app's widget registry (renderer/src/widgets). Unknown types render
 * as a placeholder, so older apps don't break on newer widgets.
 */
export interface WidgetDef<Input = any, Props = Input> {
	type: string;
	/** Tells the model when to use it. Sent with the tool. */
	description: string;
	input: z.ZodType<Input>;
	/**
	 * Turns the model's input into the props the app renders: checks zod can't
	 * express, and data looked up by ref. Return a string the model can act on to refuse.
	 */
	prepare?(input: Input, ctx: ToolContext): Props | string;
	/** One line for conversation history, so the agent remembers what it showed. */
	summary(props: Props): string;
}

export interface Widget {
	type: string;
	props: unknown;
}

export const defineWidget = <Input, Props = Input>(widget: WidgetDef<Input, Props>) => widget;

const cell = z.union([z.string(), z.number(), z.null()]);
type Cell = z.infer<typeof cell>;
const MAX_ROWS = 100;

export interface TableProps {
	title?: string;
	columns: string[];
	rows: Cell[][];
}

export const tableWidget = defineWidget({
	type: "table",
	description:
		"Show rows of structured data as a table under your message, e.g. a list of leads, tasks, or results. Use it for 3+ rows that share the same fields. To show a list from a tool result, pass `from` with its ref instead of copying rows. Don't restate its rows in your text.",
	input: z.object({
		title: z.string().max(80).optional().describe("Short heading, e.g. 'Last 10 leads'"),
		columns: z.array(z.string().max(40)).min(1).max(8).describe("Column headings, left to right"),
		rows: z
			.array(z.array(cell))
			.max(MAX_ROWS)
			.optional()
			.describe("One array per row, with one cell per column, in column order. Omit when using `from`."),
		from: z
			.object({
				ref: z.string().describe("The ref of a tool result from this reply, e.g. 'r1'"),
				path: z
					.string()
					.optional()
					.describe("Where the list is in that result's data, as dot-separated keys, e.g. 'leads'. Omit if data is the list."),
				fields: z
					.array(z.string())
					.describe("For each column, the field to show from each item, as dot-separated keys, e.g. 'name' or 'owner.email'"),
			})
			.optional()
			.describe("Show a list from a tool result without copying it. Use instead of `rows`."),
	}),
	prepare: ({ title, columns, rows, from }, ctx): TableProps | string => {
		if (from && rows) return "Pass either `rows` or `from`, not both.";
		if (from) {
			if (from.fields.length !== columns.length) {
				return `There are ${columns.length} columns but ${from.fields.length} fields. Give one field per column.`;
			}
			const list = lookup(ctx, from.ref, from.path);
			if (typeof list === "string") return list;
			return {
				title,
				columns,
				rows: list.slice(0, MAX_ROWS).map((item) => from.fields.map((f) => toCell(at(item, f)))),
			};
		}
		if (!rows) return "Pass `rows`, or `from` to show a tool result.";
		const bad = rows.findIndex((r) => r.length !== columns.length);
		if (bad !== -1) return `Row ${bad + 1} has ${rows[bad]?.length} cells but there are ${columns.length} columns.`;
		return { title, columns, rows };
	},
	summary: ({ title, columns, rows }: TableProps) =>
		`table${title ? ` "${title}"` : ""} with ${rows.length} rows (${columns.join(", ")})`,
});

export const statsWidget = defineWidget({
	type: "stats",
	description:
		"Show a few headline numbers as tiles under your message, e.g. revenue this month or open tickets. Use it for 1–6 key figures.",
	input: z.object({
		title: z.string().max(80).optional(),
		items: z
			.array(
				z.object({
					label: z.string().max(40),
					value: z.string().max(24).describe("Formatted value, e.g. '$12,400' or '37'"),
					change: z.string().max(24).optional().describe("e.g. '+12% vs last month'"),
					trend: z.enum(["up", "down", "flat"]).optional(),
				}),
			)
			.min(1)
			.max(6),
	}),
	summary: ({ title, items }) =>
		`stats${title ? ` "${title}"` : ""}: ${items.map((i) => `${i.label} ${i.value}`).join(", ")}`,
});

export const cardWidget = defineWidget({
	type: "card",
	description:
		"Show one record as a card, e.g. a single lead, contact, or order, with its key fields. Don't restate its fields in your text.",
	input: z.object({
		title: z.string().max(80).describe("The record's name, e.g. 'Ada Lovelace'"),
		subtitle: z.string().max(120).optional().describe("One line of context, e.g. 'Lead · Acme Corp'"),
		fields: z
			.array(z.object({ label: z.string().max(40), value: z.string().max(200) }))
			.min(1)
			.max(12)
			.describe("Key facts, most important first"),
	}),
	summary: ({ title, fields }) => `card "${title}" (${fields.map((f) => f.label).join(", ")})`,
});

export type StatsProps = z.infer<typeof statsWidget.input>;
export type CardProps = z.infer<typeof cardWidget.input>;

export const widgetCatalog: WidgetDef[] = [tableWidget, statsWidget, cardWidget];

export const findWidget = (type: string) => widgetCatalog.find((w) => w.type === type);

/** History line for a widget shown earlier, by the agent itself or by `who`. */
export const describeWidget = (widget: Widget, who = "You") => {
	const def = findWidget(widget.type);
	return `[${who} showed a ${def ? def.summary(widget.props) : widget.type} widget]`;
};

/** The tools that place widgets. Results go to the app; the model only sees a short receipt. */
export const widgetTools: ToolDef[] = widgetCatalog.map((w) =>
	defineTool({
		id: `widgets.${w.type}`,
		description: w.description,
		input: w.input,
		readOnly: true,
		async execute(input, ctx) {
			const props = w.prepare ? w.prepare(input, ctx) : input;
			if (typeof props === "string") return { error: props };
			return { widget: { type: w.type, props } satisfies Widget };
		},
		toModelOutput: ({ output }) =>
			isWidgetResult(output)
				? { type: "text", value: "Shown to the person where you placed it. Don't describe it, point at it, or repeat what it shows. If the task needs more steps (changes still to make), keep going. Otherwise: if you haven't said what you did or found, say it in one sentence, then end your reply with no more tools." }
				: { type: "json", value: output as never },
	}),
);

export const isWidgetResult = (output: unknown): output is { widget: Widget } =>
	!!output && typeof output === "object" && "widget" in output;

/** Whether a tool name as the model sees it ("widgets_table") is a widget tool. */
export const isWidgetToolName = (modelName: string) => modelName.startsWith(modelToolName("widgets."));


// ---- Reading tool results by ref ----

/** Follows dot-separated keys ("owner.email", "items.0.name"). */
function at(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, key) => (v != null && typeof v === "object" ? (v as any)[key] : undefined), value);
}

/** The list at `path` in a ref's data, or a message the model can fix its call with. */
function lookup(ctx: ToolContext, ref: string, path?: string): unknown[] | string {
	const data = ctx.results.get(ref);
	if (data === undefined) return `No result "${ref}" in this reply. Use the ref that came with a tool result.`;
	const list = path ? at(data, path) : data;
	if (Array.isArray(list)) return list;
	const keys = list && typeof list === "object" ? Object.keys(list).slice(0, 20).join(", ") : "";
	return `${ref}${path ? ` at "${path}"` : ""} isn't a list.${keys ? ` Its keys: ${keys}.` : ""}`;
}

function toCell(value: unknown): Cell {
	if (value == null) return null;
	if (typeof value === "string" || typeof value === "number") return value;
	if (typeof value === "boolean") return value ? "Yes" : "No";
	const text = JSON.stringify(value);
	return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}
