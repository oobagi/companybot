// Drag-to-reorder: saved order first, new ids after in their given order, moves land on the right edge.
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { applyOrder, moveId, useSortable } from "./sortable";

const id = (s: string) => s;

it("puts saved ids first and keeps new ones in their given order after", () => {
	expect(applyOrder(["c", "a"], ["a", "b", "c", "d"], id)).toEqual(["c", "a", "b", "d"]);
	expect(applyOrder(["gone", "b"], ["a", "b"], id)).toEqual(["b", "a"]);
	expect(applyOrder([], ["a", "b"], id)).toEqual(["a", "b"]);
});

it("moves an id before or after another", () => {
	expect(moveId(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
	expect(moveId(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
	expect(moveId(["a", "b", "c"], "b", "b", "after")).toEqual(["a", "b", "c"]);
	expect(moveId(["a", "b"], "a", "missing", "before")).toEqual(["a", "b"]);
});

const saved = vi.hoisted(() => ({ ids: [] as string[], writable: true, writes: 0 }));
vi.mock("./arrangements", () => ({ useStoredIds: () => [saved.ids, (next: (ids: string[]) => string[]) => { saved.ids = next(saved.ids); saved.writes++; }, saved.writable] }));

it("keeps unseen shared rows when dragging visible ones and disables forbidden drags", () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	saved.ids = ["a", "hidden", "b", "unloaded"];
	saved.writable = true;
	saved.writes = 0;
	let list!: ReturnType<typeof useSortable<string>>;
	const List = () => ((list = useSortable("channels", ["a", "b"], id)), null);
	let root!: ReturnType<typeof create>;
	act(() => { root = create(createElement(List)); });
	const event = { stopPropagation: vi.fn(), preventDefault: vi.fn(), clientY: 0, dataTransfer: { setData: vi.fn() }, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) } } as unknown as React.DragEvent;
	act(() => list.drag("b").onDragStart(event));
	act(() => list.drag("a").onDragOver(event));
	act(() => list.drag("a").onDrop(event));
	expect(saved.ids).toEqual(["b", "a", "hidden", "unloaded"]);
	expect(saved.writes).toBe(1);
	saved.writable = false;
	act(() => root.update(createElement(List)));
	expect(list.drag("a").draggable).toBe(false);
	act(() => { list.drag("a").onDragStart(event); list.drag("b").onDrop(event); });
	expect(saved.writes).toBe(1);
	act(() => root.unmount());
	vi.unstubAllGlobals();
});
