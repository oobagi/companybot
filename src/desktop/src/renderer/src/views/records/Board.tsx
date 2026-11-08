import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticUpdate } from "convex/browser";
import type { FunctionArgs } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { PlusIcon } from "../../icons";
import { navigate } from "../../router";
import { type DragProps, useDragList } from "../../sortable";
import { LoadMore, Loading, Notice, boardCardButton, compactControlClass, laneAddButton, trailingAction, useRun } from "../../ui";
import { type ListArgs, type RecordType, type Row, usePagedRows } from "./data";
import { ChoiceChips, Chip } from "./fields";
import { type Refs, type TypeField, recordPath, valueText } from "./logic";

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

/** The board's order without a sort: the one cards are dragged into (records.rank). */
const MANUAL = { field: "manualOrder", order: "asc" } as const;

/**
 * A card dropped, at once: out of its column, and into the one it landed in where it was let go (only in the
 * manual order; a sorted column places it when the server answers). Only board columns (`group`) change.
 */
const optimisticMove: OptimisticUpdate<FunctionArgs<typeof api.records.move>> = (store, args) => {
	const lists = store.getAllQueries(api.records.list).filter((q) => q.args.group && q.value);
	const from = lists.find((q) => q.value!.page.some((r) => r._id === args.recordId));
	const row = from?.value!.page.find((r) => r._id === args.recordId);
	if (!from || !row) return;
	const [key, value] = Object.entries(args.values ?? {})[0] ?? [];
	const moved = key === undefined ? row : { ...row, values: Object.fromEntries(Object.entries({ ...row.values, [key]: value }).filter(([, v]) => v !== null && v !== undefined)) };
	const column = key === undefined ? from.args.group!.option : ((value as string | null) ?? null);
	for (const q of lists) store.setQuery(api.records.list, q.args, { ...q.value!, page: q.value!.page.filter((r) => r._id !== args.recordId) });
	const into = store
		.getAllQueries(api.records.list)
		.filter((q) => q.value && q.args.group?.field === from.args.group!.field && q.args.group.option === column && q.args.typeId === from.args.typeId && q.args.sort?.field === MANUAL.field);
	const place = (q: (typeof into)[number], at: number) => {
		const page = [...q.value!.page];
		page.splice(at, 0, moved);
		store.setQuery(api.records.list, q.args, { ...q.value!, page });
	};
	for (const q of into) {
		const page = q.value!.page;
		if (args.after && page.some((r) => r._id === args.after)) return place(q, page.findIndex((r) => r._id === args.after) + 1);
		if (args.before && page.some((r) => r._id === args.before)) return place(q, page.findIndex((r) => r._id === args.before));
	}
	const first = into.find((q) => !q.args.paginationOpts.cursor);
	if (first && !args.after && !args.before) place(first, 0);
};
const moveUpdate = () => optimisticMove;

/** A card in flight: where it came from, where it would land (`to`: a column, null over none that takes it; `index` among that column's other cards), and what it shows. */
type CardDrag = { id: string; from: string; fromIndex: number; to: string | null; index: number; size: number; width: number; row: Row; refs: Refs };
/** Between cards, as `gap-2`. */
const GAP = 8;
/** Near this close to the board's edge, a dragged card scrolls it, faster the closer. */
const EDGE = 40;

/**
 * Cards in a column per option of `group`, after "No <field>". Each column is its own list
 * (the view's filters, plus that option as `group`, outside the filter limit), in the view's sort, or without
 * one in the manual order cards are dragged into, like Notion. Drag a card within its column to order it
 * (no sort), or to another column to set the field there, through `records.move`: its usual permission and history.
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
	/** A new record in a column, the option already set (null: "No <field>"); `last`: from its foot, so it goes last. */
	onAdd?: (option: string | null, last: boolean) => void;
}) {
	const move = useMutation(api.records.move, moveUpdate);
	const updateField = useMutation(api.fields.update, optionsUpdate);
	const { error, run } = useRun();
	const active = (group.options ?? []).filter((o) => !o.retired);
	const saveOptions = (options: { id?: string; label: string; color?: string }[]) =>
		run(updateField({ fieldId: group._id as Id<"recordFields">, options: options.map(({ id, label, color }) => ({ ...(id && { id }), label, ...(color && { color }) })) }));
	// Drag a column by its header to reorder the options, like Notion. "No <field>" stays first; removed ones stay last.
	const board = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
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
	const lanes: { id: string; label: string; retired: boolean; color?: string }[] = [
		{ id: "", label: `No ${group.label}`, retired: false },
		...(group.options ?? []).map((o) => ({ ...o, retired: !!o.retired })),
	];
	const props = cards.filter((f) => f.key !== "name" && f.key !== group.key);
	const name = type.fields.find((f) => f.key === "name") as TypeField;
	const sorted = !!args.sort;
	// Cards are scrolled under the column headers (past the room above them): their fade shows.
	const [under, setUnder] = useState(false);

	// Dragging a card: a copy follows the pointer (above everything, so no column clips it) while the cards
	// make room where it would land, and the board scrolls when it nears an edge.
	const [drag, setDrag] = useState<CardDrag>();
	const ghost = useRef<HTMLDivElement>(null);
	const ghostAt = useRef({ x: 0, y: 0 });
	useEffect(() => {
		if (drag && ghost.current) ghost.current.style.transform = `translate3d(${ghostAt.current.x}px, ${ghostAt.current.y}px, 0)`;
	}, [drag]);
	const pick = (e: React.PointerEvent<HTMLElement>, row: Row, refs: Refs, lane: string, fromIndex: number) => {
		if (!canEdit || e.button !== 0 || e.ctrlKey || e.metaKey) return;
		const el = e.currentTarget;
		const x0 = e.clientX;
		const y0 = e.clientY;
		let pointer = { x: x0, y: y0 };
		let live: CardDrag | undefined;
		let grab = { x: 0, y: 0 };
		let frame = 0;
		const follow = () => {
			ghostAt.current = { x: pointer.x - grab.x, y: pointer.y - grab.y };
			if (ghost.current) ghost.current.style.transform = `translate3d(${ghostAt.current.x}px, ${ghostAt.current.y}px, 0)`;
		};
		// The column under the pointer (the nearest, between them), and where among its other cards the pointer is.
		const target = (d: CardDrag): Pick<CardDrag, "to" | "index"> => {
			const columns = [...(board.current?.querySelectorAll<HTMLElement>("section[data-column]") ?? [])];
			const distance = (c: HTMLElement) => {
				const r = c.getBoundingClientRect();
				return pointer.x < r.left ? r.left - pointer.x : pointer.x > r.right ? pointer.x - r.right : 0;
			};
			const column = columns.sort((a, b) => distance(a) - distance(b))[0];
			if (!column || column.dataset.retired) return { to: null, index: 0 };
			const to = column.dataset.column!;
			if (sorted) return { to, index: 0 };
			const top = column.getBoundingClientRect().top;
			let index = 0;
			for (const card of column.querySelectorAll<HTMLElement>("[data-card]")) {
				if (card.dataset.card === d.id) continue;
				// Where it sits with the dragged card taken out (cards past it in its own column close up).
				const after = to === d.from && Number(card.dataset.index) > d.fromIndex;
				if (top + card.offsetTop + card.offsetHeight / 2 - (after ? d.size + GAP : 0) < pointer.y) index++;
			}
			return { to, index };
		};
		const update = () => {
			if (!live) return;
			follow();
			const next = target(live);
			if (next.to !== live.to || next.index !== live.index) setDrag((live = { ...live, ...next }));
		};
		const autoscroll = () => {
			frame = 0;
			const area = scroller.current;
			if (!live || !area) return;
			const r = area.getBoundingClientRect();
			const speed = (p: number, lo: number, hi: number) => (p < lo + EDGE ? -Math.ceil((lo + EDGE - p) / 4) : p > hi - EDGE ? Math.ceil((p - (hi - EDGE)) / 4) : 0);
			const dx = speed(pointer.x, r.left, r.right);
			const dy = speed(pointer.y, r.top, r.bottom);
			if (!dx && !dy) return;
			area.scrollLeft += dx;
			area.scrollTop += dy;
			update();
			frame = requestAnimationFrame(autoscroll);
		};
		const moveTo = (ev: PointerEvent) => {
			pointer = { x: ev.clientX, y: ev.clientY };
			if (!live) {
				if (Math.hypot(pointer.x - x0, pointer.y - y0) < 4) return;
				const r = el.getBoundingClientRect();
				grab = { x: x0 - r.left, y: y0 - r.top };
				live = { id: row._id, from: lane, fromIndex, to: lane, index: fromIndex, size: r.height, width: r.width, row, refs };
				follow();
				setDrag(live);
				document.documentElement.classList.add("sorting");
				window.getSelection()?.removeAllRanges();
			}
			ev.preventDefault();
			update();
			if (!frame) frame = requestAnimationFrame(autoscroll);
		};
		const end = () => {
			window.removeEventListener("pointermove", moveTo);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("keydown", key, true);
			if (frame) cancelAnimationFrame(frame);
			document.documentElement.classList.remove("sorting");
			setDrag(undefined);
		};
		const up = () => {
			const done = live;
			end();
			if (!done) return;
			// The click that ends a drag doesn't open the card.
			const swallow = (ev: MouseEvent) => (ev.stopPropagation(), ev.preventDefault());
			window.addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
			drop(done);
		};
		const cancel = () => end();
		const key = (ev: KeyboardEvent) => ev.key === "Escape" && (ev.stopPropagation(), end());
		window.addEventListener("pointermove", moveTo, { passive: false });
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("keydown", key, true);
	};
	const drop = ({ id, from, fromIndex, to, index }: CardDrag) => {
		if (to === null || (to === from && (sorted || index === fromIndex))) return;
		const column = board.current?.querySelector<HTMLElement>(`section[data-column="${CSS.escape(to)}"]`);
		const others = [...(column?.querySelectorAll<HTMLElement>("[data-card]") ?? [])].map((c) => c.dataset.card!).filter((k) => k !== id);
		const near = (k: string | undefined) => (sorted ? undefined : (k as Id<"records"> | undefined));
		run(move({ recordId: id as Id<"records">, after: near(others[index - 1]), before: near(others[index]), ...(to !== from && { values: { [group.key]: to || null } }) }));
	};
	/** How far a column's card (`index`, or its foot: `Infinity`) slides to make room for the dragged one, or close up behind it. */
	const shiftOf = (lane: string, index: number) => {
		if (!drag) return undefined;
		const room = drag.size + GAP;
		let px = 0;
		const own = lane === drag.from;
		if (own && index > drag.fromIndex) px -= room;
		const without = own && index > drag.fromIndex ? index - 1 : index;
		if (lane === drag.to && !sorted && without >= drag.index) px += room;
		return px;
	};
	return (
		// Fills the rest of the screen and scrolls itself, like a table (`Page`'s `fill`): the tabs stay put and the scrollbar sits at the bottom.
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<Notice>{error}</Notice>
			{/* Lanes start at the column and scroll out to the screen's edges; all as tall as the longest, so each is a full-height drop target. */}
			{/* Room above the columns (`-mt-2 pt-2`), so a lifted column's shadow isn't cut off by the scroll area; their headers stick past it (`-top-2`), at its very top, so no card shows above them. */}
			<div ref={scroller} className="bleed -mt-2 min-h-0 flex-1 overflow-y-auto pt-2 pb-2" onScroll={(e) => setUnder(e.currentTarget.scrollTop > 8)}>
			<div ref={board} className="flex min-h-full w-max gap-3">
				{lanes.map((lane) => (
					<Lane
						key={lane.id}
						id={lane.id}
						type={type}
						label={lane.label}
						color={lane.color}
						retired={lane.retired}
						args={{ ...args, sort: args.sort ?? MANUAL, group: { field: group.key, option: lane.id || null } }}
						name={name}
						props={props}
						under={under}
						drag={lane.id ? item(lane.id, canManage && !lane.retired) : undefined}
						onAdd={onAdd && !lane.retired ? (last) => onAdd(lane.id || null, last) : undefined}
						addLabel={`New ${type.name.toLowerCase()}`}
						onPick={canEdit ? (e, row, refs, index) => pick(e, row, refs, lane.id, index) : undefined}
						dragging={drag?.id}
						target={!!drag && drag.to === lane.id && (sorted || drag.to !== drag.from)}
						shift={(index) => shiftOf(lane.id, index)}
					/>
				))}
				{canManage && <NewColumn onSave={(label) => saveOptions([...active, { label }])} />}
			</div>
			</div>
			{drag &&
				createPortal(
					<div ref={ghost} className="pointer-events-none fixed top-0 left-0 z-50" style={{ width: drag.width }}>
						<div className={`${boardCardButton} board-card-lifted w-full`}>
							<CardBody row={drag.row} refs={drag.refs} name={name} props={props} />
						</div>
					</div>,
					document.body,
				)}
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

/** What a card shows: its name, then the board's properties that have a value. */
function CardBody({ row, refs, name, props }: { row: Row; refs: Refs; name: TypeField; props: TypeField[] }) {
	return (
		<>
			<span className="font-medium break-words">{valueText(name, row.values[name.key], refs) || "Untitled"}</span>
			{props.map(
				(f) =>
					row.values[f.key] !== undefined &&
					(f.kind === "choice" ? (
						<span key={f.key} title={f.label}>
							<ChoiceChips field={f} ids={[row.values[f.key]!].flat().map(String)} />
						</span>
					) : (
						<span key={f.key} title={f.label} className="truncate text-xs text-neutral-500">
							{valueText(f, row.values[f.key], refs)}
						</span>
					)),
			)}
		</>
	);
}

/** Slides a card or a column's foot while a card is dragged past it (with `--sort-shift`); nothing otherwise, so a drop lands without a slide back. */
const sliding = (px: number | undefined) => (px === undefined ? "" : "sortable-shift sortable-y");

/**
 * One board column. A removed option's column only shows while cards still use it, and
 * takes no cards, since a removed option can't be set again.
 */
function Lane({
	id,
	type,
	label,
	color,
	retired,
	args,
	name,
	props,
	under,
	drag,
	onAdd,
	addLabel,
	onPick,
	dragging,
	target,
	shift,
}: {
	id: string;
	type: RecordType;
	label: string;
	/** The option's, shown as its chip; none for "No <field>". */
	color?: string;
	retired: boolean;
	args: ListArgs;
	name: TypeField;
	props: TypeField[];
	under: boolean;
	/** From the board's drag list: an option's column moves by its header. */
	drag?: DragProps;
	onAdd?: (last: boolean) => void;
	addLabel: string;
	/** Starts dragging a card (the board does the rest). */
	onPick?: (e: React.PointerEvent<HTMLElement>, row: Row, refs: Refs, index: number) => void;
	/** The card being dragged, anywhere: it's hidden here while its copy moves. */
	dragging?: string;
	/** A dragged card would land here, by the sort: the column lights up. */
	target: boolean;
	shift: (index: number) => number | undefined;
}) {
	const { rows, refs, status, loadMore, setEnd } = usePagedRows(args);
	if (retired && rows.length === 0 && status === "Exhausted") return null;
	const foot = shift(Number.POSITIVE_INFINITY);
	return (
		<section
			{...drag}
			onPointerDown={undefined}
			data-lane={id || undefined}
			data-column={id}
			data-retired={retired || undefined}
			className={`board-lane group/lane relative flex w-64 shrink-0 flex-col overflow-clip gap-2 rounded-xl p-2 ${target ? "bg-neutral-200/70" : "bg-neutral-100/70"} ${drag?.className ?? ""}`}
		>
			{/* Sticks as the board scrolls, like a table's header. The outer square is the page's own white, so
			    cards passing under don't show through the rounded corners; the column's color is on the inside.
			    Below it, cards fade out into the column (styles.css's scrim) instead of cutting off. */}
			<div className="sticky -top-2 z-10 -mx-2 -mt-2 bg-white">
				<div
					aria-hidden
					className={`scrim-top pointer-events-none absolute inset-x-0 top-full h-4 ${target ? "[--scrim:color-mix(in_srgb,var(--color-neutral-200)_70%,white)]" : "[--scrim:color-mix(in_srgb,var(--color-neutral-100)_70%,white)]"}`}
					data-under={under || undefined}
				/>
				<div onPointerDown={drag?.onPointerDown} className={`flex items-center gap-2 rounded-t-xl px-3 pt-2 pb-1 text-sm font-medium text-neutral-700 ${drag?.onPointerDown ? "cursor-grab" : ""} ${target ? "bg-neutral-200/70" : "bg-neutral-100/70"}`}>
					{id ? (
						<Chip color={color}>
							<span className="truncate">{retired ? `${label} (removed)` : label}</span>
						</Chip>
					) : (
						<span className="truncate">{label}</span>
					)}
					<span className="text-neutral-400">{status === "LoadingFirstPage" ? "" : `${rows.length}${status === "Exhausted" ? "" : "+"}`}</span>
					{onAdd && (
						<button type="button" aria-label={`${addLabel} in ${label}`} title={`${addLabel} in ${label}`} onClick={() => onAdd(false)} className={`${trailingAction} -mr-1 ml-auto opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100`}>
							<PlusIcon />
						</button>
					)}
				</div>
			</div>
			{rows.map((r, i) => {
				const slide = shift(i);
				return (
					<button
						key={r._id}
						type="button"
						data-card={r._id}
						data-index={i}
						onPointerDown={onPick && !retired ? (e) => onPick(e, r, refs, i) : undefined}
						onClick={() => navigate(...recordPath(type.key, r._id))}
						style={{ "--sort-shift": `${slide ?? 0}px` } as React.CSSProperties}
						className={`${boardCardButton} ${sliding(slide)} ${dragging === r._id ? "invisible" : ""}`}
					>
						<CardBody row={r} refs={refs} name={name} props={props} />
					</button>
				);
			})}
			<div ref={setEnd} style={{ "--sort-shift": `${foot ?? 0}px` } as React.CSSProperties} className={`flex flex-col items-center ${sliding(foot)}`}>
				{status === "LoadingFirstPage" ? <Loading /> : <LoadMore status={status} onMore={() => loadMore(25)} />}
			</div>
			{onAdd && status !== "LoadingFirstPage" && (
				<button type="button" onClick={() => onAdd(true)} style={{ "--sort-shift": `${foot ?? 0}px` } as React.CSSProperties} className={`${laneAddButton} ${sliding(foot)}`}>
					<PlusIcon /> {addLabel}
				</button>
			)}
		</section>
	);
}
