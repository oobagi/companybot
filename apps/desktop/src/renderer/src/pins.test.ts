// Pins and recents: which screens can be pinned, where a pin opens, and one store every reader shares.
import { act, createElement, useSyncExternalStore } from "react";
import { type ReactTestRenderer, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pathOf, pinOf, usePins } from "./pins";
import { ArrangementProvider, useArrangementState } from "./arrangements";
import { Notice } from "./ui";
import type { Arrangement } from "@companybot/core/arrangements";

const live = vi.hoisted(() => ({ data: { rows: [] as Arrangement[], sections: [], writable: true }, listeners: new Set<() => void>(), reject: false }));
vi.mock("./convex", async () => {
	const { useCallback } = await import("react");
	return {
		useMutation: (_fn: unknown, optimistic: () => (cache: unknown, args: unknown) => void) => useCallback(async (args: { list: string; command: unknown }) => {
			if (live.reject) throw Error("Could not save pins");
			optimistic()({
				getAllQueries: () => [{ args: { workspaceId: "w1" }, value: live.data }],
				setQuery: (_fn: unknown, _args: unknown, value: typeof live.data) => { live.data = value; },
			}, { ...args, workspaceId: "w1" });
			for (const listener of live.listeners) listener();
		}, [optimistic]),
	};
});
function Harness({ children }: { children: React.ReactNode }) {
	const data = useSyncExternalStore((l) => (live.listeners.add(l), () => { live.listeners.delete(l); }), () => live.data);
	return createElement(ArrangementProvider, { data, children });
}
function Errors() { return createElement(Notice, null, useArrangementState()?.error); }
let root: ReactTestRenderer;
afterEach(() => { act(() => root?.unmount()); });

const store = new Map<string, string>();
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	store.clear();
	live.data = { rows: [], sections: [], writable: true };
	live.reject = false;
	vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
});

it("knows which screens are pinnable and where each pin opens", () => {
	expect(pinOf(["chat", "c1"])).toBe("chat:c1");
	expect(pinOf(["pages", "p1"])).toBe("page:p1");
	expect(pinOf(["records", "client", "r1"])).toBe("rec:r1");
	expect(pinOf(["records", "client"])).toBe("db:client");
	expect(pinOf(["chat"])).toBeUndefined();
	expect(pinOf(["settings", "agents"])).toBeUndefined();
	expect(pathOf("chat:c1")).toEqual(["chat", "c1"]);
	expect(pathOf("page:p1")).toEqual(["pages", "p1"]);
	expect(pathOf("db:client")).toEqual(["records", "client"]);
	expect(pathOf("rec:r1", "client")).toEqual(["records", "client", "r1"]);
});

it("shares pins and recents between readers, and keeps recents newest first without repeats", () => {
	let a!: ReturnType<typeof usePins>;
	let b!: ReturnType<typeof usePins>;
	const A = () => ((a = usePins()), null);
	const B = () => ((b = usePins()), null);
	act(() => { root = create(createElement(Harness, { children: createElement("div", null, createElement(A), createElement(B)) })); });

	act(() => a.toggle("page:p1"));
	expect(b.pins).toEqual(["page:p1"]);
	expect(store.has("rail.pins:w1")).toBe(false);
	act(() => b.toggle("page:p1"));
	expect(a.pins).toEqual([]);

	act(() => (a.visit("chat:c1"), a.visit("page:p1"), a.visit("chat:c1")));
	expect(b.recent).toEqual(["chat:c1", "page:p1"]);
});

it("shows a failed arrangement save through the app's notice", async () => {
	let pins!: ReturnType<typeof usePins>;
	const Reader = () => ((pins = usePins()), createElement(Errors));
	await act(async () => { root = create(createElement(Harness, { children: createElement(Reader) })); });
	live.reject = true;
	await act(async () => pins.toggle("page:p1"));
	expect(JSON.stringify(root.toJSON())).toContain("Could not save pins");
});
