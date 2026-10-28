import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { childrenOf } from "../convex/lifecycle";
import { agentTurn, agentsOf, generalOf, ownerAndMember, settle, signIn } from "./helpers";

afterEach(() => vi.useRealTimers());
const page = { numItems: 20, cursor: null };
const config = { name: "By name", filters: [], columns: ["name"], sort: { field: "name", order: "asc" as const } };

it("owners create, rename and archive databases with stable keys and Activity history", async () => {
	const { owner, member } = await ownerAndMember();
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

it("renames and archives legacy databases and validates database names", async () => {
	const { owner } = await ownerAndMember();
	const types = await owner.query(api.recordTypes.list);
	for (const type of types) await owner.mutation(api.recordTypes.update, { typeId: type._id, name: `${type.name} new`, plural: `${type.plural} new`, version: type.version });
	await expect(owner.mutation(api.recordTypes.create, { plural: "CLIENTS NEW" })).rejects.toThrow("already");
	for (const name of [" ", "a".repeat(121)]) await expect(owner.mutation(api.recordTypes.create, { plural: name })).rejects.toThrow("120");
	const client = types.find((type) => type.key === "client")!;
	await owner.mutation(api.recordTypes.update, { typeId: client._id, archived: true, version: 1 });
	await owner.mutation(api.workspace.ensure);
	expect((await owner.query(api.recordTypes.list)).map((type) => type.key)).toEqual(types.map((type) => type.key).filter((key) => key !== "client"));
});

it("shares sorting, filtering and ordered columns; refuses stale saves and deletions", async () => {
	const { t, owner, member } = await ownerAndMember();
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
	const { owner } = await ownerAndMember();
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
	const { t, owner } = await ownerAndMember();
	const other = await signIn(t, "outsider@co.com");
	// COMPAT(0.1.0-alpha.8): alpha.6 apps send both names.
	const typeId = await owner.mutation(api.recordTypes.create, { name: "Mouse", plural: "Mice" });
	expect((await owner.query(api.recordTypes.list)).find((t) => t._id === typeId)).toMatchObject({ name: "Mouse", plural: "Mice" });
	const viewId = await owner.mutation(api.databaseViews.save, { ...config, typeId });
	await expect(other.mutation(api.recordTypes.update, { typeId, version: 0, name: "Stolen" })).rejects.toThrow("not found");
	expect(await other.query(api.databaseViews.list, { typeId })).toEqual([]);
	await expect(other.mutation(api.databaseViews.save, { ...config, typeId })).rejects.toThrow("not found");
	await expect(other.mutation(api.databaseViews.remove, { viewId, version: 1 })).rejects.toThrow("not found");
	await other.mutation(api.recordTypes.create, { plural: "Projects" });
	const [ownType] = await other.query(api.recordTypes.list);
	await expect(other.mutation(api.databaseViews.save, { ...config, typeId: ownType!._id, viewId, version: 1 })).rejects.toThrow("not found");
});

it("empties a live view subscription when its database is in Trash, keeping its data and refusing edits", async () => {
	const { t, owner } = await ownerAndMember();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	const viewId = await owner.mutation(api.databaseViews.save, { ...config, typeId });
	await owner.mutation(api.recordTypes.update, { typeId, archived: true, version: 0 });
	expect(await owner.query(api.databaseViews.list, { typeId })).toEqual([]);
	expect(await t.run((ctx) => ctx.db.get(viewId))).not.toBeNull();
	await expect(owner.mutation(api.databaseViews.save, { ...config, typeId, viewId, version: 1 })).rejects.toThrow("in Trash");
	await expect(owner.mutation(api.databaseViews.remove, { viewId, version: 1 })).rejects.toThrow("in Trash");
});

it("keeps shared views when their maker leaves, and cascades them with their database", async () => {
	const { t, owner, member } = await ownerAndMember();
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
	const { t, owner, member } = await ownerAndMember();
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
	await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: "job", trash: true } });
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

it("agent renames drop archived view fields, preserve timestamp sorts, and still reject explicit invalid sorts", async () => {
	const { t, owner } = await ownerAndMember();
	const type = (await owner.query(api.recordTypes.list)).find((t) => t.key === "deal")!;
	const field = type.fields.find((f) => f.key === "value")!;
	const id = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "Value", filters: [{ field: "value", gte: 1 }], sort: { field: "value", order: "asc" }, columns: ["name", "value"] });
	await owner.mutation(api.fields.archive, { fieldId: field._id });
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
	const rename = (version: number, sort?: { field: string; order: "asc" }) => t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "deal", id, version, name: `Renamed ${version}`, sort } });
	expect(await rename(1)).toMatchObject({ name: "Renamed 1", filters: [], columns: ["name"], version: 2 });
	expect((await owner.query(api.databaseViews.list, { typeId: type._id }))[0]?.sort).toBeUndefined();
	expect(await rename(2, { field: "value", order: "asc" })).toHaveProperty("error");
	expect(await rename(2, { field: "createdAt", order: "asc" })).toMatchObject({ sort: { field: "createdAt", order: "asc" }, version: 3 });
	expect(await rename(3)).toMatchObject({ sort: { field: "createdAt", order: "asc" }, version: 4 });
});

it("shows links into a database in Trash as deleted, still readable and clearable", async () => {
	const { t, owner } = await ownerAndMember();
	const types = await owner.query(api.recordTypes.list);
	const client = types.find((t) => t.key === "client")!;
	const deal = types.find((t) => t.key === "deal")!;
	const target = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
	const id = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Roof", client: target } });
	await owner.mutation(api.recordTypes.update, { typeId: client._id, version: 0, archived: true });
	expect(await owner.query(api.records.get, { recordId: id })).toMatchObject({ values: { client: target }, refs: { [target]: { name: "Acme", archived: true } } });
	await owner.mutation(api.records.update, { recordId: id, values: { name: "New roof" } });
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
	expect(await t.query(internal.recordTools.getFor, { turnId, id })).toMatchObject({ values: { client: "Acme (deleted)" }, links: { client: [{ id: target, name: "Acme" }] } });
	await owner.mutation(api.records.update, { recordId: id, values: { client: null } });
	expect((await owner.query(api.records.get, { recordId: id }))?.values).not.toHaveProperty("client");
});

it("saves board views grouped by a single choice field, for people, agents and alpha.7 apps", async () => {
	const { t, owner, member } = await ownerAndMember();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	await owner.mutation(api.fields.create, { typeId, label: "Status", kind: "choice", options: [{ label: "To do" }, { label: "Done" }] });
	await owner.mutation(api.fields.create, { typeId, label: "Tags", kind: "choice", options: [{ label: "Roof" }], multiple: true });
	await owner.mutation(api.fields.create, { typeId, label: "Notes", kind: "text" });
	const input = { typeId, name: "Pipeline", filters: [], columns: ["name"] };
	const view = async () => (await member.query(api.databaseViews.list, { typeId }))[0]!;
	const id = await member.mutation(api.databaseViews.save, input);
	expect(await view()).not.toHaveProperty("layout");
	for (const groupBy of ["notes", "tags", "missing"])
		await expect(member.mutation(api.databaseViews.save, { ...input, viewId: id, version: 1, layout: "board", groupBy })).rejects.toThrow("choice field");
	await member.mutation(api.databaseViews.save, { ...input, viewId: id, version: 1, layout: "board", groupBy: "status" });
	expect(await view()).toMatchObject({ layout: "board", groupBy: "status", version: 2 });
	// COMPAT(0.1.0-alpha.8): alpha.7 apps save without `layout`; the board stays a board.
	await member.mutation(api.databaseViews.save, { ...input, viewId: id, version: 2, name: "Jobs board" });
	expect(await view()).toMatchObject({ name: "Jobs board", layout: "board", groupBy: "status", version: 3 });
	await member.mutation(api.databaseViews.save, { ...input, viewId: id, version: 3, layout: "table", groupBy: "status" });
	expect(await view()).not.toHaveProperty("layout");

	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
	const save = (patch: Record<string, unknown>) => t.mutation(internal.recordTools.saveViewFor, { turnId, input: { type: "Jobs", id, ...patch } });
	expect(await save({ version: 4, layout: "board", groupBy: "Status" })).toMatchObject({ layout: "board", groupBy: "status", version: 5 });
	expect(await save({ version: 5, name: "Renamed" })).toMatchObject({ layout: "board", groupBy: "status", version: 6 });
	expect(await save({ version: 6, groupBy: "Tags" })).toEqual({ error: expect.stringContaining("choice field") });
	expect(await save({ version: 6, groupBy: null })).toMatchObject({ layout: "board", version: 7 });
	expect(await view()).not.toHaveProperty("groupBy");
	const history = await member.query(api.records.activity, { paginationOpts: page });
	expect(history.page[0]).toMatchObject({ action: "view.updated", agent: "Companybot" });
});

it("lets alpha.7 save a board after its grouping field is deleted", async () => {
	const { owner } = await ownerAndMember();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	const field = await owner.mutation(api.fields.create, { typeId, label: "Status", kind: "choice", options: [{ label: "To do" }] });
	const config = { typeId, name: "Pipeline", columns: ["name"], filters: [] };
	const viewId = await owner.mutation(api.databaseViews.save, { ...config, layout: "board", groupBy: field.key });
	await owner.mutation(api.fields.archive, { fieldId: field._id });
	await owner.mutation(api.databaseViews.save, { ...config, viewId, version: 1, name: "Renamed" });
	const [saved] = await owner.query(api.databaseViews.list, { typeId });
	expect(saved).toMatchObject({ name: "Renamed", layout: "board", version: 2 });
	expect(saved).not.toHaveProperty("groupBy");
});

it("lists a board column on top of ten filters, checking the grouping field and option", async () => {
	const { owner } = await ownerAndMember();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	const status = await owner.mutation(api.fields.create, { typeId, label: "Status", kind: "choice", options: [{ label: "To do" }, { label: "Old" }] });
	await owner.mutation(api.fields.create, { typeId, label: "Tags", kind: "choice", options: [{ label: "Roof" }], multiple: true });
	const [todo, old] = status.options!.map((o) => o.id);
	for (const [name, value] of [["Open", todo], ["Legacy", old], ["Unsorted", null]] as const)
		await owner.mutation(api.records.create, { typeId, values: { name, ...(value && { status: value }) } });
	await owner.mutation(api.fields.update, { fieldId: status._id, options: [{ id: todo!, label: "To do" }] });
	const filters = Array.from({ length: 10 }, () => ({ field: "name", empty: false }));
	const column = async (option: string | null, field = "status") =>
		(await owner.query(api.records.list, { typeId, filters, group: { field, option }, paginationOpts: page })).page.map((r) => r.title);
	expect(await column(todo!)).toEqual(["Open"]);
	expect(await column(old!)).toEqual(["Legacy"]);
	expect(await column(null)).toEqual(["Unsorted"]);
	await expect(owner.query(api.records.list, { typeId, filters: [...filters, { field: "status", empty: true }], paginationOpts: page })).rejects.toThrow("up to 10 filters");
	await expect(column("missing")).rejects.toThrow("no such option");
	for (const field of ["name", "tags", "gone"]) await expect(column(null, field)).rejects.toThrow("choice field");
});
