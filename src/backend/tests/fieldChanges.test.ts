import { ownerAndMember, setMemberSwitch } from "./helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { memberOf } from "../convex/lib";
import { createRecord } from "../convex/recordOps";

// Changing a field's kind, one/several or linked database after it's made (fieldChanges.ts):
// values convert in batches in the background, reads stay sensible meanwhile, and undo puts back
// exactly what was there.

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

const page = { numItems: 50, cursor: null };

/** A Jobs database with a text field, as the owner. */
async function setup() {
	const { t, owner, member } = await ownerAndMember();
	const typeId = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
	const field = await owner.mutation(api.fields.create, { typeId, label: "Price", kind: "text" });
	const fieldOf = async (key = "price") => (await owner.query(api.recordTypes.list)).find((x) => x._id === typeId)!.fields.find((f) => f.key === key)!;
	/** Many records at once, through the same code the mutations use. */
	const seed = (values: Record<string, unknown>[]) =>
		t.run(async (ctx) => {
			const who = { member: (await memberOf(ctx, owner.userId, (await ctx.db.get(typeId))!.workspaceId))! };
			const ids: Id<"records">[] = [];
			for (const v of values) ids.push((await createRecord(ctx, who, typeId, v)).id);
			return ids;
		});
	const rows = async (filters: object[] = []) =>
		(await owner.query(api.records.list, { typeId, filters: filters as never, paginationOpts: page })).page;
	const valueOf = async (id: Id<"records">, key = "price") => (await owner.query(api.records.get, { recordId: id }))!.values[key];
	const finish = () => t.finishAllScheduledFunctions(vi.runAllTimers);
	const historyId = async () => (await owner.query(api.records.activity, { paginationOpts: page })).page.find((e) => e.action === "field.updated" && !e.undone)!._id;
	return { t, owner, member, typeId, fieldId: field._id, fieldOf, seed, rows, valueOf, finish, historyId };
}

describe("changing a field's kind", () => {
	it("previews, converts text to numbers, clears what doesn't parse, and undo brings it back", async () => {
		const { owner, fieldId, seed, valueOf, finish, historyId, rows } = await setup();
		const [a, b, c] = await seed([
			{ name: "A", price: "1,234" },
			{ name: "B", price: "$1,234.56" },
			{ name: "C", price: "n/a" },
			{ name: "D" },
		]);
		const preview = await owner.query(api.fields.preview, { fieldId, kind: "number" });
		expect(preview).toMatchObject({ checked: 3, converted: 2, cleared: 1, examples: ["n/a"], more: false, change: "Text → Number" });
		await owner.mutation(api.fields.update, { fieldId, kind: "number" });
		await finish();
		expect([await valueOf(a!), await valueOf(b!), await valueOf(c!)]).toEqual([1234, 1234.56, undefined]);
		// The index is rebuilt for the new kind: ranges work.
		expect((await rows([{ field: "price", gte: 1234.5 }])).map((r) => r.title)).toEqual(["B"]);
		const activity = (await owner.query(api.records.activity, { paginationOpts: page })).page[0]!;
		expect(activity).toMatchObject({ action: "field.updated", field: "Price", changes: [{ key: "kind", label: "Kind", old: "Text", new: "Number" }], fieldChange: { undoable: true, cleared: 1 } });
		await owner.mutation(api.records.undo, { historyId: await historyId() });
		await finish();
		expect([await valueOf(a!), await valueOf(b!), await valueOf(c!)]).toEqual(["1,234", "$1,234.56", "n/a"]);
		expect((await rows([{ field: "price", eq: "n/a" }])).map((r) => r.title)).toEqual(["C"]);
		const field = await owner.query(api.recordTypes.list);
		expect(field.flatMap((x) => x.fields).find((f) => f._id === fieldId)).toMatchObject({ kind: "text" });
	});

	it("makes choice options from distinct values and groups boards by them", async () => {
		const { owner, fieldId, seed, fieldOf, finish, rows } = await setup();
		await seed([{ name: "A", price: "Open" }, { name: "B", price: "open" }, { name: "C", price: "Won" }]);
		const preview = await owner.query(api.fields.preview, { fieldId, kind: "choice" });
		expect(preview).toMatchObject({ converted: 3, cleared: 0, options: ["Open", "Won"] });
		await owner.mutation(api.fields.update, { fieldId, kind: "choice" });
		await finish();
		const field = await fieldOf();
		expect(field.options?.map((o) => o.label)).toEqual(["Open", "Won"]);
		const open = field.options!.find((o) => o.label === "Open")!.id;
		expect((await rows([{ field: "price", in: [open] }])).map((r) => r.title).sort()).toEqual(["A", "B"]);
	});

	it("converts in batches in the background, locking the field and reading sensibly meanwhile", async () => {
		const { t, owner, fieldId, typeId, seed, fieldOf, valueOf, finish } = await setup();
		const ids = await seed(Array.from({ length: 230 }, (_, i) => ({ name: `R${i}`, price: String(i) })));
		await owner.mutation(api.fields.update, { fieldId, kind: "number" });
		expect(await fieldOf()).toMatchObject({ kind: "number", changing: true });
		// Not reached yet: converted as it's read, so it fits the new kind.
		expect(await valueOf(ids[200]!)).toBe(200);
		expect(await t.run(async (ctx) => (await ctx.db.get(ids[200]!))!.values.price)).toBe("200");
		await expect(owner.mutation(api.records.update, { recordId: ids[0]!, values: { price: 5 } })).rejects.toThrow("changing kind");
		await expect(owner.mutation(api.fields.update, { fieldId, label: "Cost" })).rejects.toThrow("still changing");
		await expect(owner.mutation(api.fields.update, { fieldId, kind: "text" })).rejects.toThrow("still changing");
		// One batch at a time.
		vi.runOnlyPendingTimers();
		await t.finishInProgressScheduledFunctions();
		expect(await owner.query(api.fields.changes, { fieldId })).toMatchObject({ running: { converted: 100, undoing: false } });
		await finish();
		expect(await fieldOf()).not.toHaveProperty("changing");
		expect(await owner.query(api.fields.changes, { fieldId })).toMatchObject({ running: null, last: { change: "Text → Number", converted: 230, cleared: 0, undoable: true } });
		expect(await t.run(async (ctx) => (await ctx.db.get(ids[229]!))!.values.price)).toBe(229);
		const indexRows = await t.run((ctx) => ctx.db.query("recordValues").withIndex("by_field_at", (q) => q.eq("fieldId", fieldId)).collect());
		expect(indexRows).toHaveLength(230);
		expect(indexRows.every((r) => typeof r.num === "number" && r.str === undefined)).toBe(true);
		// A failed run is started again by the sweep.
		expect(await t.run((ctx) => ctx.db.query("fieldChanges").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect())).toMatchObject([{ status: "done", counts: { checked: 230 } }]);
	});

	it("converts records in Archive too, and undo puts back values even where they were cleared", async () => {
		const { owner, fieldId, seed, finish, historyId, t } = await setup();
		const [a] = await seed([{ name: "A", price: "lots" }]);
		await owner.mutation(api.trash.move, { kind: "record", id: a! });
		await owner.mutation(api.fields.update, { fieldId, kind: "number" });
		await finish();
		expect(await t.run(async (ctx) => "price" in (await ctx.db.get(a!))!.values)).toBe(false);
		await owner.mutation(api.records.undo, { historyId: await historyId() });
		await finish();
		expect(await t.run(async (ctx) => (await ctx.db.get(a!))!.values.price)).toBe("lots");
	});

	it("keeps newer edits when undoing, converting them back by the same rules", async () => {
		const { owner, fieldId, seed, finish, historyId, valueOf } = await setup();
		const [a, b] = await seed([{ name: "A", price: "1,000" }, { name: "B", price: "2" }]);
		await owner.mutation(api.fields.update, { fieldId, kind: "number" });
		await finish();
		await owner.mutation(api.records.update, { recordId: a!, values: { price: 1500 } });
		await owner.mutation(api.records.undo, { historyId: await historyId() });
		await finish();
		expect([await valueOf(a!), await valueOf(b!)]).toEqual(["1500", "2"]);
	});

	it("keeps the first of several, wraps one into several, and undo restores all of them", async () => {
		const { owner, typeId, seed, finish, valueOf, historyId } = await setup();
		const tags = await owner.mutation(api.fields.create, { typeId, label: "Tags", kind: "choice", multiple: true, options: [{ label: "A" }, { label: "B" }] });
		const [r] = await seed([{ name: "R", tags: ["A", "B"] }]);
		const preview = await owner.query(api.fields.preview, { fieldId: tags._id, kind: "choice", multiple: false });
		expect(preview).toMatchObject({ converted: 1, partly: 1, examples: ["B"], change: "Holds several → holds one" });
		await owner.mutation(api.fields.update, { fieldId: tags._id, multiple: false });
		await finish();
		expect(await valueOf(r!, "tags")).toBe("a");
		await owner.mutation(api.records.undo, { historyId: await historyId() });
		await finish();
		expect(await valueOf(r!, "tags")).toEqual(["a", "b"]);
	});

	it("names people and linked records as text, and matches them back by name", async () => {
		const { owner, typeId, seed, finish, valueOf } = await setup();
		const who = await owner.mutation(api.fields.create, { typeId, label: "Lead", kind: "user" });
		const clients = (await owner.query(api.recordTypes.list)).find((x) => x.key === "client")!;
		const acme = await owner.mutation(api.records.create, { typeId: clients._id, values: { name: "Acme Roofing" } });
		const link = await owner.mutation(api.fields.create, { typeId, label: "Client", kind: "link", linkTypeId: clients._id });
		const [r] = await seed([{ name: "R", lead: owner.userId, client: acme }]);
		const name = (await owner.query(api.workspace.team))!.members.find((m) => m.userId === owner.userId)!;
		await owner.mutation(api.fields.update, { fieldId: who._id, kind: "text" });
		await owner.mutation(api.fields.update, { fieldId: link._id, kind: "text" });
		await finish();
		expect([await valueOf(r!, "lead"), await valueOf(r!, "client")]).toEqual([name.name || name.email, "Acme Roofing"]);
		await owner.mutation(api.fields.update, { fieldId: who._id, kind: "user" });
		await owner.mutation(api.fields.update, { fieldId: link._id, kind: "link", linkTypeId: clients._id });
		await finish();
		expect([await valueOf(r!, "lead"), await valueOf(r!, "client")]).toEqual([owner.userId, acme]);
	});

	it("drops filters, sorts and grouping that stop fitting from saved views, and says so", async () => {
		const { owner, typeId, fieldId, seed, finish } = await setup();
		const stage = await owner.mutation(api.fields.create, { typeId, label: "Stage", kind: "choice", options: [{ label: "New" }, { label: "Won" }] });
		await seed([{ name: "A", price: "5", stage: "New" }]);
		await owner.mutation(api.databaseViews.save, {
			typeId,
			name: "Board",
			filters: [{ field: "price", eq: "5" }, { field: "price", empty: false }],
			sort: { field: "price", order: "asc" },
			columns: ["name", "price"],
			layout: "board",
			groupBy: "stage",
		});
		await owner.mutation(api.fields.update, { fieldId, kind: "checkbox" });
		await owner.mutation(api.fields.update, { fieldId: stage._id, multiple: true });
		await finish();
		const [view] = await owner.query(api.databaseViews.list, { typeId });
		expect(view).toMatchObject({ filters: [{ field: "price", empty: false }], columns: ["name", "price"], layout: "board" });
		expect(view!.sort).toBeUndefined();
		expect(view!.groupBy).toBeUndefined();
		expect(view!.notice).toContain("“Stage” changed");
		// Dismissing the note clears it for everyone and leaves the view as saved.
		await owner.mutation(api.databaseViews.dismissNotice, { viewId: view!._id });
		const [after] = await owner.query(api.databaseViews.list, { typeId });
		expect(after!.notice).toBeUndefined();
		expect(after!.version).toBe(view!.version);
	});

	it("turns a text filter into the option it becomes, with no note", async () => {
		const { owner, typeId, fieldId, seed, finish } = await setup();
		await seed([{ name: "A", price: "Test" }, { name: "B", price: "Other" }]);
		await owner.mutation(api.databaseViews.save, { typeId, name: "Tests", filters: [{ field: "price", eq: "test" }], columns: ["name", "price"] });
		expect(((await owner.query(api.fields.preview, { fieldId, kind: "choice" })) as { views?: string[] } | null)?.views).toEqual([]);
		await owner.mutation(api.fields.update, { fieldId, kind: "choice" });
		await finish();
		const [view] = await owner.query(api.databaseViews.list, { typeId });
		const option = (await owner.query(api.recordTypes.list)).find((x) => x._id === typeId)!.fields.find((f) => f.key === "price")!.options!.find((o) => o.label === "Test")!;
		expect(view).toMatchObject({ filters: [{ field: "price", eq: option.id }] });
		expect(view!.notice).toBeUndefined();
		expect((await owner.query(api.records.list, { typeId, filters: view!.filters, paginationOpts: page })).page.map((r) => r.title)).toEqual(["A"]);
	});

	it("takes the databases switch and Edit in the database, and Name stays text", async () => {
		const { owner, member, fieldId, fieldOf } = await setup();
		await setMemberSwitch(owner, "fields.edit", false);
		await expect(member.mutation(api.fields.update, { fieldId, kind: "number" })).rejects.toThrow("Only people with the");
		await setMemberSwitch(owner, "fields.edit", true);
		const typeId = (await owner.query(api.recordTypes.list)).find((x) => x.plural === "Jobs")!._id;
		const memberRole = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!.id;
		await owner.mutation(api.recordTypes.setAccess, { typeId, access: [{ role: memberRole, level: "view" }] });
		await expect(member.mutation(api.fields.update, { fieldId, kind: "number" })).rejects.toThrow();
		const name = await fieldOf("name");
		await expect(owner.mutation(api.fields.update, { fieldId: name._id as Id<"recordFields">, kind: "number" })).rejects.toThrow("Name stays");
	});

	it("keeps old values for 30 days; after that the change can't be undone", async () => {
		const { t, owner, fieldId, seed, finish, historyId } = await setup();
		await seed([{ name: "A", price: "x" }]);
		await owner.mutation(api.fields.update, { fieldId, kind: "number" });
		await finish();
		const id = await historyId();
		vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.fieldChanges.sweep, {});
		await finish();
		expect(await t.run((ctx) => ctx.db.query("fieldChangeValues").collect())).toEqual([]);
		await expect(owner.mutation(api.records.undo, { historyId: id })).rejects.toThrow("too old");
	});
});
