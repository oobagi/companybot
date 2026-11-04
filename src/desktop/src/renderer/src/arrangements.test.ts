import type { FunctionArgs } from "convex/server";
import type { OptimisticLocalStore } from "convex/browser";
import { expect, it, vi } from "vitest";
import { api } from "./api";
import { migrateArrangements, optimisticArrangements } from "./arrangements";

function storage(values: Record<string, string>) {
	const entries = new Map(Object.entries(values));
	return { entries, get length() { return entries.size; }, key: (i: number) => [...entries.keys()][i] ?? null, getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => { entries.delete(key); } };
}

it("uploads pins before deleting them, discards recents, imports database display separately, and preserves device settings", async () => {
	const local = storage({ "rail.pins:w1": '["page:p1"]', "rail.recent:w1": '["chat:previous-person"]', "records.layout.job": '{"layout":"board","groupBy":"status"}', "sidebar.width": "280", "sidebar.hidden": "true", "draft:a": "draft" });
	const upload = vi.fn(async (args: FunctionArgs<typeof api.arrangements.migrate>) => { expect(local.entries.has("rail.pins:w1")).toBe(true); expect(args).toMatchObject({ list: "pins", targetWorkspaceId: "w1", ids: ["page:p1"] }); });
	const display = vi.fn(async () => {});
	await migrateArrangements(local, upload, display);
	expect(upload).toHaveBeenCalledTimes(1);
	expect(display).toHaveBeenCalledExactlyOnceWith({ databaseKey: "job", display: { layout: "board", groupBy: "status" } });
	expect([...local.entries.keys()]).toEqual(["sidebar.width", "sidebar.hidden", "draft:a"]);
});

it("logs failed uploads, keeps those keys for retry, and completes other imports so the app can open", async () => {
	const local = storage({ "rail.order": '["w1"]', "rail.tabs": '["chat"]' });
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const upload = vi.fn(async (args: FunctionArgs<typeof api.arrangements.migrate>) => { if (args.list === "workspaces") throw Error("offline"); });
	await expect(migrateArrangements(local, upload, async () => {})).resolves.toBeUndefined();
	expect(log).toHaveBeenCalled();
	expect(local.getItem("rail.order")).toBe('["w1"]');
	expect(local.getItem("rail.tabs")).toBeNull();
	await migrateArrangements(local, async () => {}, async () => {});
	expect(local.entries.size).toBe(0);
	log.mockRestore();
});

it("discards orphaned local keys and sanitizes broken local data", async () => {
	const local = storage({ "sidebar.pages:missing": '["gone"]', "rail.pins:w1": "broken", "sidebar.dms:w1": '[null,2,"a","a"]' });
	const upload = vi.fn(async () => {});
	await migrateArrangements(local, upload, async () => {});
	expect(upload.mock.calls).toMatchObject([[{ list: "pins", ids: [] }], [{ list: "dms", ids: ["a"] }]]);
	expect(local.entries.size).toBe(0);
});

it("optimistic updates affect only the requested workspace, including workspace order", () => {
	for (const list of ["channels", "workspaces"] as const) {
		const queries = ["w1", "w2"].map((workspaceId) => ({ args: { workspaceId }, value: { rows: [{ list, ids: ["before"] }], writable: true } }));
		const setQuery = vi.fn((_fn, args, value) => { queries.find((q) => q.args.workspaceId === args.workspaceId)!.value = value; });
		const store = { getAllQueries: () => queries, setQuery } as unknown as OptimisticLocalStore;
		optimisticArrangements(store, { workspaceId: "w1", list, ids: ["after"] } as FunctionArgs<typeof api.arrangements.set>);
		expect(queries[0]!.value.rows[0]!.ids).toEqual(["after"]);
		expect(queries[1]!.value.rows[0]!.ids).toEqual(["before"]);
		expect(setQuery).toHaveBeenCalledTimes(1);
	}
});
