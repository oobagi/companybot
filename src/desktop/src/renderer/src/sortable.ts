import { useCallback, useMemo, useState } from "react";
import { storedIds, useStored } from "./ui";

// Drag to reorder: sidebar sections and rows, the workspace rail, database view tabs.
// Each list's order is yours and stays on this computer (localStorage), like the sidebar's
// hidden state. Ids not in the saved order (new ones) go at the end in their given order.

type Edge = "before" | "after";

/** Spread on a list item. `className` draws the drop line, so the item needs `relative`. */
export type DragProps = {
	draggable: boolean;
	className: string;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragLeave: (e: React.DragEvent) => void;
	onDrop: (e: React.DragEvent) => void;
	onDragEnd: () => void;
};

/** What's being dragged, by list. dragover can't read dataTransfer, so it's kept here. */
let dragging: { list: string; id: string } | undefined;

/** A list of ids kept on this computer under `key`. */
export const useStoredIds = (key: string) => useStored(key, storedIds);

/** `items` in the saved order; unsaved ones keep their place relative to each other, after the saved ones. */
export function applyOrder<T>(order: readonly string[], items: readonly T[], id: (item: T) => string): T[] {
	const rank = new Map(order.map((k, i) => [k, i]));
	return items
		.map((item, i) => ({ item, i, r: rank.get(id(item)) ?? order.length + i }))
		.sort((a, b) => a.r - b.r)
		.map((x) => x.item);
}

/** Moves `from` to just before or after `to`. */
export function moveId(ids: readonly string[], from: string, to: string, edge: Edge): string[] {
	if (from === to) return [...ids];
	const rest = ids.filter((k) => k !== from);
	const at = rest.indexOf(to);
	if (at < 0) return [...ids];
	rest.splice(edge === "before" ? at : at + 1, 0, from);
	return rest;
}

/**
 * A reorderable list saved under `key`. Spread `drag(id)` on each item; it needs `relative`
 * for the drop line. Lists are kept apart, so a row dragged over its section header does nothing.
 */
export function useSortable<T>(key: string, items: readonly T[], id: (item: T) => string, axis: "y" | "x" = "y") {
	const [order, setOrder] = useStoredIds(key);
	const [over, setOver] = useState<{ id: string; edge: Edge }>();
	const sorted = useMemo(() => applyOrder(order, items, id), [order, items, id]);

	const drop = useCallback(
		(to: string, edge: Edge) => {
			const from = dragging?.list === key ? dragging.id : undefined;
			if (!from) return;
			setOrder(moveId(sorted.map(id), from, to, edge));
		},
		[key, sorted, id, setOrder],
	);

	const drag = (itemId: string): DragProps => {
		const edge = over?.id === itemId ? over.edge : undefined;
		return {
			draggable: true,
			className: edge ? lines[axis][edge] : "",
			onDragStart: (e: React.DragEvent) => {
				e.stopPropagation();
				dragging = { list: key, id: itemId };
				e.dataTransfer.effectAllowed = "move";
				// Something must be set for the drag to start in every browser.
				e.dataTransfer.setData("text/plain", "");
			},
			onDragOver: (e: React.DragEvent) => {
				if (dragging?.list !== key) return;
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = "move";
				const box = e.currentTarget.getBoundingClientRect();
				const after = axis === "y" ? e.clientY > box.top + box.height / 2 : e.clientX > box.left + box.width / 2;
				const next: Edge = after ? "after" : "before";
				if (over?.id !== itemId || over.edge !== next) setOver({ id: itemId, edge: next });
			},
			onDragLeave: (e: React.DragEvent) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.id === itemId ? undefined : o));
			},
			onDrop: (e: React.DragEvent) => {
				if (dragging?.list !== key) return;
				e.preventDefault();
				e.stopPropagation();
				if (edge) drop(itemId, edge);
				setOver(undefined);
			},
			onDragEnd: () => {
				dragging = undefined;
				setOver(undefined);
			},
		};
	};

	return { sorted, drag };
}

/** The line showing where a drop lands. */
const lines = {
	y: {
		before: "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:rounded-full before:bg-sky-500",
		after: "before:absolute before:inset-x-1 before:-bottom-px before:h-0.5 before:rounded-full before:bg-sky-500",
	},
	x: {
		before: "before:absolute before:inset-y-1 before:-left-px before:w-0.5 before:rounded-full before:bg-sky-500",
		after: "before:absolute before:inset-y-1 before:-right-px before:w-0.5 before:rounded-full before:bg-sky-500",
	},
};
