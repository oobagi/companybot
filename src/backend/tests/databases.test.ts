import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { childrenOf } from "../convex/lifecycle";
import { seedRecordTypes } from "../convex/recordOps";
import { agentTurn, agentsOf, generalOf, setup, settle, signIn } from "./helpers";

afterEach(() => vi.useRealTimers());
const page = { numItems: 20, cursor: null };
const config = { name: "By name", filters: [], columns: ["name"], sort: { field: "name", order: "asc" as const } };

it("owners create, rename and archive databases with stable keys and Activity history", async () => {
	const { owner, member } = await setup();
	const id = await owner.mutation(api.recordTypes.create, { plural: " Jobs " });
	let database = (await member.query(api.recordTypes.list)).find((t) => t._id === id)!;
	expect(database).toMatchObject({ key: "job", name: "Job", plural: "Jobs", version: 0 });
	for (const input of [{ name: "Work", plural: "Works" }, { archived: true }])
		await expect(member.mutation(api.recordTypes.update, { typeId: id, version: 0, ...input })).rejects.toThrow("permission");
	await owner.mutation(api.recordTypes.update, { typeId: id, version: 0, name: "Project", plural: "Projects" });
	await expect(owner.mutation(api.recordTypes.update, { typeId: id, version: 0, plural: "Stale" })).rejects.toThrow("conflict");
	database = (await owner.query(api.recordTypes.list)).find((t) => t._id === id)!;
	expect(database).toMatchObject({ key: "job", name: "Project", plural: "Projects", version: 1 });
	await owner.mutation(api.recordTypes.update, { typeId: id, version: 1, archived: true });
	expect((await member.query(api.recordTypes.list)).some((t) => t._id === id)).toBe(false);
	const history = await member.query(api.records.activity, { paginationOpts: page });
	expect(history.page.map((e) => [e.action, e.user, e.agent])).toEqual([
		["database.archived", "owner@co.com", null], ["database.updated", "owner@co.com", null], ["database.created", "owner@co.com", null],
	]);
});

it("renames and archives built-ins, which re-seeding leaves archived, and validates database names", async () => {
	const { t, owner } = await setup();
	const types = await owner.query(api.recordTypes.list);
	for (const type of types) await owner.mutation(api.recordTypes.update, { typeId: type._id, name: `${type.name} new`, plural: `${type.plural} new`, version: type.version });
	await expect(owner.mutation(api.recordTypes.create, { plural: "CLIENTS NEW" })).rejects.toThrow("already");
	for (const name of [" ", "a".repeat(121)]) await expect(owner.mutation(api.recordTypes.create, { plural: name })).rejects.toThrow("120");
	const client = types.find((type) => type.key === "client")!;
	await owner.mutation(api.recordTypes.update, { typeId: client._id, archived: true, version: 1 });
	const workspaceId = (await t.run((ctx) => ctx.db.get(client._id)))!.workspaceId;
	await t.run((ctx) => seedRecordTypes(ctx, workspaceId, owner.userId));
	expect((await owner.query(api.recordTypes.list)).map((type) => type.key)).toEqual(types.map((type) => type.key).filter((key) => key !== "client"));
});

it("shares sorting, filtering and ordered columns; refuses stale saves and deletions", async () => {
	const { t, owner, member } = await setup();
	const type = (await owner.query(api.recordTypes.list)).find((t) => t.key === "deal")!;
	const input = { ...config, typeId: type._id, filters: [{ field: "stage", in: ["won"] }], columns: ["name", "stage", "value"] };
	const id = await member.mutation(api.databaseViews.save, input);
	await expect(owner.mutation(api.databaseViews.save, { ...input, name: "BY NAME" })).rejects.toThrow("already exists");
	expect(await owner.query(api.databaseViews.list, { typeId: type._id })).toEqual([expect.objectContaining({ ...input, version: 1 })]);
	await owner.mutation(api.databaseViews.save, { ...input, viewId: id, version: 1, name: "Won deals", sort: { field: "value", order: "desc" }, columns: ["name", "value"] });
	await expect(member.mutation(api.databaseViews.save, { ...input, viewId: id, version: 1 })).rejects.toThrow("conflict");
	await expect(member.mutation(api.databaseViews.remove, { viewId: id, version: 1 })).rejects.toThrow("conflict");
	const [view] = await member.query(api.databaseViews.list, { typeId: type._id });
	expect(view).toMatchObject({ name: "Won deals", version: 2, columns: ["name", "value"], sort: { field: "value", order: "desc" } });
	await member.mutation(api.databaseViews.remove, { viewId: id, version: 2 });
	expect(await owner.query(api.databaseViews.list, { typeId: type._id })).toEqual([]);
	expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
	const history = await member.query(api.records.activity, { paginationOpts: page });
	expect(history.page.map((e) => [e.action, e.subject, e.user])).toEqual([
		["view.deleted", "Won deals", "member@co.com"], ["view.updated", "Won deals", "owner@co.com"], ["view.created", "By name", "member@co.com"],
	]);
});

it("checks filter semantics, columns, names and per-database limits before writing", async () => {
	const { owner } = await setup();
	const [type] = await owner.query(api.recordTypes.list);
	const input = { ...config, typeId: type!._id };
	for (const patch of [
		{ name: " " }, { columns: [] }, { columns: ["name", "name"] }, { columns: ["name", "missing"] },
		{ filters: [{ field: "missing", eq: 1 }] }, { filters: [{ field: "name", gt: 1 }] },
		{ filters: [{ field: "name", eq: "x", empty: true }] }, { sort: { field: "missing", order: "asc" as const } },
		{ filters: Array.from({ length: 11 }, () => ({ field: "name", eq: "x" })) },
		{ filters: [{ field: "name", eq: "a".repeat(16000) }] },
	]) await expect(owner.mutation(api.databaseViews.save, { ...input, ...patch })).rejects.toThrow();
	expect(await owner.query(api.databaseViews.list, { typeId: type!._id })).toEqual([]);
	for (let i = 0; i < 50; i++) await owner.mutation(api.databaseViews.save, { ...input, name: `View ${i}` });
	await expect(owner.mutation(api.databaseViews.save, { ...input, name: "One too many" })).rejects.toThrow("50");
});

it("isolates every database and view operation across workspaces, including forged ids", async () => {
	const { t, owner } = await setup();
	const other = await signIn(t, "outsider@co.com");
	// COMPAT(0.1.0-alpha.8): alpha.6 apps send both names.
	const typeId = await owner.mutation(api.recordTypes.create, { name: "Job", plural: "Jobs" });
	const viewId = await owner.mutation(api.databaseViews.save, { ...config, typeId });
	await expect(other.mutation(api.recordTypes.update, { typeId, version: 0, name: "Stolen" })).rejects.toThrow("not found");
	expect(await other.query(api.databaseViews.list, { typeId })).toEqual([]);
	await expect(other.mutation(api.databaseViews.save, { ...config, typeId })).rejects.toThrow("not found");
	await expect(other.mutation(api.databaseViews.remove, { viewId, version: 1 })).rejects.toThrow("not found");
	const [ownType] = await other.query(api.recordTypes.list);
	await expect(other.mutation(api.databaseViews.save, { ...config, typeId: ownType!._id, viewId, version: 1 })).rejects.toThrow("not found");
});

it("empties a live view subscription when its database is archived, keeping its data and refusing edits", async () => {
	const { t, owner } = await setup();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	const viewId = await owner.mutation(api.databaseViews.save, { ...config, typeId });
	await owner.mutation(api.recordTypes.update, { typeId, archived: true, version: 0 });
	expect(await owner.query(api.databaseViews.list, { typeId })).toEqual([]);
	expect(await t.run((ctx) => ctx.db.get(viewId))).not.toBeNull();
	await expect(owner.mutation(api.databaseViews.save, { ...config, typeId, viewId, version: 1 })).rejects.toThrow("archived");
	await expect(owner.mutation(api.databaseViews.remove, { viewId, version: 1 })).rejects.toThrow("archived");
});

it("keeps shared views when their maker leaves, and cascades them with their database", async () => {
	const { t, owner, member } = await setup();
	const [type] = await owner.query(api.recordTypes.list);
	const id = await member.mutation(api.databaseViews.save, { ...config, typeId: type!._id });
	const membership = await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first());
	await owner.mutation(api.workspace.removeMember, { id: membership!._id });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
	expect(childrenOf("recordTypes")).toContainEqual(expect.objectContaining({ table: "databaseViews", index: "by_type", field: "typeId" }));
	const me = await owner.query(api.workspace.me);
	await owner.mutation(api.workspace.deleteWorkspace, { name: me!.workspace! });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.get(id))).toBeNull();
});

it("gives agents database and view parity, names both actors, and rechecks roles on every call", async () => {
	const { t, owner, member } = await setup();
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
	const database = await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { name: "Jobs" } });
	expect(database).toMatchObject({ type: "job", version: 0 });
	await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: "job", name: "Projects", version: 0 } });
	const saved = await t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "job", name: "Newest", columns: ["name"] } });
	expect(saved).toHaveProperty("_id");
	const views = await t.query(internal.recordTools.viewsFor, { turnId, type: "job" });
	if (!("rows" in views)) throw new Error(views.error);
	const view = views.rows[0]!;
	await t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "job", id: view._id, version: 1, name: "Latest", sort: { field: "updatedAt", order: "desc" } } });
	expect(await t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "job", id: view._id, version: 2, remove: true } })).toEqual({ deleted: "Latest" });
	await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: "job", version: 1, archived: true } });
	const history = await member.query(api.records.activity, { paginationOpts: page });
	expect(history.page).toHaveLength(6);
	for (const entry of history.page) expect(entry).toMatchObject({ user: "owner@co.com", agent: "Companybot" });
	await t.run(async (ctx) => {
		const membership = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", owner.userId)).first();
		await ctx.db.patch(membership!._id, { role: "member" });
	});
	expect(await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { name: "Others" } })).toEqual({ error: expect.stringContaining("permission") });
	const mine = await t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "Deals", name: "My won deals", filters: [{ field: "Stage", in: ["Won"] }, { field: "Owner", eq: "me" }] } });
	expect(mine).toMatchObject({ filters: [{ field: "stage", in: ["won"] }, { field: "owner", eq: owner.userId }] });
});
