import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RecordType, Row } from "./data";
import { RecordList } from "./RecordList";

const state = vi.hoisted(() => ({
	rows: [] as Row[],
	status: "CanLoadMore",
	loadMore: vi.fn(),
	update: vi.fn(() => Promise.resolve()),
	lists: [] as { filters: unknown[]; group?: unknown }[],
}));
vi.mock("../../convex", () => ({
	useQuery: () => undefined,
	useMutation: () => state.update,
	usePaginatedQuery: (_fn: unknown, args: { filters: unknown[]; group?: { option: string | null } }) => (state.lists.push(args), args.group?.option === "old")
		? { results: state.rows, status: state.status, loadMore: state.loadMore }
		: { results: [], status: "Exhausted", loadMore: vi.fn() },
}));

const type = {
	_id: "jobs", key: "job", name: "Job", plural: "Jobs",
	fields: [
		{ key: "name", label: "Name", kind: "text" },
		{ key: "status", label: "Status", kind: "choice", options: [{ id: "todo", label: "To do" }, { id: "old", label: "Old", retired: true }] },
	],
} as RecordType;
let root: ReactTestRenderer;
let intersect: IntersectionObserverCallback;
beforeEach(() => {
	vi.clearAllMocks();
	state.rows = [];
	state.status = "CanLoadMore";
	state.lists = [];
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { getItem: (key: string) => key.startsWith("records.layout.") ? '{"layout":"board","groupBy":"status"}' : null });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.stubGlobal("IntersectionObserver", class {
		constructor(callback: IntersectionObserverCallback) { intersect = callback; }
		observe() {}
		disconnect() {}
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});
const tree = () => createElement(RecordList, { type, role: "owner" as const });

it("continues an empty first page before deciding a retired column has no cards", async () => {
	await act(async () => { root = create(tree(), { createNodeMock: () => ({}) }); });
	expect(root.root.findAllByType("section")).toHaveLength(3);
	await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
	expect(state.loadMore).toHaveBeenCalledExactlyOnceWith(25);
	state.rows = [{ _id: "record", values: { name: "Still here", status: "old" }, refs: {}, unresolved: [] }] as unknown as Row[];
	state.status = "Exhausted";
	await act(async () => root.update(tree()));
	expect(JSON.stringify(root.toJSON())).toContain("Still here");
	state.rows = [];
	await act(async () => root.update(tree()));
	expect(root.root.findAllByType("section")).toHaveLength(2);
});

it("asks for each column as `group`, leaving the view's filters (and their limit) alone", async () => {
	await act(async () => { root = create(tree(), { createNodeMock: () => ({}) }); });
	expect(new Set(state.lists.map((a) => JSON.stringify(a.group)))).toEqual(new Set(['{"field":"status","option":null}', '{"field":"status","option":"todo"}', '{"field":"status","option":"old"}']));
	for (const args of state.lists) expect(args.filters).toEqual([]);
});

it("ignores drops within the same column, into removed options, or from a different board", async () => {
	state.status = "Exhausted";
	state.rows = [{ _id: "record", values: { name: "Old card", status: "old" }, refs: {}, unresolved: [] }] as unknown as Row[];
	await act(async () => { root = create(tree()); });
	const lanes = root.root.findAllByType("section");
	const drop = (lane: number, card: Record<string, string>) => lanes[lane]!.props.onDrop({
		preventDefault: vi.fn(), dataTransfer: { getData: () => JSON.stringify(card) },
	});
	const card = { id: "record", from: "todo", typeId: "jobs", groupBy: "status" };
	await act(async () => {
		drop(1, card);
		drop(2, card);
		drop(0, { ...card, typeId: "another-db" });
		drop(0, { ...card, groupBy: "priority" });
	});
	expect(state.update).not.toHaveBeenCalled();
	await act(async () => drop(0, card));
	expect(state.update).toHaveBeenCalledExactlyOnceWith({ recordId: "record", values: { status: null } });
});
