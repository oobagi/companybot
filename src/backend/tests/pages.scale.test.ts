import { expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { newTest, settle, signIn, workspaceOf } from "./helpers";

it("trashes/restores a 2,200-page tree at once and purges it through bounded cascades", { timeout: 600_000 }, async () => {
	vi.useFakeTimers();
	try {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const workspaceId = await workspaceOf(owner);
		const root = await owner.mutation(api.pages.create, { title: "Root" });
		const destination = await owner.mutation(api.pages.create, { title: "Destination" });
		const branch = await owner.mutation(api.pages.create, { title: "Branch", parentId: root });
		let leaf: Id<"pages"> = branch;
		for (let start = 0; start < 2_200; start += 100) await t.run(async (ctx) => {
			for (let i = start; i < start + 100; i++) leaf = await ctx.db.insert("pages", { workspaceId, parentId: branch, title: `Page ${String(i).padStart(4, "0")}`, archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: 0 });
		});
		await expect(owner.mutation(api.pages.move, { pageId: root, parentId: destination })).rejects.toThrow("too large");
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		expect((await owner.query(api.trash.list, { paginationOpts: { numItems: 50, cursor: null } })).page).toHaveLength(1);
		expect(await owner.query(api.pages.get, { pageId: leaf })).toMatchObject({ archived: true, canEdit: false });
		expect((await owner.query(api.pages.list, {})).map((p) => p._id)).toEqual([destination]);
		await owner.mutation(api.trash.restore, { kind: "page", id: root });
		expect(await owner.query(api.pages.get, { pageId: leaf })).toMatchObject({ archived: false, canEdit: true });
		let cursor: string | null = null;
		const ids = new Set<string>();
		do {
			const result: FunctionReturnType<typeof api.pages.children> = await owner.query(api.pages.children, { parentId: branch, paginationOpts: { numItems: 50, cursor } });
			for (const row of result.page) ids.add(row._id);
			cursor = result.isDone ? null : result.continueCursor;
		} while (cursor);
		expect(ids.size).toBe(2_200);
		// A shallower move of a large branch remains cheap.
		await owner.mutation(api.pages.move, { pageId: branch });
		await owner.mutation(api.trash.move, { kind: "page", id: branch });
		await owner.mutation(api.trash.purge, { id: branch });
		await settle(t);
		expect(await owner.query(api.pages.get, { pageId: leaf })).toBeNull();
		expect((await owner.query(api.pages.list, {})).map((p) => p._id)).toEqual([destination, root]);
		for (const table of ["pageMoves", "trash", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first()), table).toBeNull();
	} finally { vi.useRealTimers(); }
});
