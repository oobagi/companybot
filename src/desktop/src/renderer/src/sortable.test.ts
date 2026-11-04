// Drag-to-reorder: saved order first, new ids after in their given order, moves land on the right edge.
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { applyCommand, type ArrangementCommand } from "@companybot/core/arrangements";
import { applyOrder, moveCommand, useSortable } from "./sortable";

const id = (s: string) => s;

it("puts saved ids first and keeps new ones in their given order after", () => {
	expect(applyOrder(["c", "a"], ["a", "b", "c", "d"], id)).toEqual(["c", "a", "b", "d"]);
	expect(applyOrder(["gone", "b"], ["a", "b"], id)).toEqual(["b", "a"]);
	expect(applyOrder([], ["a", "b"], id)).toEqual(["a", "b"]);
});

it("turns a drop into one move that lands where it looked, saved or not", () => {
	const drop = (saved: string[], shown: string[], from: string, to: string, edge: "before" | "after") => {
		const command = moveCommand(saved, shown, from, to, edge);
		return command && applyOrder(applyCommand(saved, command), shown, id);
	};
	expect(drop(["a", "b", "c"], ["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
	expect(drop(["a", "b", "c"], ["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
	expect(drop([], ["a", "b", "c", "d"], "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
	expect(drop(["c"], ["c", "a", "b", "d"], "c", "d", "after")).toEqual(["a", "b", "d", "c"]);
	expect(moveCommand(["a"], ["a", "b"], "b", "b", "after")).toBeUndefined();
	expect(moveCommand(["a"], ["a", "b"], "a", "missing", "before")).toBeUndefined();
});

it("keeps both devices' moves when each is built from the same stale snapshot", () => {
	const snapshot = ["a", "b", "c", "d"];
	const fromA = moveCommand(snapshot, snapshot, "d", "a", "before")!;
	const fromB = moveCommand(snapshot, snapshot, "b", "d", "after")!;
	const server = applyCommand(applyCommand(snapshot, fromA), fromB);
	expect(server.indexOf("d")).toBeLessThan(server.indexOf("a"));
	expect(server.at(-1)).toBe("b");
	expect(applyCommand(applyCommand([], { op: "add", id: "page:1" }), { op: "add", id: "page:2" })).toEqual(["page:1", "page:2"]);
});

const saved = vi.hoisted(() => ({ ids: [] as string[], writable: true, writes: 0 }));
vi.mock("./arrangements", async () => {
	const { applyCommand } = await import("@companybot/core/arrangements");
	return { useStoredIds: () => [saved.ids, (command: ArrangementCommand) => { saved.ids = applyCommand(saved.ids, command); saved.writes++; }, saved.writable] };
});

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
