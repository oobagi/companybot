import { expect, it, vi } from "vitest";
import { migrateArrangements } from "./arrangements";

function storage(values: Record<string, string>) {
	const entries = new Map(Object.entries(values));
	return { entries, get length() { return entries.size; }, key: (i: number) => [...entries.keys()][i] ?? null, getItem: (key: string) => entries.get(key) ?? null, removeItem: (key: string) => { entries.delete(key); } };
}

it("copies each local value up before deleting its key, converts layout, and preserves device settings and drafts", async () => {
	const local = storage({ "rail.tabs": '["drive","chat"]', "records.layout.job": '{"layout":"board","groupBy":"status"}', "sidebar.width": "280", "sidebar.hidden": "true", "draft:a": "draft", "views.order:deleted": '["gone"]' });
	const upload = vi.fn(async ({ key }: { key: string; ids: string[] }) => { expect(local.entries.has(key)).toBe(true); });
	await migrateArrangements(local, upload);
	expect(upload.mock.calls.map(([args]) => args)).toEqual([{ key: "rail.tabs", ids: ["drive", "chat"] }, { key: "records.layout.job", ids: ["board", "status"] }, { key: "views.order:deleted", ids: ["gone"] }]);
	expect([...local.entries.keys()]).toEqual(["sidebar.width", "sidebar.hidden", "draft:a"]);
	await migrateArrangements(local, upload);
	expect(upload).toHaveBeenCalledTimes(3);
});

it("keeps a local key when upload fails so the next load can retry", async () => {
	const local = storage({ "rail.order": '["w1"]' });
	await expect(migrateArrangements(local, async () => { throw Error("offline"); })).rejects.toThrow("offline");
	expect(local.getItem("rail.order")).toBe('["w1"]');
	const upload = vi.fn(async () => {});
	await migrateArrangements(local, upload);
	expect(local.entries.size).toBe(0);
});

it("discards invalid and orphaned legacy keys without retaining a local fallback", async () => {
	const local = storage({ "sidebar.pages:missing": '["gone"]', "rail.pins:w1": "broken", "sidebar.dms:w1": '[null,2,"a","a"]' });
	const upload = vi.fn(async () => {});
	await migrateArrangements(local, upload);
	expect(upload.mock.calls).toEqual([[{ key: "rail.pins:w1", ids: [] }], [{ key: "sidebar.dms:w1", ids: ["a"] }]]);
	expect(local.entries.size).toBe(0);
});
