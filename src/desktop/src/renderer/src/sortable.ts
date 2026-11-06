import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStoredIds } from "./arrangements";
import type { ArrangementCommand, ArrangementList } from "@companybot/core/arrangements";

// Drag to reorder, with the pointer (not the browser's drag-and-drop, which drags a picture of the
// row and drops only on an exact line). Press and move a few pixels to pick a row up; it follows the
// pointer along the list while the others slide out of its way; let go anywhere and it lands in the
// gap that's open. Escape puts it back. Lists in one `group` (the rail's pins and recents, Drive's
// tree) take rows from each other. A row can take the dragged one into it (`holds`: a Drive folder):
// let go over its middle and it goes there. Rows can sit in another row's box (a folder's open level):
// they're rows of the group too, and a dragged box carries its own.

type Axis = "x" | "y";

/** The row being dragged: its list, its id there, and what that list says about it (`data`). */
export type Dragged = { list: string; id: string; data?: unknown };

/** Spread on a row. A row with rows nested under it (a channel's threads) puts `box` on a wrapper and `handle` on the row (`splitDrag`). */
export type DragProps = {
	ref?: (el: HTMLElement | null) => void;
	style?: React.CSSProperties;
	className?: string;
	onPointerDown?: (e: React.PointerEvent) => void;
};

export function splitDrag(d: DragProps | undefined) {
	return { box: { ref: d?.ref, style: d?.style, className: d?.className ?? "" }, handle: d && { onPointerDown: d.onPointerDown } };
}

/** `items` in the saved order; unsaved ones keep their place relative to each other, after the saved ones. */
export function applyOrder<T>(order: readonly string[], items: readonly T[], id: (item: T) => string): T[] {
	const rank = new Map(order.map((k, i) => [k, i]));
	return items
		.map((item, i) => ({ item, i, r: rank.get(id(item)) ?? order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map((x) => x.item);
}

/**
 * The `move` that puts `from` at `index` of `shown` without it (the list as drawn). Ids drawn before
 * the drop but never saved go in `fill`, so it lands where it looked; saved ones this person can't
 * see stay where they are on the server.
 */
export function moveCommand(saved: readonly string[], shown: readonly string[], from: string, index: number): ArrangementCommand | undefined {
	const rest = shown.filter((k) => k !== from);
	if (shown.indexOf(from) === index && shown.includes(from)) return undefined;
	const at = Math.max(0, Math.min(index, rest.length));
	const known = new Set(saved);
	return { op: "move", id: from, beforeId: rest[at] ?? null, fill: rest.slice(0, at).filter((k) => !known.has(k)) };
}

// ---- The drag in progress, shared by every list (one pointer drags one row at a time). ----

type ListEntry = {
	group: string;
	axis: Axis;
	els: Map<string, HTMLElement>;
	enabled: boolean;
	accepts: (from: Dragged) => boolean;
	holds: (id: string, from: Dragged) => boolean;
	data: (id: string) => unknown;
	onDrop: (from: Dragged, index: number) => void;
	onDropOn: (from: Dragged, id: string) => void;
};
type StaticEntry = { group: string; el: HTMLElement; endOf?: string; startOf?: string };
const lists = new Map<string, ListEntry>();
const statics = new Map<string, StaticEntry>();

/**
 * One thing in the group, in order along the axis: a row, or a divider between lists. `parent`: the
 * row whose box it sits in (an open folder's). `holds`: it takes the dragged row into it.
 */
export type Slot = { key: string; list?: string; id?: string; start: number; size: number; pitch: number; endOf?: string; startOf?: string; parent?: string; holds?: boolean };
/** Where it'd land: a gap (`at`), as a list and an index in it (without the dragged row), or `onto` a row that takes it in. */
type Target = { list: string; index: number; at: number; onto?: { list: string; id: string } };
type Session = {
	group: string;
	axis: Axis;
	from: Dragged;
	el: HTMLElement;
	slots: Slot[];
	source: number;
	target: Target;
	/** How far each other thing slides, by slot key. */
	shifts: Map<string, number>;
	dropping: boolean;
};
let session: Session | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const snapshot = () => session;

const slotKey = (list: string, id: string) => `${list}\u0000${id}`;
const start = (r: DOMRect, axis: Axis) => (axis === "y" ? r.top : r.left);
const extent = (r: DOMRect, axis: Axis) => (axis === "y" ? r.height : r.width);
const pointer = (e: PointerEvent | React.PointerEvent, axis: Axis) => (axis === "y" ? e.clientY : e.clientX);
const scrollOf = (el: HTMLElement, axis: Axis) => (axis === "y" ? el.scrollTop : el.scrollLeft);

/** The nearest ancestor that scrolls along `axis`, for scrolling while dragging near its edge. */
function scroller(el: HTMLElement, axis: Axis): HTMLElement | undefined {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const style = getComputedStyle(p);
		const overflow = axis === "y" ? style.overflowY : style.overflowX;
		if (/(auto|scroll)/.test(overflow) && (axis === "y" ? p.scrollHeight > p.clientHeight : p.scrollWidth > p.clientWidth)) return p;
	}
	return undefined;
}

function measure(group: string, axis: Axis, from: Dragged): Slot[] {
	const raw: { slot: Omit<Slot, "pitch">; el: HTMLElement }[] = [];
	for (const [list, l] of lists) {
		if (l.group !== group) continue;
		for (const [id, el] of l.els) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			raw.push({ el, slot: { key: slotKey(list, id), list, id, start: start(r, axis), size: extent(r, axis), holds: (list !== from.list || id !== from.id) && l.holds(id, from) } });
		}
	}
	for (const [key, s] of statics) {
		if (s.group !== group || !s.el.isConnected) continue;
		const r = s.el.getBoundingClientRect();
		raw.push({ el: s.el, slot: { key, start: start(r, axis), size: extent(r, axis), endOf: s.endOf, startOf: s.startOf } });
	}
	// The row each sits in: its nearest ancestor that's a row of the group too.
	const owner = new Map(raw.map((r) => [r.el, r.slot.key]));
	for (const { el, slot } of raw) {
		for (let p = el.parentElement; p && !slot.parent; p = p.parentElement) slot.parent = owner.get(p);
	}
	return arrange(raw.map((r) => r.slot), slotKey(from.list, from.id));
}

/**
 * The group in order along the axis, without the rows inside the dragged one's box (they go with it,
 * and it can't go into them). A row with rows in its box (an open folder) counts only up to the first
 * of them, so it's passed like a row, not like its whole box. A slot's pitch runs from its start to the
 * next one's, so gaps and margins move with it.
 */
export function arrange(raw: readonly Omit<Slot, "pitch">[], dragged: string): Slot[] {
	const byKey = new Map(raw.map((s) => [s.key, s]));
	const carried = (s: Omit<Slot, "pitch">) => {
		for (let p = s.parent; p; p = byKey.get(p)?.parent) if (p === dragged) return true;
		return false;
	};
	const kept = raw.filter((s) => !carried(s)).sort((a, b) => a.start - b.start);
	const sized = kept.map((s, i) => {
		const next = kept[i + 1];
		return next && next.start < s.start + s.size ? { ...s, size: next.start - s.start } : s;
	});
	return sized.map((s, i) => {
		const next = sized[i + 1];
		const prev = sized[i - 1];
		const gap = next ? next.start - (s.start + s.size) : prev ? s.start - (prev.start + prev.size) : 0;
		return { ...s, pitch: s.size + Math.max(0, gap) };
	});
}

/**
 * Where a row whose leading edge is at `edge` lands, with the pointer at `point`, and how everything
 * else slides to make room.
 */
export function place(slots: readonly Slot[], source: number, edge: number, enabled: (list: string) => boolean, point?: number): Pick<Session, "target" | "shifts"> {
	const dragged = slots[source]!;
	const others = slots.filter((_, i) => i !== source);
	// The gap it's over. It passes a row once the edge it leads with (its top going up, its bottom going
	// down) crosses that row's middle: comparing middles instead, a tall row (an open sidebar section) had
	// to be dragged far past a short one before they swapped. A divider is thin, so it takes a quarter row
	// past its middle, else a pin would unpin at a twitch. A row that takes it in (`holds`) goes by the
	// pointer: over its middle half drops it in; it's passed once the pointer reaches its far quarter.
	const d = edge - dragged.start;
	const quarter = (s: Slot) => s.size / 4;
	const takesIn = (s: Slot) => !!s.holds && point !== undefined;
	const passed = (s: Slot) => {
		if (takesIn(s)) return d > 0 ? point! >= s.start + s.size - quarter(s) : point! <= s.start + quarter(s);
		const middle = s.start + s.size / 2 + (s.list ? 0 : (Math.sign(d) * dragged.size) / 4);
		return d > 0 ? edge + dragged.size > middle : edge < middle;
	};
	let at = source;
	if (d > 0) while (at < others.length && passed(others[at]!)) at++;
	else if (d < 0) while (at > 0 && passed(others[at - 1]!)) at--;
	const over = d > 0 ? others[at] : d < 0 ? others[at - 1] : undefined;
	const onto = over && takesIn(over) && point! > over.start + quarter(over) && point! < over.start + over.size - quarter(over) ? over : undefined;

	const byKey = new Map(others.map((s) => [s.key, s]));
	const holder = (s: Slot) => (s.parent ? byKey.get(s.parent) : undefined);
	const inside = (s: Slot, row: Slot) => {
		for (let p = holder(s); p; p = holder(p)) if (p === row) return true;
		return false;
	};
	const count = (list: string, gap: number) => others.slice(0, gap).filter((s) => s.list === list).length;
	// The lists a gap can put it in, first choice first. The rows ending at the gap are the one before it
	// and each box it closes (an open folder whose last row that is); the outermost comes first, since the
	// end of the folder's own rows is a drop onto the folder away, and the spot after the folder isn't.
	const spots = (gap: number) => {
		const prev = others[gap - 1];
		const next = others[gap];
		const ends: Slot[] = [];
		// A divider isn't a row, but the box it's in may end here too.
		for (let s = prev; s && !(next && inside(next, s)); s = holder(s)) if (s.list) ends.push(s);
		const after = (s: Slot) => ({ list: s.list!, index: count(s.list!, gap) });
		const out: { list: string; index: number }[] = [];
		if (ends.length) out.push(after(ends.at(-1)!));
		// Just after a divider that starts a list: its top, even while that list is empty.
		if (prev?.startOf) out.push({ list: prev.startOf, index: 0 });
		if (next?.endOf) out.push({ list: next.endOf, index: count(next.endOf, gap) });
		if (next?.list) out.push({ list: next.list, index: count(next.list, gap) });
		out.push(...ends.slice(0, -1).reverse().map(after));
		return out;
	};
	// Gaps a row can't go into (a list it can't join) fall back to the nearest one it can. Where it was is
	// always open, so a row whose list keeps no order of its own (Drive's files) can go back. The last row
	// in an open folder has no gap below it but its own: pulled half a row down past it, it leaves.
	const own = { list: dragged.list!, index: count(dragged.list!, source) };
	const pulled = d > dragged.size / 2;
	let found: Target | undefined;
	for (let k = 0; k <= others.length && !found; k++) {
		for (const g of [at - k, at + k]) {
			if (g < 0 || g > others.length) continue;
			const t = g === source ? (pulled && spots(g).find((t) => enabled(t.list))) || own : spots(g).find((t) => enabled(t.list));
			if (t) { found = { ...t, at: g }; break; }
		}
	}
	const target: Target = { ...found!, ...(onto && { onto: { list: onto.list!, id: onto.id! } }) };
	const shifts = new Map<string, number>();
	// Everything between where it was and where it goes slides one row's worth toward where it was.
	others.forEach((s, i) => {
		if (target.at <= i && i < source) shifts.set(s.key, dragged.pitch);
		else if (source <= i && i < target.at) shifts.set(s.key, -dragged.pitch);
	});
	return { target, shifts };
}

/** Dropped into a row, it leaves its list: everything after where it was closes up. */
function closed(s: Session) {
	const pitch = s.slots[s.source]!.pitch;
	return new Map(s.slots.slice(s.source + 1).map((o) => [o.key, -pitch]));
}

/** How far the dragged row moves to sit in its gap, or on the row it goes into. */
function landing(s: Session): number {
	const others = s.slots.filter((_, i) => i !== s.source);
	const dragged = s.slots[s.source]!;
	const { at, onto } = s.target;
	if (onto) {
		const i = others.findIndex((o) => o.list === onto.list && o.id === onto.id);
		return others[i]!.start - (i >= s.source ? dragged.pitch : 0) - dragged.start;
	}
	if (at === s.source) return 0;
	if (at < s.source) return (others[at]?.start ?? dragged.start) - dragged.start;
	const last = others[at - 1]!;
	return last.start + last.pitch - (dragged.start + dragged.pitch);
}

const THRESHOLD = 4;
const EDGE = 40;

function begin(list: string, id: string, el: HTMLElement, e: React.PointerEvent) {
	const l = lists.get(list);
	if (!l || session || e.button !== 0 || e.ctrlKey || e.metaKey) return;
	// Move the whole row, not just its handle (a sidebar row's handle is inside it): the row carries the
	// landing transition, so moving only the handle would snap into place instead of gliding.
	el = l.els.get(id) ?? el;
	if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
	const { axis, group } = l;
	const from: Dragged = { list, id, data: l.data(id) };
	// Lists a row may land in: the ones in its group that take it (recents take pins, not tabs; Drive's files take none).
	const takes = (k: string) => { const t = lists.get(k); return !!t?.enabled && t.accepts(from); };
	const x0 = e.clientX;
	const y0 = e.clientY;
	const area = scroller(el, axis);
	let scroll0 = area ? scrollOf(area, axis) : 0;
	const p0 = pointer(e, axis);
	const pointerId = e.pointerId;
	let last = p0;
	let frame = 0;
	let live: Session | undefined;

	const offset = () => last - p0 + (area ? scrollOf(area, axis) - scroll0 : 0);
	const update = () => {
		if (!live || live.dropping) return;
		const dragged = live.slots[live.source]!;
		// It stays within its group's rows (a row past either end, so an end is easy to hit), not over the rest of the window.
		const first = live.slots[0]!;
		const end = live.slots.at(-1)!;
		const d = Math.min(Math.max(offset(), first.start - dragged.start - dragged.size), end.start + end.size - dragged.start);
		const next = place(live.slots, live.source, dragged.start + d, takes, p0 + offset());
		el.style.transform = axis === "y" ? `translate3d(0, ${d}px, 0) scale(1.03)` : `translate3d(${d}px, 0, 0) scale(1.03)`;
		const was = live.target;
		const is = next.target;
		if (is.at !== was.at || is.list !== was.list || is.onto?.list !== was.onto?.list || is.onto?.id !== was.onto?.id) {
			session = live = { ...live, ...next };
			notify();
		}
	};
	const autoscroll = () => {
		frame = 0;
		if (!live || !area || live.dropping) return;
		const r = area.getBoundingClientRect();
		const lo = start(r, axis);
		const hi = lo + extent(r, axis);
		const speed = last < lo + EDGE ? -Math.ceil((lo + EDGE - last) / 4) : last > hi - EDGE ? Math.ceil((last - (hi - EDGE)) / 4) : 0;
		if (!speed) return;
		if (axis === "y") area.scrollTop += speed;
		else area.scrollLeft += speed;
		update();
		frame = requestAnimationFrame(autoscroll);
	};
	const move = (ev: PointerEvent) => {
		last = pointer(ev, axis);
		if (!live) {
			if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
			const slots = measure(group, axis, from);
			const source = slots.findIndex((s) => s.key === slotKey(list, id));
			if (source < 0) return stop();
			scroll0 = area ? scrollOf(area, axis) : 0;
			session = live = { group, axis, from, el, slots, source, dropping: false, ...place(slots, source, slots[source]!.start, takes) };
			document.documentElement.classList.add("sorting");
			window.getSelection()?.removeAllRanges();
			// Keep getting the pointer if it leaves the window, so letting go out there still drops.
			try {
				el.setPointerCapture(pointerId);
			} catch {}
			notify();
		}
		ev.preventDefault();
		update();
		if (!frame) frame = requestAnimationFrame(autoscroll);
	};
	const cleanup = () => {
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", cancel);
		window.removeEventListener("keydown", key, true);
		window.removeEventListener("dragstart", native, true);
		window.removeEventListener("blur", cancel);
		if (frame) cancelAnimationFrame(frame);
		document.documentElement.classList.remove("sorting");
	};
	const reset = () => void (el.style.transform = "");
	function stop() {
		cleanup();
		reset();
		session = live = undefined;
		notify();
	}
	const up = () => {
		cleanup();
		if (!live) return;
		// The click that ends a drag isn't a click on the row.
		const swallow = (ev: MouseEvent) => (ev.stopPropagation(), ev.preventDefault());
		window.addEventListener("click", swallow, { capture: true, once: true });
		setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
		const done = live;
		const { onto } = done.target;
		session = live = { ...done, dropping: true, ...(onto && { shifts: closed(done) }) };
		notify();
		// Once it has its landing transition, glide into the gap.
		const to = landing(done);
		requestAnimationFrame(() => void (el.style.transform = axis === "y" ? `translate3d(0, ${to}px, 0)` : `translate3d(${to}px, 0, 0)`));
		setTimeout(() => {
			reset();
			session = undefined;
			// The drop and the end of the drag render together, so nothing flickers back.
			if (onto) lists.get(onto.list)?.onDropOn(done.from, onto.id);
			else lists.get(done.target.list)?.onDrop(done.from, done.target.index);
			notify();
		}, 160);
	};
	const cancel = () => stop();
	// Pressing on selected text, a picture or a link would start the browser's own drag, which cancels
	// the pointer and leaves the row where it was: the "sometimes it won't drag".
	const native = (ev: DragEvent) => ev.preventDefault();
	const key = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape" || !live) return;
		ev.stopPropagation();
		stop();
	};
	window.addEventListener("pointermove", move, { passive: false });
	window.addEventListener("pointerup", up);
	window.addEventListener("pointercancel", cancel);
	window.addEventListener("keydown", key, true);
	window.addEventListener("dragstart", native, true);
	window.addEventListener("blur", cancel);
}

/** How far a row slides while another is dragged past it; `.sortable-shift` in styles.css moves it. */
const shiftStyle = (px = 0) => ({ "--sort-shift": `${px}px` }) as React.CSSProperties;

/**
 * A list you can drag rows within, and, in a `group`, between. `onDrop` gets what was dropped (from
 * this list or another in the group) and its index here, counted without it. `accepts` says which rows
 * land in it (all, by default; it can turn down its own, as Drive's files do, kept by name). `holds`
 * says which of its rows take the dragged one into them (`onDropOn`). `data` describes a row of this
 * list to the others, as `from.data`.
 */
export function useDragList({ group, axis = "y", enabled, accepts, holds, data, onDrop, onDropOn }: {
	group?: string;
	axis?: Axis;
	enabled: boolean;
	accepts?: (from: Dragged) => boolean;
	holds?: (id: string, from: Dragged) => boolean;
	data?: (id: string) => unknown;
	onDrop?: (from: Dragged, index: number) => void;
	onDropOn?: (from: Dragged, id: string) => void;
}) {
	const key = useId();
	const g = group ?? key;
	const latest = useRef({ accepts, holds, data, onDrop, onDropOn });
	latest.current = { accepts, holds, data, onDrop, onDropOn };
	// One map for the list's life: the rows' ref callbacks are kept, so they must keep filling the same one.
	const [els] = useState(() => new Map<string, HTMLElement>());
	const entry = useMemo<ListEntry>(() => ({
		group: g,
		axis,
		els,
		enabled,
		accepts: (f) => latest.current.accepts?.(f) ?? true,
		holds: (id, f) => latest.current.holds?.(id, f) ?? false,
		data: (id) => latest.current.data?.(id),
		onDrop: (f, i) => latest.current.onDrop?.(f, i),
		onDropOn: (f, id) => latest.current.onDropOn?.(f, id),
	}), [g, axis, els, enabled]);
	useEffect(() => {
		lists.set(key, entry);
		return () => void lists.delete(key);
	}, [key, entry]);
	const now = useSyncExternalStore(subscribe, snapshot, snapshot);
	const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
	const parts = useCallback(
		(id: string, pickable: boolean) => {
			let ref = refs.current.get(id);
			if (!ref) {
				ref = (el) => (el ? els.set(id, el) : els.delete(id));
				refs.current.set(id, ref);
			}
			const mine = now?.group === g;
			const lifted = mine && now.from.list === key && now.from.id === id;
			return {
				ref,
				lift: lifted ? (now.dropping ? "sortable-landing" : "sortable-lifted") : "",
				shift: mine && !lifted ? { className: `sortable-shift sortable-${axis}`, style: shiftStyle(now.shifts.get(slotKey(key, id))) } : { className: "", style: undefined },
				onPointerDown: enabled && pickable ? (e: React.PointerEvent) => begin(key, id, e.currentTarget as HTMLElement, e) : undefined,
			};
		},
		[els, key, g, axis, enabled, now],
	);
	/** A row's props. `pickable: false`: it can't be picked up (it can't move), but still slides. */
	const item = useCallback((id: string, pickable = true): DragProps => {
		const p = parts(id, pickable);
		return { ref: p.ref, className: p.lift || p.shift.className, style: p.shift.style, onPointerDown: p.onPointerDown };
	}, [parts]);
	/**
	 * For a tree, whose rows sit in their parent's box and are rows of the group too: `box` on the wrapper
	 * (it lifts with everything in it), `row` on the row, which slides on its own, so the rows in a box
	 * that slid don't slide twice.
	 */
	const tree = useCallback((id: string, pickable = true): { box: DragProps; row: DragProps } => {
		const p = parts(id, pickable);
		return { box: { ref: p.ref, className: p.lift }, row: { className: p.shift.className, style: p.shift.style, onPointerDown: p.onPointerDown } };
	}, [parts]);
	/** Whether letting go now would put the dragged row into this one. */
	const onto = useCallback((id: string) => now?.target.onto?.list === key && now.target.onto.id === id, [now, key]);
	return { item, tree, onto, key };
}

/**
 * A divider between lists in a group: it slides with the rows. A drop just before it ends `endOf`; one just
 * after it starts `startOf`, so an empty list still takes rows.
 */
export function useDragStatic(group: string, { endOf, startOf }: { endOf?: string; startOf?: string } = {}) {
	const key = useId();
	const now = useSyncExternalStore(subscribe, snapshot, snapshot);
	const ref = useCallback((el: HTMLElement | null) => void (el ? statics.set(key, { group, el, endOf, startOf }) : statics.delete(key)), [key, group, endOf, startOf]);
	const mine = now?.group === group;
	return { ref, style: mine ? shiftStyle(now.shifts.get(key)) : undefined, className: mine ? `sortable-shift sortable-${now.axis}` : "" };
}

/**
 * A reorderable list saved as an arrangement, optionally belonging to a page or database. Spread
 * `drag(id)` on each row. `group` and `onReceive` let rows come in from other lists in the group;
 * `accepts`, `holds`, `data` and `onDropOn` are `useDragList`'s.
 */
export function useSortable<T>(
	list: ArrangementList,
	items: readonly T[],
	id: (item: T) => string,
	axis: Axis = "y",
	entityId?: string,
	options?: {
		group?: string;
		accepts?: (from: Dragged) => boolean;
		holds?: (id: string, from: Dragged) => boolean;
		data?: (id: string) => unknown;
		onReceive?: (from: Dragged, index: number, shown: string[]) => void;
		onDropOn?: (from: Dragged, id: string) => void;
	},
) {
	const [order, change, writable] = useStoredIds(list, entityId);
	const sorted = useMemo(() => applyOrder(order, items, id), [order, items, id]);
	const shown = useMemo(() => sorted.map(id), [sorted, id]);
	const self = useRef("");
	const { item, tree, onto, key } = useDragList({
		group: options?.group,
		axis,
		enabled: writable,
		accepts: options?.accepts,
		holds: options?.holds,
		data: options?.data,
		onDropOn: options?.onDropOn,
		onDrop: (from, index) => {
			if (from.list !== self.current) return options?.onReceive?.(from, index, shown);
			const command = moveCommand(order, shown, from.id, index);
			if (command) change(command);
		},
	});
	self.current = key;
	return { sorted, drag: item, tree, onto, key };
}
