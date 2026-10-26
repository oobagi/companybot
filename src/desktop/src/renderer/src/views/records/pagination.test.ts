import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { RecordType, Row } from "./data";
import { RecordList } from "./RecordList";

const page = vi.hoisted(() => ({ results: [] as Row[], status: "LoadingFirstPage", loadMore: vi.fn() }));
vi.mock("../../convex", () => ({
	usePaginatedQuery: () => page,
	useQuery: () => undefined,
	useMutation: () => vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["client", "deal", "task", "call", "custom"])("auto-pages a fresh %s list after its loading screen", async (key) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: () => null });
	const sentinel = {};
	const observe = vi.fn();
	const disconnect = vi.fn();
	let intersect!: (visible: boolean) => void;
	vi.stubGlobal("IntersectionObserver", class {
		constructor(callback: IntersectionObserverCallback) {
			intersect = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
		}
		observe = observe;
		disconnect = disconnect;
	});
	const type = { _id: key, key, name: key, plural: key, fields: [{ key: "name", label: "Name", kind: "text" }] } as RecordType;
	const tree = () => createElement(RecordList, { type, role: "owner" });
	const rows = (count: number) => Array.from({ length: count }, (_, i) => ({
		_id: `row-${i}`, values: { name: `Record ${i}` }, updatedAt: Date.now(), refs: {}, unresolved: [],
	})) as unknown as Row[];
	let root!: ReactTestRenderer;
	page.results = [];
	page.status = "LoadingFirstPage";
	page.loadMore.mockClear();
	await act(async () => { root = create(tree(), { createNodeMock: () => sentinel }); });
	expect(observe).not.toHaveBeenCalled();
	try {
		// The sentinel appears only after the first response, without remounting the list.
		page.results = rows(25);
		page.status = "CanLoadMore";
		await act(async () => root.update(tree()));
		expect(observe).toHaveBeenCalledWith(sentinel);
		expect(page.loadMore).not.toHaveBeenCalled();
		await act(async () => intersect(true));
		expect(page.loadMore).toHaveBeenCalledExactlyOnceWith(25);

		// A short or empty intermediate page must continue while the end stays visible.
		page.status = "LoadingMore";
		await act(async () => root.update(tree()));
		page.status = "CanLoadMore";
		await act(async () => root.update(tree()));
		expect(page.loadMore).toHaveBeenCalledTimes(2);

		await act(async () => intersect(false));
		page.results = rows(50);
		await act(async () => root.update(tree()));
		expect(page.loadMore).toHaveBeenCalledTimes(2);
		await act(async () => intersect(true));
		expect(page.loadMore).toHaveBeenCalledTimes(3);
		page.results = rows(65);
		page.status = "Exhausted";
		await act(async () => root.update(tree()));
		expect(root.root.findAllByType("tbody")[0]!.findAllByType("tr")).toHaveLength(65);
		expect(page.loadMore).toHaveBeenCalledTimes(3);
	} finally {
		await act(async () => root.unmount());
	}
	expect(disconnect).toHaveBeenCalledOnce();
});
