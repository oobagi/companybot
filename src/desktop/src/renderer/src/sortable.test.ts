// Drag-to-reorder: saved order first, new ids after in their given order, moves land on the right edge.
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { applyCommand, type ArrangementCommand } from "@companybot/core/arrangements";
import { applyOrder, moveCommand, place, useSortable } from "./sortable";

const id = (s: string) => s;

it("puts saved ids first and keeps new ones in their given order after", () => {
	expect(applyOrder(["c", "a"], ["a", "b", "c", "d"], id)).toEqual(["c", "a", "b", "d"]);
	expect(applyOrder(["gone", "b"], ["a", "b"], id)).toEqual(["b", "a"]);
	expect(applyOrder([], ["a", "b"], id)).toEqual(["a", "b"]);
});

it("turns a drop into one move that lands where it looked, saved or not", () => {
	const drop = (saved: string[], shown: string[], from: string, index: number) => {
		const command = moveCommand(saved, shown, from, index);
		return command && applyOrder(applyCommand(saved, command), shown, id);
	};
	expect(drop(["a", "b", "c"], ["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
	expect(drop(["a", "b", "c"], ["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
	expect(drop([], ["a", "b", "c", "d"], "a", 1)).toEqual(["b", "a", "c", "d"]);
	expect(drop(["c"], ["c", "a", "b", "d"], "c", 3)).toEqual(["a", "b", "d", "c"]);
	expect(moveCommand(["a"], ["a", "b"], "b", 1)).toBeUndefined();
});

it("keeps both devices' moves when each is built from the same stale snapshot", () => {
	const snapshot = ["a", "b", "c", "d"];
	const fromA = moveCommand(snapshot, snapshot, "d", 0)!;
	const fromB = moveCommand(snapshot, snapshot, "b", 3)!;
	const server = applyCommand(applyCommand(snapshot, fromA), fromB);
	expect(server.indexOf("d")).toBeLessThan(server.indexOf("a"));
	expect(server.at(-1)).toBe("b");
	expect(applyCommand(applyCommand([], { op: "add", id: "page:1" }), { op: "add", id: "page:2" })).toEqual(["page:1", "page:2"]);
});

// Rows 30px tall, 2px apart; a divider (8px with its margins) between list p and list r.
const row = (list: string, id: string, start: number) => ({ key: `${list}:${id}`, list, id, start, size: 30, pitch: 32 });
const slots = [row("p", "a", 0), row("p", "b", 32), { key: "div", start: 64, size: 1, pitch: 8, endOf: "p" }, row("r", "x", 72), row("r", "y", 104)];
const any = () => true;

it("lands a dragged row once its leading edge passes a row's middle, anywhere along the list", () => {
	// a dragged down past b: lands after b, b slides up a row.
	const down = place(slots, 0, 40, any)!;
	expect(down.target).toMatchObject({ list: "p", index: 1 });
	expect(down.shifts.get("p:b")).toBe(-32);
	// Dragged far past the end, it still lands: at the end of the last list.
	expect(place(slots, 0, 900, any)!.target).toMatchObject({ list: "r", index: 2 });
	// Dragged far above the start: first place.
	expect(place(slots, 4, -900, any)!.target).toMatchObject({ list: "p", index: 0 });
});

it("moves a row between lists in a group, and the divider slides with the rows", () => {
	// y dragged up, its top past the divider but not b's middle: joins p at its end; the divider and x slide down a row.
	const up = place(slots, 4, 50, any)!;
	expect(up.target).toMatchObject({ list: "p", index: 2 });
	expect(up.shifts.get("div")).toBe(32);
	expect(up.shifts.get("r:x")).toBe(32);
	expect(up.shifts.has("p:b")).toBe(false);
	// A list it can't join is skipped for the nearest one it can.
	expect(place(slots, 4, 50, (l) => l !== "p")!.target).toMatchObject({ list: "r", index: 0 });
	// A tall row passes a short one once its leading edge crosses the short one's middle.
	const tall = [{ key: "s:a", list: "s", id: "a", start: 0, size: 30, pitch: 46 }, { key: "s:b", list: "s", id: "b", start: 46, size: 150, pitch: 150 }];
	expect(place(tall, 1, 46 - 32, any)!.target).toMatchObject({ list: "s", index: 0 });
	expect(place(tall, 1, 46 - 30, any)!.target).toMatchObject({ list: "s", index: 1 });
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
	const command = moveCommand(saved.ids, ["a", "b"], "b", 0)!;
	expect(applyCommand(saved.ids, command)).toEqual(["b", "a", "hidden", "unloaded"]);
	let list!: ReturnType<typeof useSortable<string>>;
	const List = () => ((list = useSortable("channels", ["a", "b"], id)), null);
	let root!: ReturnType<typeof create>;
	act(() => { root = create(createElement(List)); });
	expect(list.drag("a").onPointerDown).toBeTypeOf("function");
	saved.writable = false;
	act(() => root.update(createElement(List)));
	expect(list.drag("a").onPointerDown).toBeUndefined();
	act(() => root.unmount());
	vi.unstubAllGlobals();
});

it("drops into an empty list just after the divider that starts it", () => {
	// Pins a and b, then the recents divider with no recents under it.
	const pinsOnly = [row("p", "a", 0), row("p", "b", 32), { key: "div", start: 64, size: 1, pitch: 8, endOf: "p", startOf: "r" }];
	expect(place(pinsOnly, 1, 60, any)!.target).toMatchObject({ list: "r", index: 0 });
	// No pins: a recent dragged above the pins divider lands as the first pin.
	const recentsOnly = [{ key: "top", start: 0, size: 1, pitch: 8, startOf: "p" }, { key: "div", start: 8, size: 1, pitch: 8, endOf: "p", startOf: "r" }, row("r", "x", 16)];
	expect(place(recentsOnly, 2, -20, any)!.target).toMatchObject({ list: "p", index: 0 });
});
