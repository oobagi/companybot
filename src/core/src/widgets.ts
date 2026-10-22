import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/**
 * Widgets are UI the agent places in its reply: tables, stat tiles, and so on.
 *
 * Each widget is a tool ("widgets.table"). The model calls it with typed props;
 * the runner stores the result as a widget part of the message, in order with the
 * text; the app renders the matching component. The model never writes markup, so
 * there's nothing to parse and props are always valid.
 *
 * Add one: defineWidget here, add it to `widgetCatalog`, and add its component to
 * the desktop app's widget registry (renderer/src/widgets). Unknown types render
 * as a placeholder, so older apps don't break on newer widgets.
 */
export interface WidgetDef<Props = any> {
	type: string;
	/** Tells the model when to use it. Sent with the tool. */
	description: string;
	props: z.ZodType<Props>;
	/** Extra checks zod can't express in a schema. Return a message the model can act on. */
	check?(props: Props): string | null;
	/** One line for conversation history, so the agent remembers what it showed. */
	summary(props: Props): string;
}

export interface Widget {
	type: string;
	props: unknown;
}

export const defineWidget = <Props>(widget: WidgetDef<Props>) => widget;

const cell = z.union([z.string(), z.number(), z.null()]);

export const tableWidget = defineWidget({
	type: "table",
	description:
		"Show rows of structured data as a table under your message, e.g. a list of leads, tasks, or results. Use it for 3+ rows that share the same fields.",
	props: z.object({
		title: z.string().max(80).optional().describe("Short heading, e.g. 'Last 10 leads'"),
		columns: z.array(z.string().max(40)).min(1).max(8).describe("Column headings, left to right"),
		rows: z
			.array(z.array(cell))
			.max(100)
			.describe("One array per row, with one cell per column, in column order"),
	}),
	check: ({ columns, rows }) => {
		const bad = rows.findIndex((r) => r.length !== columns.length);
		return bad === -1 ? null : `Row ${bad + 1} has ${rows[bad]?.length} cells but there are ${columns.length} columns.`;
	},
	summary: ({ title, columns, rows }) =>
		`table${title ? ` "${title}"` : ""} with ${rows.length} rows (${columns.join(", ")})`,
});

export const statsWidget = defineWidget({
	type: "stats",
	description:
		"Show a few headline numbers as tiles under your message, e.g. revenue this month or open tickets. Use it for 1–6 key figures.",
	props: z.object({
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

export type TableProps = z.infer<typeof tableWidget.props>;
export type StatsProps = z.infer<typeof statsWidget.props>;

export const widgetCatalog: WidgetDef[] = [tableWidget, statsWidget];

export const findWidget = (type: string) => widgetCatalog.find((w) => w.type === type);

/** History line for a widget the agent showed earlier. */
export const describeWidget = (widget: Widget) => {
	const def = findWidget(widget.type);
	return `[You showed a ${def ? def.summary(widget.props) : widget.type} widget]`;
};

/** The tools that place widgets. Results go to the app; the model only sees a short receipt. */
export const widgetTools: ToolDef[] = widgetCatalog.map((w) =>
	defineTool({
		id: `widgets.${w.type}`,
		description: w.description,
		input: w.props,
		readOnly: true,
		async execute(props) {
			const problem = w.check?.(props);
			if (problem) return { error: problem };
			return { widget: { type: w.type, props } satisfies Widget };
		},
		toModelOutput: ({ output }) =>
			isWidgetResult(output)
				? { type: "text", value: "Shown to the person under your message. Don't repeat its contents in text." }
				: { type: "json", value: output as never },
	}),
);

export const isWidgetResult = (output: unknown): output is { widget: Widget } =>
	!!output && typeof output === "object" && "widget" in output;
