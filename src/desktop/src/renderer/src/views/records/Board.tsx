import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticUpdate } from "convex/browser";
import type { FunctionArgs } from "convex/server";
import { useRef, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { PlusIcon } from "../../icons";
import { navigate } from "../../router";
import { type DragProps, useDragList } from "../../sortable";
import { LoadMore, Loading, Notice, boardCardButton, compactControlClass, laneAddButton, trailingAction, useRun } from "../../ui";
import { type ListArgs, type RecordType, usePagedRows } from "./data";
import { ChoiceChips, Chip } from "./fields";
import { type TypeField, recordPath, valueText } from "./logic";

// A database view as a board: cards in a column per option of a choice field. See wiki/data.md.

/** A field's options in a new order, at once: the columns move as they're dropped. Only a reorder (every option has an id). */
const optimisticOptions: OptimisticUpdate<FunctionArgs<typeof api.fields.update>> = (store, args) => {
	const next = args.options;
	if (!next || next.some((o) => !o.id)) return;
	for (const { args: queryArgs, value } of store.getAllQueries(api.recordTypes.list)) {
		if (!value) continue;
		store.setQuery(api.recordTypes.list, queryArgs, value.map((type) => ({
			...type,
			fields: type.fields.map((f) => {
				if (f._id !== args.fieldId || !f.options) return f;
				const all = f.options;
				const active = next.map((o) => all.find((e) => e.id === o.id)).filter((o) => o !== undefined);
				return { ...f, options: [...active, ...all.filter((e) => !active.includes(e)).map((e) => ({ ...e, retired: true }))] };
			}),
		})));
	}
};
/** Module-level, so `useMutation` stays stable between renders. */
const optionsUpdate = () => optimisticOptions;

/**
 * Cards in a column per option of `group`, after "No <field>". Each column is its own list
 * (the view's filters, plus that option as `group`, outside the filter limit), in the view's order. Dragging a card to another
 * column sets the field through `records.update`, with its usual permission and history.
 * Like Notion with a sort on, cards keep the list's order: there's no manual order to drag to.
 */
export function Board({
	type,
	args,
	group,
	cards,
	canEdit,
	canManage,
	onAdd,
}: {
	type: RecordType;
	args: ListArgs;
	group: TypeField;
	cards: TypeField[];
	canEdit: boolean;
	/** Columns are the field's options: adding or reordering one changes the field, which takes its own permission. */
	canManage: boolean;
	/** A new record in a column, the option already set (null: "No <field>"). */
	onAdd?: (option: string | null) => void;
}) {
	const update = useMutation(api.records.update);
	const updateField = useMutation(api.fields.update, optionsUpdate);
	const active = (group.options ?? []).filter((o) => !o.retired);
	const saveOptions = (options: { id?: string; label: string; color?: string }[]) =>
		run(updateField({ fieldId: group._id as Id<"recordFields">, options: options.map(({ id, label, color }) => ({ ...(id && { id }), label, ...(color && { color }) })) }));
	// Drag a column by its header to reorder the options, like Notion. "No <field>" stays first; removed ones stay last.
	const board = useRef<HTMLDivElement>(null);
	const { item } = useDragList({
		axis: "x",
		enabled: canManage,
		onDrop: (from, index) => {
			const drawn = [...(board.current?.querySelectorAll<HTMLElement>("[data-lane]") ?? [])].map((el) => el.dataset.lane!);
			const before = drawn.filter((k) => k !== from.id)[index];
			const moved = active.find((o) => o.id === from.id);
			if (!moved) return;
			const rest = active.filter((o) => o !== moved);
			const at = rest.findIndex((o) => o.id === before);
			const next = at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)];
			if (next.some((o, i) => o !== active[i])) saveOptions(next);
		},
	});
	const { error, run } = useRun();
	const lanes: { id: string; label: string; retired: boolean; color?: string }[] = [
		{ id: "", label: `No ${group.label}`, retired: false },
		...(group.options ?? []).map((o) => ({ ...o, retired: !!o.retired })),
	];
	const props = cards.filter((f) => f.key !== "name" && f.key !== group.key);
	// Cards are scrolled under the column headers: their fade shows.
	const [under, setUnder] = useState(false);
	return (
		// Fills the rest of the screen and scrolls itself, like a table (`Page`'s `fill`): the tabs stay put and the scrollbar sits at the bottom.
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<Notice>{error}</Notice>
			{/* Lanes start at the column and scroll out to the screen's edges; all as tall as the longest, so each is a full-height drop target. */}
			<div className="bleed min-h-0 flex-1 overflow-y-auto pb-2" onScroll={(e) => setUnder(e.currentTarget.scrollTop > 0)}>
			<div ref={board} className="flex min-h-full w-max gap-3">
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
						under={under}
						drag={lane.id ? item(lane.id, canManage && !lane.retired) : undefined}
						onAdd={onAdd && !lane.retired ? () => onAdd(lane.id || null) : undefined}
						addLabel={`New ${type.name.toLowerCase()}`}
						onMove={(recordId) => run(update({ recordId: recordId as Id<"records">, values: { [group.key]: lane.id || null } }))}
					/>
				))}
				{canManage && <NewColumn onSave={(label) => saveOptions([...active, { label }])} />}
			</div>
			</div>
		</div>
	);
}

/** The board's last column: names a new option of the grouping field, which shows as a column. */
function NewColumn({ onSave }: { onSave: (label: string) => void }) {
	const [naming, setNaming] = useState(false);
	const [label, setLabel] = useState("");
	const done = () => {
		if (label.trim()) onSave(label.trim());
		setNaming(false);
		setLabel("");
	};
	return (
		<div className="w-64 shrink-0">
			{naming ? (
				<input
					autoFocus
					aria-label="Column name"
					placeholder="Column name"
					value={label}
					maxLength={100}
					onChange={(e) => setLabel(e.target.value)}
					onBlur={done}
					onKeyDown={(e) => {
						if (e.key === "Enter") done();
						if (e.key === "Escape") (setLabel(""), setNaming(false));
					}}
					className={`${compactControlClass} w-full`}
				/>
			) : (
				<button type="button" onClick={() => setNaming(true)} className={laneAddButton}>
					<PlusIcon /> New column
				</button>
			)}
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
	under,
	drag,
	onAdd,
	addLabel,
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
	under: boolean;
	/** From the board's drag list: an option's column moves by its header. */
	drag?: DragProps;
	onAdd?: () => void;
	addLabel: string;
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
			{...drag}
			onPointerDown={undefined}
			data-lane={id || undefined}
			className={`board-lane group/lane flex w-64 shrink-0 flex-col overflow-clip gap-2 rounded-xl p-2 ${over ? "bg-neutral-200/70" : "bg-neutral-100/70"} ${drag?.className ?? ""}`}
		>
			{/* Sticks as the board scrolls, like a table's header. The outer square is the page's own white, so
			    cards passing under don't show through the rounded corners; the column's color is on the inside.
			    Below it, cards fade out into the column (styles.css's scrim) instead of cutting off. */}
			<div className="sticky top-0 z-10 -mx-2 -mt-2 bg-white">
				<div
					aria-hidden
					className={`scrim-top pointer-events-none absolute inset-x-0 top-full h-4 ${over ? "[--scrim:color-mix(in_srgb,var(--color-neutral-200)_70%,white)]" : "[--scrim:color-mix(in_srgb,var(--color-neutral-100)_70%,white)]"}`}
					data-under={under || undefined}
				/>
				<div onPointerDown={drag?.onPointerDown} className={`flex items-center gap-2 rounded-t-xl px-3 pt-2 pb-1 text-sm font-medium text-neutral-700 ${drag?.onPointerDown ? "cursor-grab" : ""} ${over ? "bg-neutral-200/70" : "bg-neutral-100/70"}`}>
					{id ? (
						<Chip color={color}>
							<span className="truncate">{retired ? `${label} (removed)` : label}</span>
						</Chip>
					) : (
						<span className="truncate">{label}</span>
					)}
					<span className="text-neutral-400">{status === "LoadingFirstPage" ? "" : `${rows.length}${status === "Exhausted" ? "" : "+"}`}</span>
					{onAdd && (
						<button type="button" aria-label={`${addLabel} in ${label}`} title={`${addLabel} in ${label}`} onClick={onAdd} className={`${trailingAction} -mr-1 ml-auto opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100`}>
							<PlusIcon />
						</button>
					)}
				</div>
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
			{onAdd && status !== "LoadingFirstPage" && (
				<button type="button" onClick={onAdd} className={laneAddButton}>
					<PlusIcon /> {addLabel}
				</button>
			)}
		</section>
	);
}
