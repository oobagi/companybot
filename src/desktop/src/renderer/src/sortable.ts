import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { useStoredIds } from "./arrangements";
import type { ArrangementCommand, ArrangementList } from "@companybot/core/arrangements";

// Drag to reorder, with the pointer (not the browser's drag-and-drop, which drags a picture of the
// row and drops only on an exact line). Press and move a few pixels to pick a row up; it follows the
// pointer along the list while the others slide out of its way; let go anywhere and it lands in the
// gap that's open. Escape puts it back. Lists in one `group` (the rail's pins and recents) take
// rows from each other.

type Axis = "x" | "y";

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

type ListEntry = { group: string; axis: Axis; els: Map<string, HTMLElement>; enabled: boolean; onDrop: (from: { list: string; id: string }, index: number) => void };
type StaticEntry = { group: string; el: HTMLElement; endOf?: string; startOf?: string };
const lists = new Map<string, ListEntry>();
const statics = new Map<string, StaticEntry>();

/** One thing in the group, in order along the axis: a row, or a divider between lists. */
type Slot = { key: string; list?: string; id?: string; start: number; size: number; pitch: number; endOf?: string; startOf?: string };
type Session = {
	group: string;
	axis: Axis;
	from: { list: string; id: string };
	el: HTMLElement;
	slots: Slot[];
	source: number;
	/** Where it'd land: a list and an index in it (without the dragged row). */
	target: { list: string; index: number; at: number };
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

function measure(group: string, axis: Axis): Slot[] {
	const raw: Omit<Slot, "pitch">[] = [];
	for (const [list, l] of lists) {
		if (l.group !== group) continue;
		for (const [id, el] of l.els) {
			if (!el.isConnected) continue;
			const r = el.getBoundingClientRect();
			raw.push({ key: slotKey(list, id), list, id, start: start(r, axis), size: extent(r, axis) });
		}
	}
	for (const [key, s] of statics) {
		if (s.group !== group || !s.el.isConnected) continue;
		const r = s.el.getBoundingClientRect();
		raw.push({ key, start: start(r, axis), size: extent(r, axis), endOf: s.endOf, startOf: s.startOf });
	}
	raw.sort((a, b) => a.start - b.start);
	// A slot's pitch: from its start to the next one's, so gaps and margins move with it.
	return raw.map((s, i) => {
		const next = raw[i + 1];
		const prev = raw[i - 1];
		const gap = next ? next.start - (s.start + s.size) : prev ? s.start - (prev.start + prev.size) : 0;
		return { ...s, pitch: s.size + Math.max(0, gap) };
	});
}

/** Where a row whose leading edge is at `edge` lands, and how everything else slides to make room. */
export function place(slots: readonly Slot[], source: number, edge: number, enabled: (list: string) => boolean): Pick<Session, "target" | "shifts"> | undefined {
	const dragged = slots[source]!;
	const others = slots.filter((_, i) => i !== source);
	const center = edge + dragged.size / 2;
	// The gap it's over: before the first thing whose middle is past its middle.
	let at = others.findIndex((s) => s.start + s.size / 2 > center);
	if (at < 0) at = others.length;
	const list = (gap: number): { list: string; index: number } | undefined => {
		const prev = others[gap - 1];
		const next = others[gap];
		if (prev?.list) return { list: prev.list, index: others.slice(0, gap).filter((s) => s.list === prev.list).length };
		// Just after a divider that starts a list: its top, even while that list is empty.
		if (prev?.startOf) return { list: prev.startOf, index: 0 };
		if (next?.endOf) return { list: next.endOf, index: others.slice(0, gap).filter((s) => s.list === next.endOf).length };
		if (next?.list) return { list: next.list, index: 0 };
		return undefined;
	};
	// Gaps a row can't go into (a list it can't join) fall back to the nearest one it can.
	let found: ({ list: string; index: number; at: number }) | undefined;
	for (let d = 0; d <= others.length && !found; d++) {
		for (const g of [at - d, at + d]) {
			if (g < 0 || g > others.length) continue;
			const t = list(g);
			if (t && enabled(t.list)) { found = { ...t, at: g }; break; }
		}
	}
	if (!found) return undefined;
	const target = found;
	const shifts = new Map<string, number>();
	// Everything between where it was and where it goes slides one row's worth toward where it was.
	others.forEach((s, i) => {
		const was = i < source ? i : i + 1;
		if (target.at <= i && was < source) shifts.set(s.key, dragged.pitch);
		else if (i < target.at && was > source) shifts.set(s.key, -dragged.pitch);
	});
	return { target, shifts };
}

/** How far the dragged row moves to sit in its gap. */
function landing(s: Session): number {
	const others = s.slots.filter((_, i) => i !== s.source);
	const dragged = s.slots[s.source]!;
	const { at } = s.target;
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
	if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
	const { axis, group } = l;
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
		const next = place(live.slots, live.source, dragged.start + d, (k) => lists.get(k)?.enabled ?? false);
		el.style.transform = axis === "y" ? `translate3d(0, ${d}px, 0) scale(1.03)` : `translate3d(${d}px, 0, 0) scale(1.03)`;
		if (next && (next.target.at !== live.target.at || next.target.list !== live.target.list)) {
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
			const slots = measure(group, axis);
			const source = slots.findIndex((s) => s.key === slotKey(list, id));
			if (source < 0) return stop();
			scroll0 = area ? scrollOf(area, axis) : 0;
			const placed = place(slots, source, slots[source]!.start, (k) => lists.get(k)?.enabled ?? false);
			if (!placed) return stop();
			session = live = { group, axis, from: { list, id }, el, slots, source, dropping: false, ...placed };
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
		session = live = { ...done, dropping: true };
		notify();
		// Once it has its landing transition, glide into the gap.
		const to = landing(done);
		requestAnimationFrame(() => void (el.style.transform = axis === "y" ? `translate3d(0, ${to}px, 0)` : `translate3d(${to}px, 0, 0)`));
		setTimeout(() => {
			const target = lists.get(done.target.list);
			reset();
			session = undefined;
			// The drop and the end of the drag render together, so nothing flickers back.
			target?.onDrop(done.from, done.target.index);
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
 * this list or another in the group) and its index here, counted without it.
 */
export function useDragList({ group, axis = "y", enabled, onDrop }: { group?: string; axis?: Axis; enabled: boolean; onDrop: (from: { list: string; id: string }, index: number) => void }) {
	const key = useId();
	const g = group ?? key;
	const drop = useRef(onDrop);
	drop.current = onDrop;
	const entry = useMemo<ListEntry>(() => ({ group: g, axis, els: new Map(), enabled, onDrop: (f, i) => drop.current(f, i) }), [g, axis, enabled]);
	useEffect(() => {
		lists.set(key, entry);
		return () => void lists.delete(key);
	}, [key, entry]);
	const now = useSyncExternalStore(subscribe, snapshot, snapshot);
	const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
	const item = useCallback(
		(id: string): DragProps => {
			let ref = refs.current.get(id);
			if (!ref) {
				ref = (el) => (el ? entry.els.set(id, el) : entry.els.delete(id));
				refs.current.set(id, ref);
			}
			const mine = now?.group === g;
			const lifted = mine && now.from.list === key && now.from.id === id;
			const shift = mine && !lifted ? now.shifts.get(slotKey(key, id)) : undefined;
			return {
				ref,
				className: lifted ? (now.dropping ? "sortable-landing" : "sortable-lifted") : mine ? `sortable-shift sortable-${axis}` : "",
				style: mine && !lifted ? shiftStyle(shift) : undefined,
				onPointerDown: enabled ? (e) => begin(key, id, e.currentTarget as HTMLElement, e) : undefined,
			};
		},
		[entry, key, g, axis, enabled, now],
	);
	return { item, key };
}

/**
 * A divider between lists in a group: it slides with the rows. A drop just before it ends `endOf`; one just
 * after it starts `startOf`, so an empty list still takes rows.
 */
export function useDragStatic(group: string, { endOf, startOf }: { endOf?: string; startOf?: string } = {}) {
	const key = useId();
	const now = useSyncExternalStore(subscribe, snapshot, snapshot);
	const ref = useCallback((el: HTMLElement | null) => (el ? statics.set(key, { group, el, endOf, startOf }) : statics.delete(key)), [key, group, endOf, startOf]);
	const mine = now?.group === group;
	return { ref, style: mine ? shiftStyle(now.shifts.get(key)) : undefined, className: mine ? `sortable-shift sortable-${now.axis}` : "" };
}

/**
 * A reorderable list saved as an arrangement, optionally belonging to a page or database. Spread
 * `drag(id)` on each row. `group` and `onReceive` let rows come in from other lists in the group.
 */
export function useSortable<T>(
	list: ArrangementList,
	items: readonly T[],
	id: (item: T) => string,
	axis: Axis = "y",
	entityId?: string,
	options?: { group?: string; onReceive?: (from: { list: string; id: string }, index: number, shown: string[]) => void },
) {
	const [order, change, writable] = useStoredIds(list, entityId);
	const sorted = useMemo(() => applyOrder(order, items, id), [order, items, id]);
	const shown = useMemo(() => sorted.map(id), [sorted, id]);
	const self = useRef("");
	const { item, key } = useDragList({
		group: options?.group,
		axis,
		enabled: writable,
		onDrop: (from, index) => {
			if (from.list !== self.current) return options?.onReceive?.(from, index, shown);
			const command = moveCommand(order, shown, from.id, index);
			if (command) change(command);
		},
	});
	self.current = key;
	return { sorted, drag: item, key };
}
