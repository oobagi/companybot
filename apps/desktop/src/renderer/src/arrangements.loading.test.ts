import { getFunctionName } from "convex/server";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { Arrangement } from "@companybot/core/arrangements";
import { LoadedArrangements, useStoredIds } from "./arrangements";

const state = vi.hoisted(() => ({ data: undefined as { rows: Arrangement[]; writable: boolean } | undefined, query: vi.fn(), mutate: vi.fn(async () => {}) }));
vi.mock("./convex", () => ({
	useQuery: (fn: Parameters<typeof getFunctionName>[0], args: unknown) => { state.query(getFunctionName(fn), args); return args === "skip" ? undefined : state.data; },
	useMutation: () => state.mutate,
}));
let root: ReactTestRenderer;
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Lists() {
	const [tabs] = useStoredIds("rail");
	const [pins] = useStoredIds("pins");
	return createElement("div", null, tabs.join(","), ";", pins.join(","));
}
const tree = () => createElement(LoadedArrangements, { userId: "user", children: createElement(Lists) });

it("renders no default/empty lists while loading, then mounts both from one complete subscription", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { length: 0 });
	state.data = undefined;
	state.query.mockClear();
	await act(async () => { root = create(tree()); });
	expect(root.toJSON()).toBeNull();
	state.data = { rows: [{ list: "rail", ids: ["drive", "chat"] }, { list: "pins", ids: ["page:p1"] }], writable: true };
	state.query.mockClear();
	await act(async () => root.update(tree()));
	expect(root.toJSON()).toMatchObject({ children: ["drive,chat", ";", "page:p1"] });
	expect(state.query).toHaveBeenCalledExactlyOnceWith("arrangements:get", {});
});

it("opens with loaded server arrangements even when a local upload fails", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("localStorage", { length: 1, key: () => "rail.pins:ws", getItem: () => '["page:old"]', removeItem: vi.fn() });
	vi.spyOn(console, "error").mockImplementation(() => {});
	state.mutate.mockRejectedValueOnce(Error("offline"));
	state.data = { rows: [{ list: "pins", ids: ["page:saved"] }], writable: true };
	await act(async () => { root = create(tree()); });
	expect(JSON.stringify(root.toJSON())).toContain("page:saved");
	expect(localStorage.removeItem).not.toHaveBeenCalled();
});
