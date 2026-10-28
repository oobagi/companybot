// Drag-to-reorder: saved order first, new ids after in their given order, moves land on the right edge.
import { expect, it } from "vitest";
import { applyOrder, moveId } from "./sortable";

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
