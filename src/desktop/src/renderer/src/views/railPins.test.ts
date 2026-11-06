import { describe, expect, it } from "vitest";
import type { PinKey } from "../pins";
import { steadyOrder } from "./RailPins";

const k = (...ids: string[]) => ids.map((id) => `page:${id}` as PinKey);

describe("steadyOrder", () => {
	it("starts in the saved order", () => {
		expect(steadyOrder([], k("a", "b", "c"))).toEqual(k("a", "b", "c"));
	});

	it("keeps a recent in place when it's opened again", () => {
		// Opening c makes it the latest in the saved list.
		expect(steadyOrder(k("a", "b", "c"), k("c", "a", "b"))).toEqual(k("a", "b", "c"));
	});

	it("brings a new one in at the top and drops what left the list", () => {
		expect(steadyOrder(k("a", "b", "c"), k("d", "a", "b"))).toEqual(k("d", "a", "b"));
	});

	it("changes nothing it's given", () => {
		const before = k("a", "b", "c");
		steadyOrder(before, k("d", "a", "b"));
		expect(before).toEqual(k("a", "b", "c"));
	});
});
