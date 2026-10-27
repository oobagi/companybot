import { useState } from "react";
import type { CardProps, StatsProps, TableProps } from "@companybot/core";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon } from "./icons";

// Components for widgets agents place in replies. Types and props are defined in
// core/src/widgets.ts; add a component here for each one. Unknown types (from a
// newer backend) render a placeholder instead of breaking the message.

const registry: Record<string, (props: { props: any }) => React.ReactNode> = {
	table: TableWidget,
	stats: StatsWidget,
	card: CardWidget,
};

export function WidgetView({ widget }: { widget: { type: string; props: unknown } }) {
	const Component = registry[widget.type];
	if (!Component) {
		return <p className="rounded-xl border border-dashed border-neutral-300 px-4 py-3 text-sm text-neutral-500">Update the app to see this.</p>;
	}
	return <Component props={widget.props} />;
}

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
	return (
		<figure className="overflow-hidden rounded-xl border border-neutral-200">
			{title && <figcaption className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-medium">{title}</figcaption>}
			{children}
		</figure>
	);
}

/** Long tables start collapsed to this many rows. */
const COLLAPSED_ROWS = 10;

function TableWidget({ props }: { props: TableProps }) {
	// Number columns (including text like "8,258,035" or "$12.4k") hug their content and right-align.
	const numeric = props.columns.map(
		(_, c) => props.rows.length > 0 && props.rows.every((r) => r[c] == null || isNumberLike(r[c]!)),
	);
	const [expanded, setExpanded] = useState(false);
	const rows = expanded ? props.rows : props.rows.slice(0, COLLAPSED_ROWS);
	return (
		<Frame title={props.title}>
			{/* Grows with its rows; scrolls sideways only if the columns don't fit. */}
			<div className="overflow-x-auto">
				<table className="w-full text-left text-sm">
					<thead className="text-neutral-500">
						<tr>
							{props.columns.map((c, i) => (
								<th key={i} className={`px-4 py-2 font-medium whitespace-nowrap ${numeric[i] ? "w-px text-right" : ""}`}>
									{c}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, r) => (
							<tr key={r} className="border-t border-neutral-100">
								{row.map((cell, c) => (
									<td key={c} className={`px-4 py-2 ${numeric[c] ? "text-right whitespace-nowrap tabular-nums" : ""}`}>
										{cell ?? <span className="text-neutral-300">—</span>}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				{props.rows.length === 0 && <p className="px-4 py-3 text-sm text-neutral-400">No rows.</p>}
			</div>
			{props.rows.length > COLLAPSED_ROWS && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="w-full border-t border-neutral-100 px-4 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
				>
					{expanded ? "Show less" : `Show all ${props.rows.length} rows`}
				</button>
			)}
		</Frame>
	);
}

const isNumberLike = (value: string | number) =>
	typeof value === "number" || /^[-+]?[$€£]?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB])?$/.test(value.trim());

const trendColor = { up: "text-emerald-700", down: "text-red-700", flat: "text-neutral-500" };
const trendArrow = { up: <ArrowUpIcon />, down: <ArrowDownIcon />, flat: <ArrowRightIcon /> };

function StatsWidget({ props }: { props: StatsProps }) {
	return (
		<Frame title={props.title}>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-px bg-neutral-100">
				{props.items.map((item, i) => (
					<div key={i} className="flex flex-col gap-1 bg-white px-4 py-3">
						<span className="text-xs text-neutral-500">{item.label}</span>
						<span className="text-2xl font-medium tabular-nums">{item.value}</span>
						{item.change && (
							<span className={`flex items-center gap-1 text-xs ${trendColor[item.trend ?? "flat"]}`}>
								{item.trend && trendArrow[item.trend]}
								{item.change}
							</span>
						)}
					</div>
				))}
			</div>
		</Frame>
	);
}

function CardWidget({ props }: { props: CardProps }) {
	return (
		<figure className="max-w-md overflow-hidden rounded-xl border border-neutral-200">
			<figcaption className="border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
				<p className="font-medium">{props.title}</p>
				{props.subtitle && <p className="text-sm text-neutral-500">{props.subtitle}</p>}
			</figcaption>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
				{props.fields.map((f, i) => (
					<div key={i} className="contents">
						<dt className="text-neutral-500">{f.label}</dt>
						<dd className="break-words">{f.value}</dd>
					</div>
				))}
			</dl>
		</figure>
	);
}
