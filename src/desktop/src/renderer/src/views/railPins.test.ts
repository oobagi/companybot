import { describe, expect, it } from "vitest";
import type { PinKey } from "../pins";
import { steadyOrder } from "./RailPins";

const k = (...ids: string[]) => ids.map((id) => `page:${id}` as PinKey);

describe("steadyOrder", () => {
	it("starts in the saved order", () => {
		expect(steadyOrder("w1", k("a", "b", "c"))).toEqual(k("a", "b", "c"));
	});

	it("keeps a recent in place when it's opened again", () => {
		steadyOrder("w2", k("a", "b", "c"));
		// Opening c makes it the latest in the saved list.
		expect(steadyOrder("w2", k("c", "a", "b"))).toEqual(k("a", "b", "c"));
	});

	it("brings a new one in at the top and drops what left the list", () => {
		steadyOrder("w3", k("a", "b", "c"));
		expect(steadyOrder("w3", k("d", "a", "b"))).toEqual(k("d", "a", "b"));
	});

	it("gives the same answer when asked twice", () => {
		steadyOrder("w4", k("a", "b"));
		const once = steadyOrder("w4", k("c", "b", "a"));
		expect(steadyOrder("w4", k("c", "b", "a"))).toEqual(once);
	});

	it("keeps each workspace's order apart", () => {
		steadyOrder("w5", k("a", "b"));
		expect(steadyOrder("w6", k("b", "a"))).toEqual(k("b", "a"));
	});
});
