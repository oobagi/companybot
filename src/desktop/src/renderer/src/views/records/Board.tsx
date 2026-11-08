import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { navigate } from "../../router";
import { LoadMore, Loading, Notice, boardCardButton, useRun } from "../../ui";
import { type ListArgs, type RecordType, usePagedRows } from "./data";
import { ChoiceChips, Chip } from "./fields";
import { type TypeField, recordPath, valueText } from "./logic";

// A database view as a board: cards in a column per option of a choice field. See wiki/data.md.

/**
 * Cards in a column per option of `group`, after "No <field>". Each column is its own list
 * (the view's filters, plus that option as `group`, outside the filter limit), in the view's order. Dragging a card to another
 * column sets the field through `records.update`, with its usual permission and history.
 * Like Notion with a sort on, cards keep the list's order: there's no manual order to drag to.
 */
export function Board({ type, args, group, cards, canEdit }: { type: RecordType; args: ListArgs; group: TypeField; cards: TypeField[]; canEdit: boolean }) {
	const update = useMutation(api.records.update);
	const { error, run } = useRun();
	const lanes: { id: string; label: string; retired: boolean; color?: string }[] = [
		{ id: "", label: `No ${group.label}`, retired: false },
		...(group.options ?? []).map((o) => ({ ...o, retired: !!o.retired })),
	];
	const props = cards.filter((f) => f.key !== "name" && f.key !== group.key);
	return (
		// Fills the rest of the screen and scrolls itself, like a table (`Page`'s `fill`): the tabs stay put and the scrollbar sits at the bottom.
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<Notice>{error}</Notice>
			{/* Lanes start at the column and scroll out to the screen's edges; all as tall as the longest, so each is a full-height drop target. */}
			<div className="bleed min-h-0 flex-1 overflow-y-auto pb-2">
			<div className="flex min-h-full w-max gap-3">
				{lanes.map((lane) => (
					<Lane
						key={lane.id}
						id={lane.id}
						groupBy={group.key}
						type={type}
						label={lane.label}
						color={lane.color}
						retired={lane.retired}
						args={{ ...args, group: { field: group.key, option: lane.id || null } }}
						name={type.fields.find((f) => f.key === "name") as TypeField}
						props={props}
						canEdit={canEdit}
						onMove={(recordId) => run(update({ recordId: recordId as Id<"records">, values: { [group.key]: lane.id || null } }))}
					/>
				))}
			</div>
			</div>
		</div>
	);
}

/** Scope drags to their database and grouping, including across windows or a live grouping change. */
const CARD = "application/x-companybot-card";

/**
 * One board column. A removed option's column only shows while cards still use it, and
 * takes no cards, since a removed option can't be set again.
 */
function Lane({
	id,
	groupBy,
	type,
	label,
	color,
	retired,
	args,
	name,
	props,
	canEdit,
	onMove,
}: {
	id: string;
	groupBy: string;
	type: RecordType;
	label: string;
	/** The option's, shown as its chip; none for "No <field>". */
	color?: string;
	retired: boolean;
	args: ListArgs;
	name: TypeField;
	props: TypeField[];
	canEdit: boolean;
	onMove: (recordId: string) => void;
}) {
	const { rows, refs, status, loadMore, setEnd } = usePagedRows(args);
	const [over, setOver] = useState(false);
	if (retired && rows.length === 0 && status === "Exhausted") return null;
	return (
		<section
			onDragOver={(e) => canEdit && !retired && e.dataTransfer.types.includes(CARD) && (e.preventDefault(), setOver(true))}
			onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				if (!canEdit || retired) return;
				try {
					const card = JSON.parse(e.dataTransfer.getData(CARD) || "null");
					if (card?.typeId === type._id && card.groupBy === groupBy && typeof card.id === "string" && typeof card.from === "string" && card.from !== id) onMove(card.id);
				} catch {
					// Ignore unrelated or malformed external drags.
				}
			}}
			className={`flex w-64 shrink-0 flex-col gap-2 rounded-xl p-2 ${over ? "bg-neutral-200/70" : "bg-neutral-100/70"}`}
		>
			{/* Sticks as the board scrolls, like a table's header; opaque in the column's own color, so cards pass under it. */}
			<div className={`sticky top-0 z-10 -mx-2 -mt-2 flex items-center gap-2 rounded-t-xl bg-white px-3 pt-2 pb-1 text-sm font-medium text-neutral-700 before:absolute before:inset-0 before:-z-10 before:rounded-t-xl ${over ? "before:bg-neutral-200/70" : "before:bg-neutral-100/70"}`}>
				{id ? (
					<Chip color={color}>
						<span className="truncate">{retired ? `${label} (removed)` : label}</span>
					</Chip>
				) : (
					<span className="truncate">{label}</span>
				)}
				<span className="text-neutral-400">{status === "LoadingFirstPage" ? "" : `${rows.length}${status === "Exhausted" ? "" : "+"}`}</span>
			</div>
			{rows.map((r) => (
				<button
					key={r._id}
					type="button"
					draggable={canEdit}
					onDragStart={(e) => e.dataTransfer.setData(CARD, JSON.stringify({ id: r._id, from: id, typeId: type._id, groupBy }))}
					onClick={() => navigate(...recordPath(type.key, r._id))}
					className={boardCardButton}
				>
					<span className="font-medium break-words">{valueText(name, r.values[name.key], refs) || "Untitled"}</span>
					{props.map(
						(f) =>
							r.values[f.key] !== undefined &&
							(f.kind === "choice" ? (
								<span key={f.key} title={f.label}>
									<ChoiceChips field={f} ids={[r.values[f.key]!].flat().map(String)} />
								</span>
							) : (
								<span key={f.key} title={f.label} className="truncate text-xs text-neutral-500">
									{valueText(f, r.values[f.key], refs)}
								</span>
							)),
					)}
				</button>
			))}
			<div ref={setEnd} className="flex flex-col items-center">
				{status === "LoadingFirstPage" ? <Loading /> : <LoadMore status={status} onMore={() => loadMore(25)} />}
			</div>
		</section>
	);
}
