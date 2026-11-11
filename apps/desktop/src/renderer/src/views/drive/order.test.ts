import { expect, it } from "vitest";
import { foldersFirst } from "./order";

const isFolder = (row: string) => row.startsWith("F");

it("puts the folders first, each group keeping its order", () => {
	expect(foldersFirst(["a", "F1", "b", "F2", "c"], isFolder)).toEqual(["F1", "F2", "a", "b", "c"]);
	expect(foldersFirst(["a", "b"], isFolder)).toEqual(["a", "b"]);
	expect(foldersFirst(["F1", "F2"], isFolder)).toEqual(["F1", "F2"]);
	expect(foldersFirst([], isFolder)).toEqual([]);
});
