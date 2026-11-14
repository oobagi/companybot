import type { FunctionArgs } from "convex/server";
import type { OptimisticLocalStore } from "convex/browser";
import { expect, it, vi } from "vitest";
import { api } from "./api";
import { migrateArrangements, optimisticArrangements } from "./arrangements";

function storage(values: Record<string, string>) {
	const entries = new Map(Object.entries(values));
	return { entries, get length() { return entries.size; }, key: (i: number) => [...entries.keys()][i] ?? null, getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => { entries.delete(key); } };
}

it("uploads pins before deleting them, discards recents and the old All tab layout, and preserves device settings", async () => {
	const local = storage({ "rail.pins:w1": '["page:p1"]', "rail.recent:w1": '["chat:previous-person"]', "records.layout.job": '{"layout":"board","groupBy":"status"}', "sidebar.width": "280", "sidebar.hidden": "true", "draft:a": "draft" });
	const upload = vi.fn(async (args: FunctionArgs<typeof api.arrangements.migrate>) => { expect(local.entries.has("rail.pins:w1")).toBe(true); expect(args).toMatchObject({ list: "pins", targetWorkspaceId: "w1", ids: ["page:p1"] }); });
	await migrateArrangements(local, upload);
	expect(upload).toHaveBeenCalledTimes(1);
	expect([...local.entries.keys()]).toEqual(["sidebar.width", "sidebar.hidden", "draft:a"]);
});

it("logs failed uploads, keeps those keys for retry, and completes other imports so the app can open", async () => {
	const local = storage({ "rail.order": '["w1"]', "rail.tabs": '["chat"]' });
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const upload = vi.fn(async (args: FunctionArgs<typeof api.arrangements.migrate>) => { if (args.list === "workspaces") throw Error("offline"); });
	await expect(migrateArrangements(local, upload)).resolves.toBeUndefined();
	expect(log).toHaveBeenCalled();
	expect(local.getItem("rail.order")).toBe('["w1"]');
	expect(local.getItem("rail.tabs")).toBeNull();
	await migrateArrangements(local, async () => {});
	expect(local.entries.size).toBe(0);
	log.mockRestore();
});

it("discards orphaned local keys and sanitizes broken local data", async () => {
	const local = storage({ "sidebar.pages:missing": '["gone"]', "rail.pins:w1": "broken", "sidebar.dms:w1": '[null,2,"a","a"]' });
	const upload = vi.fn(async () => {});
	await migrateArrangements(local, upload);
	expect(upload.mock.calls).toMatchObject([[{ list: "pins", ids: [] }], [{ list: "dms", ids: ["a"] }]]);
	expect(local.entries.size).toBe(0);
});

it("optimistic updates apply the command to the requested workspace only, including workspace order", () => {
	for (const list of ["channels", "workspaces"] as const) {
		const queries = ["w1", "w2"].map((workspaceId) => ({ args: { workspaceId }, value: { rows: [{ list, ids: ["a", "b"] }], writable: true } }));
		const setQuery = vi.fn((_fn, args, value) => { queries.find((q) => q.args.workspaceId === args.workspaceId)!.value = value; });
		const store = { getAllQueries: () => queries, setQuery } as unknown as OptimisticLocalStore;
		optimisticArrangements(store, { workspaceId: "w1", list, command: { op: "move", id: "b", beforeId: "a" } } as FunctionArgs<typeof api.arrangements.change>);
		expect(queries[0]!.value.rows[0]!.ids).toEqual(["b", "a"]);
		expect(queries[1]!.value.rows[0]!.ids).toEqual(["a", "b"]);
		expect(setQuery).toHaveBeenCalledTimes(1);
	}
});

it("clears a 1,100-channel key once the bounded import finishes", async () => {
	const ids = Array.from({ length: 1_100 }, (_, i) => `c${i}`);
	const local = storage({ "sidebar.channels:w1": JSON.stringify(ids) });
	const upload = vi.fn(async () => {});
	await migrateArrangements(local, upload);
	expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ list: "channels", targetWorkspaceId: "w1", ids }));
	expect(local.entries.size).toBe(0);
});
