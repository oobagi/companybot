// Drag-to-reorder: saved order first, new ids after in their given order, moves land on the right edge.
import { expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { applyCommand, type ArrangementCommand } from "@companybot/core/arrangements";
import { applyOrder, arrange, moveCommand, place, useSortable } from "./sortable";

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
const row = (list: string, id: string, start: number) => ({ key: `${list}:${id}`, list, id, start, size: 30, gap: 2, pitch: 32 });
const slots = [row("p", "a", 0), row("p", "b", 32), { key: "div", start: 64, size: 1, gap: 7, pitch: 8, endOf: "p" }, row("r", "x", 72), row("r", "y", 104)];
const any = () => true;
/** The pointer: `along` the axis, and `across` it (left of every level, unless given). */
const p = (along: number, across = 0) => ({ along, across });

it("lands a dragged row once its leading edge passes a row's middle, anywhere along the list", () => {
	// a dragged down past b: lands after b, b slides up a row.
	const down = place(slots, 0, 40, p(55), any)!;
	expect(down.target).toMatchObject({ list: "p", index: 1 });
	expect(down.shifts.get("p:b")).toBe(-32);
	// Dragged far past the end, it still lands: at the end of the last list.
	expect(place(slots, 0, 900, p(915), any)!.target).toMatchObject({ list: "r", index: 2 });
	// Dragged far above the start: first place.
	expect(place(slots, 4, -900, p(-885), any)!.target).toMatchObject({ list: "p", index: 0 });
});

it("moves a row between lists in a group, and the divider slides with the rows", () => {
	// y dragged up, its top past the divider but not b's middle: joins p at its end; the divider and x slide down a row.
	const up = place(slots, 4, 50, p(65), any)!;
	expect(up.target).toMatchObject({ list: "p", index: 2 });
	expect(up.shifts.get("div")).toBe(32);
	expect(up.shifts.get("r:x")).toBe(32);
	expect(up.shifts.has("p:b")).toBe(false);
	// A list it can't join is skipped for the nearest one it can.
	expect(place(slots, 4, 50, p(65), (l) => l !== "p")!.target).toMatchObject({ list: "r", index: 0 });
	// A tall row passes a short one once its leading edge crosses the short one's middle.
	const tall = [{ key: "s:a", list: "s", id: "a", start: 0, size: 30, gap: 16, pitch: 46 }, { key: "s:b", list: "s", id: "b", start: 46, size: 150, gap: 16, pitch: 166 }];
	expect(place(tall, 1, 46 - 32, p(46 - 32 + 75), any)!.target).toMatchObject({ list: "s", index: 0 });
	expect(place(tall, 1, 46 - 30, p(46 - 30 + 75), any)!.target).toMatchObject({ list: "s", index: 1 });
});

// A tree: X, then folder F open with c1 and c2 in its box (list f), then Y. Rows 30px tall, 2px apart.
const tree = [
	{ key: "t:X", list: "t", id: "X", start: 0, size: 30, gap: 2 },
	{ key: "t:F", list: "t", id: "F", start: 32, size: 94, gap: 2 },
	{ key: "f:c1", list: "f", id: "c1", start: 64, size: 30, gap: 2, parent: "t:F" },
	{ key: "f:c2", list: "f", id: "c2", start: 96, size: 30, gap: 2, parent: "t:F" },
	{ key: "t:Y", list: "t", id: "Y", start: 128, size: 30, gap: 2 },
];

it("counts an open folder as its own row, and a dragged folder carries the rows in its box", () => {
	const open = arrange(tree, "t:X");
	expect(open.find((s) => s.id === "F")).toMatchObject({ size: 32, pitch: 32 });
	expect(open.find((s) => s.id === "c2")).toMatchObject({ size: 30, pitch: 32 });
	const lifted = arrange(tree, "t:F");
	expect(lifted.map((s) => s.id)).toEqual(["X", "F", "Y"]);
	expect(lifted[1]).toMatchObject({ size: 94, pitch: 96 });
	// Dragged past Y, it slides Y up by its whole box, and its own rows aren't anywhere to drop into.
	const down = place(lifted, 1, 60, p(75), any);
	expect(down.target).toMatchObject({ list: "t", index: 2 });
	expect(down.shifts.get("t:Y")).toBe(-96);
});

it("drops between a folder's rows, out after it, and slides each row once", () => {
	const slots = arrange(tree, "t:X");
	// Just past F's row: F's first row.
	expect(place(slots, 0, 30, p(45), any).target).toMatchObject({ list: "f", index: 0 });
	// Past F's last row: after F, a level up, since the end of F is a drop onto F away; unless only F's rows take it.
	const out = place(slots, 0, 90, p(105), any);
	expect(out.target).toMatchObject({ list: "t", index: 1 });
	expect(place(slots, 0, 90, p(105), (l) => l === "f").target).toMatchObject({ list: "f", index: 2 });
	// F's row and the rows in its box each slide on their own, one row each, not twice.
	expect([...out.shifts.values()]).toEqual([-32, -32, -32]);
	// Y dragged up between c1 and c2: into F; only c2 slides, F (whose box holds it) doesn't.
	const up = place(arrange(tree, "t:Y"), 4, 90, p(105), any);
	expect(up.target).toMatchObject({ list: "f", index: 1 });
	expect([...up.shifts]).toEqual([["f:c2", 32]]);
	// c2, F's last row, with nothing below the tree: pulled down it stays F's last (the pointer's x takes it out: below).
	const last = arrange(tree.slice(0, 4), "f:c2");
	expect(place(last, 3, 96 + 20, p(96 + 35), any).target).toMatchObject({ list: "f", index: 1 });
	// c1 dragged out above F: F's row slides down, c2 stays where it was.
	const above = place(arrange(tree, "f:c1"), 2, 30, p(45), any);
	expect(above.target).toMatchObject({ list: "t", index: 1 });
	expect([...above.shifts]).toEqual([["t:F", 32]]);
});

it("drops onto a row that takes it over its middle half, and passes it beyond", () => {
	// Rows 30px, 2px apart; F takes the dragged row in. The pointer holds X by its middle.
	const rows = [row("t", "X", 0), { ...row("t", "F", 32), holds: true }, row("t", "Y", 64)];
	const over = place(rows, 0, 32, p(47), any);
	expect(over.target.onto).toEqual({ list: "t", id: "F" });
	expect(over.shifts.size).toBe(0);
	// Past F's far quarter it's a gap again, after F.
	const past = place(rows, 0, 45, p(60), any);
	expect(past.target).toMatchObject({ list: "t", index: 1 });
	expect(past.target.onto).toBeUndefined();
	// From below too.
	expect(place(rows, 2, 32, p(47), any).target.onto).toEqual({ list: "t", id: "F" });
	// A row whose list takes nothing (a file, kept by name) slides nothing and can still go onto F.
	expect(place(rows, 0, 70, p(85), () => false)).toMatchObject({ target: { list: "t", index: 0, at: 0 }, shifts: new Map() });
	expect(place(rows, 0, 32, p(47), () => false).target.onto).toEqual({ list: "t", id: "F" });
});

it("in a tree, steps left out of a folder and right to stay in it, and goes into a row over its middle", () => {
	// F's rows start 28px further in than the top level's.
	const deep = tree.map((s) => ({ ...s, left: 0, inset: s.list === "f" ? 28 : 0 }));
	const slots = arrange(deep, "t:X");
	// X dragged below c2: at the end of F's rows with the pointer right of where they start; after F, a level up, with it left of them.
	expect(place(slots, 0, 100, p(115, 60), any).target).toMatchObject({ list: "f", index: 2, inset: 28 });
	expect(place(slots, 0, 100, p(115, 10), any).target).toMatchObject({ list: "t", index: 1, inset: 0 });
	// Over F's middle half, when F takes it: into F; near its top edge it's the gap before F, where X already is.
	const holding = slots.map((s) => (s.id === "F" ? { ...s, holds: true } : s));
	expect(place(holding, 0, 16, p(48, 60), any).target.onto).toEqual({ list: "t", id: "F" });
	const edge = place(holding, 0, 4, p(36, 60), any).target;
	expect(edge).toMatchObject({ list: "t", index: 0, at: 0 });
	expect(edge.onto).toBeUndefined();
	// c2, F's last row, over its own place: it stays, unless the pointer is left of F's rows, which puts it after F.
	const last = arrange(deep, "f:c2");
	expect(place(last, 3, 96, p(111, 60), any).target).toMatchObject({ list: "f", index: 1, at: 3, inset: 28 });
	expect(place(last, 3, 96, p(111, 10), any).target).toMatchObject({ list: "t", index: 2, at: 3, inset: 0 });
});

it("slides the others by the dragged row's own room, its size and its list's gap, not the space to the next list", () => {
	// One channel, then (rows of another group between) a section's header and row, far below. The channel's gap is 1px.
	const chat = arrange([{ key: "c:a", list: "c", id: "a", start: 0, size: 30, gap: 1 }, { key: "s", start: 130, size: 24, gap: 1, startOf: "s", endOf: "c" }, { key: "s:x", list: "s", id: "x", start: 155, size: 30, gap: 1 }, { key: "s:y", list: "s", id: "y", start: 186, size: 30, gap: 1 }], "c:a");
	expect(chat[0]).toMatchObject({ pitch: 31 });
	const down = place(chat, 0, 160, p(175), any);
	expect(down.target).toMatchObject({ list: "s", index: 1 });
	expect([...down.shifts]).toEqual([["s", -31], ["s:x", -31]]);
	// The last channel goes with its list's box (measured with the gap around it): the section's rows past
	// where it lands make up the difference, since it takes less room among them than it left.
	const alone = arrange([{ key: "c:a", list: "c", id: "a", start: 0, size: 30, gap: 16 }, ...chat.slice(1)], "c:a");
	const lastOne = place(alone, 0, 160, p(175), any);
	expect([...lastOne.shifts]).toEqual([["s", -46], ["s:x", -46], ["s:y", -15]]);
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
	const pinsOnly = [row("p", "a", 0), row("p", "b", 32), { key: "div", start: 64, size: 1, gap: 7, pitch: 8, endOf: "p", startOf: "r" }];
	expect(place(pinsOnly, 1, 60, p(75), any)!.target).toMatchObject({ list: "r", index: 0 });
	// No pins: a recent dragged above the pins divider lands as the first pin.
	const recentsOnly = [{ key: "top", start: 0, size: 1, gap: 7, pitch: 8, startOf: "p" }, { key: "div", start: 8, size: 1, gap: 7, pitch: 8, endOf: "p", startOf: "r" }, row("r", "x", 16)];
	expect(place(recentsOnly, 2, -20, p(-5), any)!.target).toMatchObject({ list: "p", index: 0 });
});
