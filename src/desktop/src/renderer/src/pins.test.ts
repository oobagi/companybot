// Pins and recents: which screens can be pinned, where a pin opens, and one store every reader shares.
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { pathOf, pinOf, usePins } from "./pins";

vi.mock("./convex", () => ({ useWorkspace: () => ({ id: "w1" }) }));

const store = new Map<string, string>();
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	store.clear();
	vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
});

it("knows which screens are pinnable and where each pin opens", () => {
	expect(pinOf(["chat", "c1"])).toBe("chat:c1");
	expect(pinOf(["pages", "p1"])).toBe("page:p1");
	expect(pinOf(["records", "client", "r1"])).toBe("db:client");
	expect(pinOf(["chat"])).toBeUndefined();
	expect(pinOf(["settings", "agents"])).toBeUndefined();
	expect(pathOf("chat:c1")).toEqual(["chat", "c1"]);
	expect(pathOf("page:p1")).toEqual(["pages", "p1"]);
	expect(pathOf("db:client")).toEqual(["records", "client"]);
});

it("shares pins and recents between readers, and keeps recents newest first without repeats", () => {
	let a!: ReturnType<typeof usePins>;
	let b!: ReturnType<typeof usePins>;
	const A = () => ((a = usePins()), null);
	const B = () => ((b = usePins()), null);
	act(() => void create(createElement("div", null, createElement(A), createElement(B))));

	act(() => a.toggle("page:p1"));
	expect(b.pins).toEqual(["page:p1"]);
	expect(JSON.parse(store.get("rail.pins:w1")!)).toEqual(["page:p1"]);
	act(() => b.toggle("page:p1"));
	expect(a.pins).toEqual([]);

	act(() => (a.visit("chat:c1"), a.visit("page:p1"), a.visit("chat:c1")));
	expect(b.recent).toEqual(["chat:c1", "page:p1"]);
});
