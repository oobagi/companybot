// Sidebar sections people add: where a drop lands, what a folded one keeps, and what someone without
// `sidebar.arrange` sees.
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dropAt } from "../../sections";
import { place } from "../../sortable";
import { inApp } from "../../testing";
import { SectionGroup } from "./Sidebar";

const layout = vi.hoisted(() => ({ writable: true, folded: [] as string[] }));
vi.mock("react-dom", async (actual) => ({ ...(await actual<typeof import("react-dom")>()), createPortal: (node: React.ReactNode) => node }));
vi.mock("../../convex", () => ({ useMutation: () => vi.fn(), useQuery: () => undefined, useWorkspace: () => ({ id: "w" }) }));
vi.mock("../../arrangements", () => ({ useStoredIds: () => [layout.folded, vi.fn(), layout.writable], useArrangementState: () => null }));
vi.mock("../../sections", async (actual) => ({ ...(await actual<typeof import("../../sections")>()), useSections: () => ({ place: vi.fn(), writable: layout.writable }) }));

let root: ReactTestRenderer;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	layout.writable = true;
	layout.folded = [];
});
afterEach(() => act(() => root?.unmount()));

const section = { _id: "s1" as never, tab: "chat" as const, name: "Team", ids: [] };
const show = (rows: string[]) =>
	act(() => {
		root = create(inApp(createElement(SectionGroup, { tab: "chat", section, drag: undefined, first: true, rows, keep: (id) => id === "open", render: (id) => createElement("p", { key: id }, id) })));
	});
const shown = () => root.root.findAllByType("p").map((p) => p.props.children);
const buttons = () => root.root.findAll((n) => n.type === "button").map((b) => b.props["aria-label"] ?? b.props.children);

it("lands a row from another list before the one it's dropped over, filling in what was drawn but never saved", () => {
	expect(dropAt(["b"], ["a", "b", "c"], "x", 1)).toEqual({ beforeId: "b", fill: ["a"] });
	expect(dropAt(["a", "b"], ["a", "b"], "x", 2)).toEqual({ beforeId: null, fill: [] });
	// A section's header ends the list above and starts its own, so both take drops while empty.
	const header = { key: "h", start: 0, size: 20, gap: 4, pitch: 24, endOf: "none", startOf: "s1" };
	const row = { key: "r", list: "s1", id: "r", start: 24, size: 30, gap: 2, pitch: 32 };
	expect(place([header, row], 1, -30, { along: -15, across: 0 }, () => true)!.target).toMatchObject({ list: "none", index: 0 });
	expect(place([header, row], 1, 24, { along: 39, across: 0 }, () => true)!.target).toMatchObject({ list: "s1", index: 0 });
});

it("keeps only what needs you while folded, and gives people who can't arrange no controls or empty sections", () => {
	show(["a", "open"]);
	expect(shown()).toEqual(["a", "open"]);
	expect(buttons()).toEqual(expect.arrayContaining(["Actions for Team"]));
	layout.folded = ["s1"];
	show(["a", "open"]);
	expect(shown()).toEqual(["open"]);
	layout.writable = false;
	layout.folded = [];
	show(["a"]);
	expect(shown()).toEqual(["a"]);
	expect(buttons()).not.toContain("Actions for Team");
	show([]);
	expect(root.toJSON()).toBeNull();
});
