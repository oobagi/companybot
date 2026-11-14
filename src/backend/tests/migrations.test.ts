import migrationsTest from "@convex-dev/migrations/test";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

import { builtInRoleOf, modules, signIn } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("migrations", () => {

	it("normalizes membership emails for bounded invitation checks, and fails closed on a row without one", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "MixedCase@Co.com");
		const membership = await t.run(ctx => ctx.db.query("members").first());
		expect(membership!.email).toBe("mixedcase@co.com");
		await expect(owner.mutation(api.workspace.invite, { email: "MIXEDCASE@CO.COM", roles: [await builtInRoleOf(owner, "member")] })).rejects.toThrow("already a member");
		await t.run(ctx => ctx.db.patch(membership!._id, { email: undefined }));
		await expect(owner.mutation(api.workspace.invite, { email: "next@co.com", roles: [await builtInRoleOf(owner, "member")] })).rejects.toThrow("being updated");
	});
});

// COMPAT(0.1.0-alpha.11): delete with migrations.recordRanks.
it("gives records from before boards' manual order a place in it, newest first", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	prosemirrorSync.register(t);
	const owner = await signIn(t, "owner@co.com");
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Deals" });
	for (const name of ["Old", "New"]) await owner.mutation(api.records.create, { typeId, values: { name } });
	await t.run(async (ctx) => {
		for (const r of await ctx.db.query("records").collect()) await ctx.db.patch(r._id, { rank: undefined });
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
	const listed = await owner.query(api.records.list, { typeId, sort: { field: "manualOrder", order: "asc" }, paginationOpts: { numItems: 10, cursor: null } });
	expect(listed.page.map((r) => r.title)).toEqual(["New", "Old"]);
});

// COMPAT(0.1.0-alpha.11): delete with migrations.dropViewNotice.
it("clears views' old notes about removed filters", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	prosemirrorSync.register(t);
	const owner = await signIn(t, "owner@co.com");
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Deals" });
	const id = await t.run(async (ctx) => {
		const type = (await ctx.db.get(typeId))!;
		return ctx.db.insert("databaseViews", { workspaceId: type.workspaceId, typeId: type._id, name: "Open", filters: [], columns: [], version: 1, notice: "“Stage” changed, so its filter was removed." });
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
	const view = (await t.run((ctx) => ctx.db.get(id)))!;
	expect(view.notice).toBeUndefined();
	expect(view.name).toBe("Open");
});

// COMPAT(0.1.0-alpha.11): delete with migrations.allView.
it("turns each database's All tab into a saved view, first in order, from its shared layout and columns", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	prosemirrorSync.register(t);
	const owner = await signIn(t, "owner@co.com");
	const create = async (plural: string) => {
		const typeId = await owner.mutation(api.recordTypes.create, { plural });
		for (const label of ["Phone", "Email", "City", "Notes", "Source"]) await owner.mutation(api.fields.create, { typeId, label, kind: "text" });
		return typeId;
	};
	const deals = await create("Deals");
	const stage = await owner.mutation(api.fields.create, { typeId: deals, label: "Stage", kind: "choice", options: [{ label: "Won" }] });
	const notes = await create("Notes");
	const leads = await create("Leads");
	// Made since the deploy: it has its own All already.
	const fresh = await create("Jobs");
	const viewsOf = (typeId: Id<"recordTypes">) => owner.query(api.databaseViews.list, { typeId });
	const order = (typeId: Id<"recordTypes">) => t.run(async (ctx) => (await ctx.db.query("arrangements").collect()).find((r) => r.list === "views" && r.entityId === typeId)?.ids);
	// Before: no All views; Deals had a board, widths and its own columns, and a view ordered first; Leads a view named "all".
	const [won, all] = await t.run(async (ctx) => {
		for (const typeId of [deals, notes, leads]) for (const v of await ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect()) await ctx.db.delete(v._id);
		const workspaceId = (await ctx.db.get(deals))!.workspaceId;
		await ctx.db.patch(deals, { display: { layout: "board", groupBy: stage.key, widths: { name: 300, phone: 90, gone: 200 } } });
		await ctx.db.patch(leads, { display: { layout: "table" } });
		await ctx.db.insert("arrangements", { workspaceId, list: "columns", entityId: deals, ids: ["phone", "name", "gone", stage.key] });
		const won = await ctx.db.insert("databaseViews", { workspaceId, typeId: deals, name: "Won", filters: [], columns: ["name"], version: 1 });
		await ctx.db.insert("arrangements", { workspaceId, list: "views", entityId: deals, ids: [won] });
		const all = await ctx.db.insert("databaseViews", { workspaceId, typeId: leads, name: "all", filters: [], columns: ["name", "city"], version: 1 });
		return [won, all];
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		// Safe to run again: nothing is added twice.
		await t.mutation(internal.migrations.allView, { reset: true });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	} finally {
		vi.useRealTimers();
	}
	const dealViews = await viewsOf(deals);
	const dealsAll = dealViews.find((v) => v.name === "All")!;
	expect(dealsAll).toMatchObject({ filters: [], columns: ["phone", "name", stage.key], layout: "board", groupBy: stage.key, widths: { name: 300, phone: 90 }, version: 1 });
	expect(dealViews).toHaveLength(2);
	expect(await order(deals)).toEqual([dealsAll._id, won]);
	// Never customized: Name and the next four fields, as the app showed it.
	expect(await viewsOf(notes)).toEqual([expect.objectContaining({ name: "All", columns: ["name", "phone", "email", "city", "notes"] })]);
	const leadViews = await viewsOf(leads);
	expect(leadViews.map((v) => v.name)).toEqual(["all", "All 2"]);
	expect(await order(leads)).toEqual([leadViews[1]!._id]);
	expect(leadViews.find((v) => v._id === all)).toMatchObject({ columns: ["name", "city"] });
	expect((await viewsOf(fresh)).map((v) => v.name)).toEqual(["All"]);
	await t.run(async (ctx) => {
		for (const typeId of [deals, notes, leads, fresh]) expect((await ctx.db.get(typeId))!.display).toBeUndefined();
		expect((await ctx.db.query("arrangements").collect()).filter((r) => r.list === "columns")).toEqual([]);
	});
});
