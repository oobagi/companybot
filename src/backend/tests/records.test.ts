import { setup as ownerAndMember, signIn, modules } from "./helpers";
import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { getDocumentSize } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { legacyMemberOf } from "../convex/lib";
import { createRecord, updateRecord } from "../convex/recordOps";
import schema from "../convex/schema";

type As = Awaited<ReturnType<typeof signIn>>;

/** An owner and a member in one workspace, plus the built-in types by key. */
async function setup() {
	const { t, owner, member } = await ownerAndMember();
	const types = await owner.query(api.recordTypes.list);
	const type = (key: string) => types.find((t) => t.key === key)!;
	return { t, owner, member, client: type("client"), deal: type("deal"), task: type("task"), call: type("call") };
}

const page = { numItems: 50, cursor: null };

type List = FunctionReturnType<typeof api.records.list>;

const titles = async (as: As, args: Omit<FunctionArgs<typeof api.records.list>, "paginationOpts">) =>
	(await as.query(api.records.list, { ...args, paginationOpts: page })).page.map((r) => r.title);

describe("databases", () => {
	it("gives new workspaces clients, deals, tasks and calls, linked to each other", async () => {
		const { client, deal, task, call } = await setup();
		expect([client, deal, task, call].map((t) => t.plural)).toEqual(["Clients", "Deals", "Tasks", "Calls"]);
		expect(deal.fields.map((f) => f.key)).toEqual(["name", "client", "stage", "value", "close_date", "owner"]);
		expect(deal.fields.find((f) => f.key === "client")).toMatchObject({ kind: "link", linkType: client._id });
		expect(call.fields.find((f) => f.key === "deal")).toMatchObject({ kind: "link", linkType: deal._id });
		expect(task.fields.find((f) => f.key === "status")?.options?.map((o) => o.id)).toEqual(["to_do", "doing", "done"]);
	});

	it("lets only owners add databases, each starting with a name field", async () => {
		const { owner, member } = await setup();
		await expect(member.mutation(api.recordTypes.create, { name: "Job", plural: "Jobs" })).rejects.toThrow("permission");
		await owner.mutation(api.recordTypes.create, { name: "Job", plural: "Jobs" });
		await expect(owner.mutation(api.recordTypes.create, { name: "job", plural: "jobs" })).rejects.toThrow("already");
		const jobs = (await member.query(api.recordTypes.list)).find((t) => t.key === "job")!;
		expect(jobs.fields.map((f) => [f.key, f.label])).toEqual([["name", "Name"]]);
	});

	it("seeds workspaces from before records through a migration, without duplicating", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		await t.run(async (ctx) => {
			for (const table of ["recordTypes", "recordFields"] as const)
				for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
			const client = await ctx.db.insert("recordTypes", {
				workspaceId: (await ctx.db.query("workspaces").first())!._id,
				key: "client",
				name: "Client",
				plural: "Clients",
				archived: false,
				createdBy: owner.userId,
				updatedAt: 0,
			});
			return client;
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const types = await owner.query(api.recordTypes.list);
		expect(types.map((t) => t.key)).toEqual(["client", "deal", "task", "call"]);
		expect(types.find((t) => t.key === "deal")!.fields.find((f) => f.key === "client")?.linkType).toBe(types[0]!._id);
	});
});

describe("records", () => {
	it("creates records with checked values and shows links and people by name", async () => {
		const { owner, member, client, deal } = await setup();
		const acme = await member.mutation(api.records.create, {
			typeId: client._id,
			values: { name: " Acme Roofing ", email: "Hi@Acme.com", website: "acme.com", status: "lead", owner: owner.userId },
		});
		const dealId = await member.mutation(api.records.create, {
			typeId: deal._id,
			values: { name: "Acme reroof", client: acme, stage: "Proposal", value: "$12,500.499" },
		});
		const got = (await owner.query(api.records.get, { recordId: dealId }))!;
		expect(got.title).toBe("Acme reroof");
		expect(got.values).toEqual({ name: "Acme reroof", client: acme, stage: "proposal", value: { minor: 1_250_050, currency: "USD" } });
		expect(got.refs).toEqual({ [acme]: { name: "Acme Roofing" } });
		expect(got.type.key).toBe("deal");
		const acmeRow = (await owner.query(api.records.get, { recordId: acme }))!;
		expect(acmeRow.values).toMatchObject({ email: "hi@acme.com", website: "https://acme.com/", status: "lead" });
		expect(acmeRow.refs[owner.userId]).toEqual({ name: "owner@co.com" });
	});

	it("refuses bad values, unknown fields and missing names", async () => {
		const { owner, client, deal } = await setup();
		const create = (typeId: Id<"recordTypes">, values: Record<string, unknown>) => owner.mutation(api.records.create, { typeId, values });
		await expect(create(client._id, { email: "x@co.com" })).rejects.toThrow("Give the client a name");
		await expect(create(client._id, { name: "A", email: "nope" })).rejects.toThrow("email address");
		await expect(create(client._id, { name: "A", roof: "flat" })).rejects.toThrow("no field “roof”");
		await expect(create(client._id, { name: "A", status: "Gone" })).rejects.toThrow("one of: Lead, Active, Past");
		await expect(create(deal._id, { name: "D", close_date: "2026-02-30" })).rejects.toThrow("date");
		const task = await create(deal._id, { name: "Not a client" });
		await expect(create(deal._id, { name: "D", client: task })).rejects.toThrow("doesn't exist");
	});

	it("refuses links and people from other workspaces, and hides records across workspaces", async () => {
		const { t, owner, client, deal } = await setup();
		const outsider = await signIn(t, "outsider@else.com");
		const theirs = await outsider.mutation(api.records.create, {
			typeId: (await outsider.query(api.recordTypes.list))[0]!._id,
			values: { name: "Theirs" },
		});
		await expect(owner.mutation(api.records.create, { typeId: deal._id, values: { name: "D", client: theirs } })).rejects.toThrow(
			"doesn't exist",
		);
		await expect(owner.mutation(api.records.create, { typeId: client._id, values: { name: "C", owner: outsider.userId } })).rejects.toThrow(
			"isn't in this workspace",
		);
		await expect(outsider.mutation(api.records.create, { typeId: client._id, values: { name: "X" } })).rejects.toThrow("not found");
		const mine = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Mine" } });
		expect(await outsider.query(api.records.get, { recordId: mine })).toBeNull();
		expect((await outsider.query(api.records.list, { typeId: client._id, paginationOpts: page })).page).toEqual([]);
		await expect(outsider.mutation(api.records.update, { recordId: mine, values: { name: "Hacked" } })).rejects.toThrow("not found");
	});

	it("changes only the fields given, and logs who changed what from old to new", async () => {
		const { owner, member, client } = await setup();
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", phone: "555-123-4567" } });
		await member.mutation(api.records.update, { recordId: id, values: { status: "active" } });
		await member.mutation(api.records.update, { recordId: id, values: { status: "active" } });
		await owner.mutation(api.records.update, { recordId: id, values: { phone: null, name: "Acme Inc" } });
		expect((await owner.query(api.records.get, { recordId: id }))!.values).toEqual({ name: "Acme Inc", status: "active" });
		const history = (await owner.query(api.records.history, { recordId: id, paginationOpts: page })).page;
		expect(history.map((e) => [e.action, e.user])).toEqual([
			["updated", "owner@co.com"],
			["updated", "member@co.com"],
			["created", "owner@co.com"],
		]);
		expect(history[0]!.changes).toEqual([
			{ key: "name", old: "Acme", new: "Acme Inc", label: "Name" },
			{ key: "phone", old: "555-123-4567", label: "Phone" },
		]);
		expect(history[1]!.changes).toEqual([{ key: "status", new: "active", label: "Status" }]);
		await expect(owner.mutation(api.records.update, { recordId: id, values: { name: "" } })).rejects.toThrow("needs a name");
	});

	it("records which agent made a change, and for whom", async () => {
		const { t, owner, client } = await setup();
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		const agentId = (await owner.query(api.agents.list)).find((a) => a.name === "Companybot")!._id;
		await t.run(async (ctx) => updateRecord(ctx, { member: (await legacyMemberOf(ctx, owner.userId))!, agentId }, id, { status: "Active" }));
		const [latest] = (await owner.query(api.records.history, { recordId: id, paginationOpts: page })).page;
		expect(latest).toMatchObject({ user: "owner@co.com", agent: "Companybot" });
		expect((await t.run((ctx) => ctx.db.get(id)))!.updatedByAgent).toBe(agentId);
		const activity = (await owner.query(api.records.activity, { paginationOpts: page })).page;
		expect(activity[0]).toMatchObject({ action: "updated", record: "Acme", type: "Client", agent: "Companybot" });
	});

	it("undoes a change, unless what it changed has changed again", async () => {
		const { owner, member, client } = await setup();
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", status: "lead" } });
		const history = async () => (await owner.query(api.records.history, { recordId: id, paginationOpts: page })).page;
		await owner.mutation(api.records.update, { recordId: id, values: { status: "active", email: "a@acme.com" } });
		const change = (await history())[0]!;
		await member.mutation(api.records.undo, { historyId: change._id });
		expect((await owner.query(api.records.get, { recordId: id }))!.values).toEqual({ name: "Acme", status: "lead" });
		const [undo, undone] = await history();
		expect(undo).toMatchObject({ action: "updated", undoes: change._id, user: "member@co.com" });
		expect(undone!.undone).toBe(true);
		await expect(owner.mutation(api.records.undo, { historyId: change._id })).rejects.toThrow("already undone");

		await owner.mutation(api.records.update, { recordId: id, values: { status: "past" } });
		const stale = (await history())[0]!;
		await owner.mutation(api.records.update, { recordId: id, values: { status: "active" } });
		await expect(owner.mutation(api.records.undo, { historyId: stale._id })).rejects.toThrow("“Status” has changed since");

		const created = (await history()).at(-1)!;
		await owner.mutation(api.records.undo, { historyId: created._id });
		expect((await owner.query(api.records.get, { recordId: id }))!.archived).toBe(true);
	});

	it("archives records out of lists, filters and links, and restores them", async () => {
		const { owner, client, deal } = await setup();
		const acme = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", status: "active" } });
		const dealId = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Reroof", client: acme } });
		await owner.mutation(api.records.archive, { recordId: dealId });
		expect(await titles(owner, { typeId: deal._id })).toEqual([]);
		expect(await titles(owner, { typeId: deal._id, archived: true })).toEqual(["Reroof"]);
		expect((await owner.query(api.records.linked, { recordId: acme, paginationOpts: page })).page).toEqual([]);
		await expect(owner.mutation(api.records.update, { recordId: dealId, values: { name: "X" } })).rejects.toThrow("Restore it");

		await owner.mutation(api.records.restore, { recordId: dealId });
		expect(await titles(owner, { typeId: deal._id })).toEqual(["Reroof"]);
		expect((await owner.query(api.records.linked, { recordId: acme, paginationOpts: page })).page.map((r) => r.title)).toEqual(["Reroof"]);
		const actions = (await owner.query(api.records.history, { recordId: dealId, paginationOpts: page })).page.map((e) => e.action);
		expect(actions).toEqual(["restored", "archived", "created"]);
		await owner.mutation(api.records.archive, { recordId: acme });
		await expect(owner.mutation(api.records.create, { typeId: deal._id, values: { name: "New", client: acme } })).rejects.toThrow(
			"doesn't exist",
		);
	});

	it("filters and sorts by any field through the index, a page at a time", async () => {
		const { owner, client, deal } = await setup();
		const acme = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		const bolt = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "bolt" } });
		const deals = [
			{ name: "A", stage: "won", value: 500, close_date: "2026-03-01", client: acme },
			{ name: "B", stage: "new", value: 1500, close_date: "2026-01-15", client: bolt },
			{ name: "C", stage: "won", value: 50, client: acme },
			{ name: "D", stage: "lost" },
		];
		for (const values of deals) await owner.mutation(api.records.create, { typeId: deal._id, values });

		expect(await titles(owner, { typeId: deal._id })).toEqual(["D", "C", "B", "A"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "stage", eq: "Won" }] })).toEqual(["C", "A"]);
		expect(await titles(owner, { typeId: deal._id, sort: { field: "value", order: "asc" } })).toEqual(["C", "A", "B"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "value", gte: 100, lte: 1000 }] })).toEqual(["A"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "close_date", gte: "2026-02-01" }] })).toEqual(["A"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "client", eq: acme }] })).toEqual(["C", "A"]);
		expect(await titles(owner, { typeId: client._id, sort: { field: "name", order: "asc" } })).toEqual(["Acme", "bolt"]);

		await owner.mutation(api.records.update, { recordId: acme, values: { status: "active" } });
		expect(await titles(owner, { typeId: client._id, sort: { field: "updatedAt", order: "desc" } })).toEqual(["Acme", "bolt"]);

		const first = await owner.query(api.records.list, { typeId: deal._id, sort: { field: "value", order: "desc" }, paginationOpts: { numItems: 2, cursor: null } });
		expect(first.page.map((r) => r.title)).toEqual(["B", "A"]);
		const second = await owner.query(api.records.list, {
			typeId: deal._id,
			sort: { field: "value", order: "desc" },
			paginationOpts: { numItems: 2, cursor: first.continueCursor },
		});
		expect(second.page.map((r) => r.title)).toEqual(["C"]);

		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "stage", eq: "won" }], sort: { field: "value", order: "asc" } })).toEqual(["C", "A"]);
		await expect(titles(owner, { typeId: deal._id, sort: { field: "client", order: "asc" } })).rejects.toThrow("can't be sorted");
		await expect(titles(owner, { typeId: deal._id, filters: [{ field: "nope", eq: 1 }] })).rejects.toThrow("no field");
	});

	it("lists what links to a record, optionally through one field", async () => {
		const { owner, client, deal, task } = await setup();
		const acme = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Reroof", client: acme } });
		await owner.mutation(api.records.create, { typeId: task._id, values: { name: "Call Acme", client: acme } });
		const all = (await owner.query(api.records.linked, { recordId: acme, paginationOpts: page })).page;
		expect(all.map((r) => r.title).sort()).toEqual(["Call Acme", "Reroof"]);
		const fieldId = deal.fields.find((f) => f.key === "client")!._id;
		const deals = (await owner.query(api.records.linked, { recordId: acme, fieldId, paginationOpts: page })).page;
		expect(deals.map((r) => r.title)).toEqual(["Reroof"]);
	});

	it("searches titles and text values", async () => {
		const { owner, client } = await setup();
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme Roofing", address: "12 Main St" } });
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Bolt Electric" } });
		expect((await owner.query(api.records.search, { query: "roofing" })).map((r) => r.title)).toEqual(["Acme Roofing"]);
		expect((await owner.query(api.records.search, { query: "main", typeId: client._id })).map((r) => r.title)).toEqual(["Acme Roofing"]);
		// Rows like a list's, so the app can show them in the same table.
		expect((await owner.query(api.records.search, { query: "roofing" }))[0]).toMatchObject({ values: { name: "Acme Roofing" }, refs: {} });
	});

	it("lists the chat messages that reference a record, only where you can see them", async () => {
		const { t, owner, member, client } = await setup();
		const outsider = await signIn(t, "outsider@else.com");
		const acme = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		const general = (await owner.query(api.chats.list))!.channels[0]!._id;
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const mentions = { userIds: [], agentIds: [], recordIds: [acme] };
		await owner.mutation(api.messages.send, { chatId: general, text: "Acme signed!", mentions });
		await owner.mutation(api.messages.send, { chatId: secret, text: "Acme is late paying", mentions });
		expect((await owner.query(api.records.discussion, { recordId: acme })).map((m) => m.text)).toEqual(["Acme is late paying", "Acme signed!"]);
		expect((await member.query(api.records.discussion, { recordId: acme })).map((m) => m.text)).toEqual(["Acme signed!"]);
		expect(await outsider.query(api.records.discussion, { recordId: acme })).toEqual([]);

		// Records from other workspaces are dropped, not stored.
		const outsiderChat = (await outsider.query(api.chats.list))!.channels[0]!._id;
		await outsider.mutation(api.messages.send, { chatId: outsiderChat, text: "Sneaky", mentions });
		expect(await t.run(async (ctx) => (await ctx.db.query("recordMentions").collect()).length)).toBe(2);
	});
});

describe("fields", () => {
	it("lets anyone add a field, then set, filter and sort by it", async () => {
		const { member, client } = await setup();
		const roof = await member.mutation(api.fields.create, {
			typeId: client._id,
			label: "Roof type",
			kind: "choice",
			options: [{ label: "Shingle" }, { label: "Metal" }, { label: "Flat / TPO" }],
		});
		expect(roof).toMatchObject({ key: "roof_type", options: [{ id: "shingle" }, { id: "metal" }, { id: "flat_tpo" }] });
		const retainer = await member.mutation(api.fields.create, { typeId: client._id, label: "Monthly retainer", kind: "currency" });
		await member.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", roof_type: "Metal", monthly_retainer: 900 } });
		await member.mutation(api.records.create, { typeId: client._id, values: { name: "Bolt", roof_type: "shingle", monthly_retainer: 1200 } });
		expect(await titles(member, { typeId: client._id, filters: [{ field: "roof_type", eq: "metal" }] })).toEqual(["Acme"]);
		expect(await titles(member, { typeId: client._id, sort: { field: retainer.key, order: "desc" } })).toEqual(["Bolt", "Acme"]);
		await expect(member.mutation(api.fields.create, { typeId: client._id, label: "roof TYPE", kind: "text" })).rejects.toThrow("already");
		await expect(member.mutation(api.fields.create, { typeId: client._id, label: "Size", kind: "choice" })).rejects.toThrow("at least one option");
		await expect(member.mutation(api.fields.create, { typeId: client._id, label: "Parent", kind: "link" })).rejects.toThrow("Pick the database");
	});

	it("lets people change fields they added; owners change any", async () => {
		const { owner, member, client } = await setup();
		const status = client.fields.find((f) => f.key === "status")!;
		await expect(member.mutation(api.fields.update, { fieldId: status._id, label: "Stage" })).rejects.toThrow("Only the person who made this");
		const mine = await member.mutation(api.fields.create, { typeId: client._id, label: "Gate code", kind: "text" });
		await member.mutation(api.fields.update, { fieldId: mine._id, label: "Gate" });
		await owner.mutation(api.fields.update, { fieldId: status._id, label: "Stage" });
		const fields = (await member.query(api.recordTypes.list)).find((t) => t.key === "client")!.fields;
		expect(fields.find((f) => f._id === mine._id)).toMatchObject({ key: "gate_code", label: "Gate", canEdit: true });
		expect(fields.find((f) => f._id === status._id)).toMatchObject({ label: "Stage", canEdit: false });
	});

	it("keeps values when options are renamed, and retires removed options instead of deleting them", async () => {
		const { owner, client } = await setup();
		const status = client.fields.find((f) => f.key === "status")!;
		const live = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", status: "Active" } });
		const archived = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Bolt", status: "lead" } });
		await owner.mutation(api.records.archive, { recordId: archived });
		await owner.mutation(api.fields.update, { fieldId: status._id, options: [{ id: "active", label: "Current" }] });
		expect((await owner.query(api.records.get, { recordId: live }))!.values.status).toBe("active");
		const options = (await owner.query(api.recordTypes.list)).find((t) => t.key === "client")!.fields.find((f) => f.key === "status")!.options;
		expect(options).toEqual([
			{ id: "active", label: "Current" },
			{ id: "lead", label: "Lead", retired: true },
			{ id: "past", label: "Past", retired: true },
		]);

		// Retired options can't be set, but records keep them and can still be found by them,
		// including ones that were archived when the option was removed.
		await expect(owner.mutation(api.records.update, { recordId: live, values: { status: "lead" } })).rejects.toThrow("one of: Current");
		await owner.mutation(api.records.restore, { recordId: archived });
		expect((await owner.query(api.records.get, { recordId: archived }))!.values.status).toBe("lead");
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "status", eq: "Lead" }] })).toEqual(["Bolt"]);

		// Sending it back, by label, brings back the same option.
		await owner.mutation(api.fields.update, { fieldId: status._id, options: [{ id: "active", label: "Current" }, { label: "Lead" }] });
		await owner.mutation(api.records.update, { recordId: live, values: { status: "Lead" } });
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "status", eq: "lead" }] })).toEqual(["Bolt", "Acme"]);
	});

	it("archives fields without losing values, and keeps the name field", async () => {
		const { owner, client } = await setup();
		const website = client.fields.find((f) => f.key === "website")!;
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", website: "acme.com" } });
		await owner.mutation(api.fields.archive, { fieldId: website._id });
		await expect(owner.mutation(api.records.update, { recordId: id, values: { website: "b.com" } })).rejects.toThrow("no field");
		expect((await owner.query(api.records.get, { recordId: id }))!.fields.map((f) => f.key)).not.toContain("website");
		await owner.mutation(api.fields.restore, { fieldId: website._id });
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "website", eq: "https://acme.com/" }] })).toEqual(["Acme"]);
		const name = client.fields.find((f) => f.key === "name")!;
		await expect(owner.mutation(api.fields.archive, { fieldId: name._id })).rejects.toThrow("needs a name");
		const actions = (await owner.query(api.records.activity, { paginationOpts: page })).page.map((e) => [e.action, e.field]);
		expect(actions.slice(0, 2)).toEqual([
			["field.restored", "Website"],
			["field.archived", "Website"],
		]);
	});

	it("holds several values in multi fields, matching any one", async () => {
		const { owner, client } = await setup();
		await owner.mutation(api.fields.create, {
			typeId: client._id,
			label: "Tags",
			kind: "choice",
			multiple: true,
			options: [{ label: "VIP" }, { label: "Slow payer" }],
		});
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme", tags: ["VIP", "slow_payer", "vip"] } });
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Bolt", tags: "VIP" } });
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "tags", eq: "slow payer" }] })).toEqual(["Acme"]);
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "tags", eq: "vip" }] })).toEqual(["Bolt", "Acme"]);
		await expect(titles(owner, { typeId: client._id, sort: { field: "tags", order: "asc" } })).rejects.toThrow("can't be sorted");
		// A range over one record's several values would list it on several pages.
		await expect(titles(owner, { typeId: client._id, filters: [{ field: "tags", gte: "a", lte: "z" }] })).rejects.toThrow("Ranges work on");
	});
});

// Found in review of #28; each was reproduced before the fix.
describe("records: limits and edge cases", () => {
	const latest = async (as: As, recordId: Id<"records">) =>
		(await as.query(api.records.history, { recordId, paginationOpts: page })).page[0]!;

	it("checks undo against the fields, options and links as they are now", async () => {
		const { owner, member, client, deal } = await setup();
		const status = client.fields.find((f) => f.key === "status")!;
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "C", status: "lead", phone: "5551234567" } });
		await owner.mutation(api.records.update, { recordId: id, values: { status: "active" } });
		const statusChange = await latest(owner, id);
		await owner.mutation(api.fields.update, { fieldId: status._id, options: [{ id: "active", label: "Active" }] });
		await expect(owner.mutation(api.records.undo, { historyId: statusChange._id })).rejects.toThrow("one of: Active");

		await owner.mutation(api.records.update, { recordId: id, values: { phone: "5557654321" } });
		const phoneChange = await latest(owner, id);
		await owner.mutation(api.fields.archive, { fieldId: client.fields.find((f) => f.key === "phone")!._id });
		await expect(member.mutation(api.records.undo, { historyId: phoneChange._id })).rejects.toThrow("no field");

		const d = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "D", client: id } });
		await owner.mutation(api.records.update, { recordId: d, values: { client: null } });
		const unlink = await latest(owner, d);
		await owner.mutation(api.records.archive, { recordId: id });
		await expect(owner.mutation(api.records.undo, { historyId: unlink._id })).rejects.toThrow("doesn't exist");
		expect((await owner.query(api.records.get, { recordId: d }))!.values.client).toBeUndefined();
	});

	it("treats links to an archived record as gone, without rewriting them", async () => {
		const { owner, client, deal } = await setup();
		const c = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "C" } });
		const d = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "D", client: c } });
		await owner.mutation(api.records.archive, { recordId: c });
		const got = (await owner.query(api.records.get, { recordId: d }))!;
		expect(got.values.client).toBe(c);
		expect(got.refs[c]).toEqual({ name: "C", archived: true });
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "client", eq: c }] })).toEqual([]);
		expect((await owner.query(api.records.linked, { recordId: c, paginationOpts: page })).page).toEqual([]);

		await owner.mutation(api.records.restore, { recordId: c });
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "client", eq: c }] })).toEqual(["D"]);
		expect((await owner.query(api.records.get, { recordId: d }))!.refs[c]).toEqual({ name: "C" });
	});

	it("matches long text exactly, not by its first characters", async () => {
		const { owner, client } = await setup();
		const long = "a".repeat(100);
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: `${long}FIRST` } });
		await owner.mutation(api.records.create, { typeId: client._id, values: { name: `${long}SECOND` } });
		expect(await titles(owner, { typeId: client._id, filters: [{ field: "name", eq: `${long}first` }] })).toEqual([`${long}FIRST`]);
		expect(await titles(owner, { typeId: client._id, sort: { field: "name", order: "asc" } })).toHaveLength(2);
	});

	it("lists a full page of records with many links inside transaction limits", async () => {
		const { owner, client, deal } = await setup();
		await owner.mutation(api.fields.create, { typeId: deal._id, label: "Contacts", kind: "link", multiple: true, linkTypeId: client._id });
		const ids: Id<"records">[] = [];
		for (let n = 0; n < 50; n++) ids.push(await owner.mutation(api.records.create, { typeId: client._id, values: { name: `C${n}` } }));
		for (let n = 0; n < 82; n++) await owner.mutation(api.records.create, { typeId: deal._id, values: { name: `D${n}`, contacts: ids } });
		const first = await owner.query(api.records.list, { typeId: deal._id, paginationOpts: { numItems: 100, cursor: null } });
		expect(first.page).toHaveLength(50);
		expect(Object.keys(first.page[0]!.refs)).toHaveLength(50);
		const second = await owner.query(api.records.list, { typeId: deal._id, paginationOpts: { numItems: 100, cursor: first.continueCursor } });
		expect(second.page).toHaveLength(32);
	});

	it("leaves names past a page's read budget for records.refs", async () => {
		const { owner, client, deal } = await setup();
		await owner.mutation(api.fields.create, { typeId: deal._id, label: "Contacts", kind: "link", multiple: true, linkTypeId: client._id });
		const ids: Id<"records">[] = [];
		for (let n = 0; n < 250; n++) ids.push(await owner.mutation(api.records.create, { typeId: client._id, values: { name: `C${n}` } }));
		for (let n = 0; n < 5; n++)
			await owner.mutation(api.records.create, { typeId: deal._id, values: { name: `D${n}`, contacts: ids.slice(n * 50, n * 50 + 50) } });
		const rows = (await owner.query(api.records.list, { typeId: deal._id, paginationOpts: page })).page;
		const unresolved = rows.flatMap((r) => r.unresolved);
		expect(unresolved).toHaveLength(50);
		expect(rows.flatMap((r) => Object.keys(r.refs))).toHaveLength(200);
		const refs = await owner.query(api.records.refs, { ids: unresolved });
		expect(Object.keys(refs)).toHaveLength(50);
	});

	it("caps a record's size so it and its history stay under the document limit", async () => {
		const { t, owner, client } = await setup();
		const fields: FunctionReturnType<typeof api.fields.create>[] = [];
		for (let n = 0; n < 14; n++) fields.push(await owner.mutation(api.fields.create, { typeId: client._id, label: `Long ${n}`, kind: "text" }));
		const fill = (count: number, char: string) => Object.fromEntries(fields.slice(0, count).map((f) => [f.key, char.repeat(10_000)]));
		await expect(owner.mutation(api.records.create, { typeId: client._id, values: { name: "Big", ...fill(14, "a") } })).rejects.toThrow(
			"too big",
		);
		const id = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Big", ...fill(12, "a") } });
		await expect(owner.mutation(api.records.update, { recordId: id, values: fill(14, "b") })).rejects.toThrow("too big");
		await owner.mutation(api.records.update, { recordId: id, values: fill(12, "b") });
		const sizes = await t.run(async (ctx) => ({
			record: getDocumentSize((await ctx.db.get(id))!),
			history: getDocumentSize((await ctx.db.query("recordHistory").withIndex("by_record", (q) => q.eq("recordId", id)).order("desc").first())!),
		}));
		expect(sizes.history).toBeGreaterThan(2 * 100_000);
		expect(sizes.history).toBeLessThan(1_048_576 / 2);
		expect(sizes.record).toBeLessThan(1_048_576 / 4);
	});

	it("stores amounts in their smallest unit and lets owners set the workspace's currency", async () => {
		const { owner, member, deal } = await setup();
		const id = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "D", value: 1.005 } });
		expect((await owner.query(api.records.get, { recordId: id }))!.values.value).toEqual({ minor: 101, currency: "USD" });
		await expect(owner.mutation(api.records.update, { recordId: id, values: { value: Number.MAX_VALUE } })).rejects.toThrow("amount");
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "value", gte: "1.01", lte: 1.01 }] })).toEqual(["D"]);

		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings).toMatchObject({ currency: "USD", hasAmounts: true });
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, currency: "eur", expectedVersion: settings.version });
		expect((await member.query(api.workspace.settings))!.currency).toBe("EUR");
		const next = (await owner.query(api.workspace.settings))!;
		for (const currency of ["euro", "XYZ"])
			await expect(owner.mutation(api.workspace.updateSettings, { name: next.name, currency, expectedVersion: next.version })).rejects.toThrow(
				"currency code",
			);
		await expect(member.mutation(api.workspace.updateSettings, { name: next.name, currency: "GBP", expectedVersion: next.version })).rejects.toThrow(
			"permission",
		);
	});

	it("keeps each amount's own currency when the workspace's changes", async () => {
		const { owner, deal } = await setup();
		expect((await owner.query(api.workspace.settings))!.hasAmounts).toBe(false);
		const old = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Old", value: 100 } });
		const settings = (await owner.query(api.workspace.settings))!;
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, currency: "EUR", expectedVersion: settings.version });
		const fresh = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "New", value: 100 } });
		const yen = await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Yen", value: "JPY 5000" } });
		const value = async (recordId: Id<"records">) => (await owner.query(api.records.get, { recordId }))!.values.value;
		expect(await value(old)).toEqual({ minor: 10000, currency: "USD" });
		expect(await value(fresh)).toEqual({ minor: 10000, currency: "EUR" });
		expect(await value(yen)).toEqual({ minor: 5000, currency: "JPY" });

		// Filters compare within one currency: the workspace's unless they name one.
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "value", eq: 100 }] })).toEqual(["New"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "value", gte: "USD 0" }] })).toEqual(["Old"]);
		expect(await titles(owner, { typeId: deal._id, filters: [{ field: "value", eq: "JPY 5000" }] })).toEqual(["Yen"]);
		await expect(titles(owner, { typeId: deal._id, filters: [{ field: "value", gte: "USD 0", lte: "EUR 500" }] })).rejects.toThrow("one currency");
		// Sorting groups by currency code, then amount.
		await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Big", value: "USD 900" } });
		expect(await titles(owner, { typeId: deal._id, sort: { field: "value", order: "asc" } })).toEqual(["New", "Yen", "Old", "Big"]);

		// History and undo keep the currency code.
		await owner.mutation(api.records.update, { recordId: old, values: { value: 250 } });
		const [change] = (await owner.query(api.records.history, { recordId: old, paginationOpts: page })).page;
		expect(change!.changes).toEqual([
			{ key: "value", old: { minor: 10000, currency: "USD" }, new: { minor: 25000, currency: "EUR" }, label: "Value" },
		]);
		await owner.mutation(api.records.undo, { historyId: change!._id });
		expect(await value(old)).toEqual({ minor: 10000, currency: "USD" });
	});
});

describe("records: combined filters", () => {
	it("refuses filters that can't be answered", async () => {
		const { owner, task } = await setup();
		const list = (filters: FunctionArgs<typeof api.records.list>["filters"]) => titles(owner, { typeId: task._id, filters });
		await expect(list([{ field: "status", eq: "done", empty: true }])).rejects.toThrow("one condition");
		await expect(list([{ field: "name", in: ["a"] }])).rejects.toThrow("Any of");
		await expect(list([{ field: "name", gte: "a" }])).rejects.toThrow("Ranges work on");
		await expect(list(Array.from({ length: 11 }, () => ({ field: "status", eq: "done" })))).rejects.toThrow("up to 10");
		await expect(titles(owner, { typeId: task._id, filters: [{ field: "due", empty: true }], sort: { field: "due", order: "asc" } })).resolves.toEqual([]);
	});
});

describe("records: list edge cases", () => {
	/** Values near the size limit: three big text fields plus a big name. */
	async function bigValues(owner: As, typeId: Id<"recordTypes">) {
		const keys = [];
		for (let i = 0; i < 3; i++) keys.push((await owner.mutation(api.fields.create, { typeId, label: `Big ${i}`, kind: "text" })).key);
		return { name: "界".repeat(10_000), ...Object.fromEntries(keys.map((k) => [k, "界".repeat(10_000)])) };
	}
	const seed = async (t: ReturnType<typeof convexTest>, userId: Id<"users">, typeId: Id<"recordTypes">, values: Record<string, unknown>[]) =>
		t.run(async (ctx) => {
			const who = { member: (await legacyMemberOf(ctx, userId))! };
			const ids = [];
			for (const v of values) ids.push((await createRecord(ctx, who, typeId, v)).id);
			return ids;
		});

	it("keeps an older match from a short 'any of' stream behind a full one", async () => {
		const { t, owner, task } = await setup();
		await seed(t, owner.userId, task._id, [
			{ name: "older match", status: "to_do", due: "2026-01-01" },
			...Array.from({ length: 51 }, (_, i) => ({ name: `newer ${i}`, status: "done" })),
		]);
		const got = await owner.query(api.records.list, {
			typeId: task._id,
			filters: [{ field: "status", in: ["done", "to_do"] }, { field: "due", empty: false }],
			paginationOpts: page,
		});
		expect(got.page.map((r) => r.title)).toEqual(["older match"]);
		expect(got.isDone).toBe(true);
	});

	it("stops reading big records before the byte limit and says to go on", { timeout: 120_000 }, async () => {
		const { t, owner, task } = await setup();
		const big = await bigValues(owner, task._id);
		for (let batch = 0; batch < 4; batch++) await seed(t, owner.userId, task._id, Array.from({ length: 25 }, () => ({ ...big, due: "2026-01-01" })));
		const first = await owner.query(api.records.list, { typeId: task._id, filters: [{ field: "due", empty: true }], paginationOpts: page });
		expect(first).toMatchObject({ page: [], isDone: false });
		let cursor: string | null = first.continueCursor;
		let requests = 1;
		for (;;) {
			const next: List = await owner.query(api.records.list, { typeId: task._id, filters: [{ field: "due", empty: true }], paginationOpts: { numItems: 50, cursor } });
			requests++;
			expect(next.page).toEqual([]);
			if (next.isDone) break;
			cursor = next.continueCursor;
		}
		expect(requests).toBeGreaterThan(2);
	});

	it("checks link filter targets within the budget, however big they are", { timeout: 120_000 }, async () => {
		const { t, owner, client, deal } = await setup();
		const big = await bigValues(owner, client._id);
		const ids: Id<"records">[] = [];
		for (let batch = 0; batch < 5; batch++) ids.push(...(await seed(t, owner.userId, client._id, Array.from({ length: 20 }, () => big))));
		await seed(t, owner.userId, deal._id, [{ name: "Linked", client: ids[60] }]);
		const got = await owner.query(api.records.list, {
			typeId: deal._id,
			filters: [{ field: "client", in: ids.slice(0, 50) }, { field: "client", in: ids.slice(50) }],
			paginationOpts: page,
		});
		expect(got.page).toEqual([]);
		const one = await owner.query(api.records.list, { typeId: deal._id, filters: [{ field: "client", in: ids.slice(50) }], paginationOpts: page });
		expect(one.page.map((r) => r.title)).toEqual(["Linked"]);
	});

	it("stays within limits with the most filters allowed", async () => {
		const { owner, deal } = await setup();
		const fake = (i: number) => `${"k".repeat(31)}${i}`;
		const filters = Array.from({ length: 10 }, (_, f) => ({ field: f % 2 ? "client" : "owner", in: Array.from({ length: 50 }, (_, i) => fake(f * 50 + i)) }));
		const got = await owner.query(api.records.list, { typeId: deal._id, filters, paginationOpts: page });
		expect(got).toMatchObject({ page: [], isDone: true });
	});

	it("honors an explicit createdAt sort when a range would drive", async () => {
		const { t, owner, task } = await setup();
		await seed(t, owner.userId, task._id, [{ name: "old", due: "2026-01-02" }, { name: "new", due: "2026-01-01" }]);
		const list = (order: "asc" | "desc") => titles(owner, { typeId: task._id, filters: [{ field: "due", gte: "2026-01-01" }], sort: { field: "createdAt", order } });
		expect(await list("desc")).toEqual(["new", "old"]);
		expect(await list("asc")).toEqual(["old", "new"]);
	});

	it("caps pages even with an end cursor, and splits them instead", async () => {
		const { t, owner, task } = await setup();
		await seed(t, owner.userId, task._id, Array.from({ length: 120 }, (_, i) => ({ name: `T${i}` })));
		const args = { typeId: task._id, filters: [{ field: "status", empty: true }] };
		// A cursor 100 records in.
		let cursor: string | null = null;
		for (let i = 0; i < 2; i++) cursor = (await owner.query(api.records.list, { ...args, paginationOpts: { numItems: 50, cursor } })).continueCursor;
		const whole = await owner.query(api.records.list, { ...args, paginationOpts: { numItems: 10, cursor: null, endCursor: cursor } });
		expect(whole.page).toHaveLength(50);
		expect(whole).toMatchObject({ pageStatus: "SplitRequired", continueCursor: cursor });
		const rest = await owner.query(api.records.list, { ...args, paginationOpts: { numItems: 10, cursor: whole.splitCursor!, endCursor: cursor } });
		expect(rest).toMatchObject({ continueCursor: cursor });
		expect([...whole.page, ...rest.page].map((r) => r.title)).toEqual(Array.from({ length: 100 }, (_, i) => `T${119 - i}`));
		await expect(
			owner.query(api.records.list, { typeId: task._id, paginationOpts: { ...page, endCursor: JSON.stringify({ p: "t", a: [0] }) } }),
		).rejects.toThrow("out of date");
	});

	it("only continues a cursor with the list it came from", async () => {
		const { t, owner, member, task, deal } = await setup();
		await seed(t, owner.userId, task._id, [{ name: "A", status: "done" }, { name: "B", status: "done" }]);
		const args = { typeId: task._id, filters: [{ field: "status", eq: "done" }] };
		const { continueCursor } = await owner.query(api.records.list, { ...args, paginationOpts: { numItems: 1, cursor: null } });
		const next = (changes: Partial<FunctionArgs<typeof api.records.list>>, as: As = owner) =>
			as.query(api.records.list, { ...args, ...changes, paginationOpts: { numItems: 1, cursor: continueCursor } });
		expect((await next({})).page.map((r) => r.title)).toEqual(["A"]);
		await expect(next({ filters: [{ field: "status", eq: "to_do" }] })).rejects.toThrow("out of date");
		await expect(next({ sort: { field: "createdAt", order: "asc" } })).rejects.toThrow("out of date");
		await expect(next({ typeId: deal._id, filters: [] })).rejects.toThrow("out of date");
		await expect(next({ archived: true })).rejects.toThrow("out of date");
		// Another workspace: the same cursor names this one.
		const outsider = await signIn(t, "out@other.com");
		const theirs = (await outsider.query(api.recordTypes.list)).find((ty) => ty.key === "task")!;
		await expect(next({ typeId: theirs._id }, outsider)).rejects.toThrow("out of date");
		expect((await next({}, member)).page.map((r) => r.title)).toEqual(["A"]);
	});

	it("pages through records that share a creation time, in id order, however many", async () => {
		const { t, owner, task } = await setup();
		const ids = await seed(t, owner.userId, task._id, Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, status: "done" })));
		// Same `at` on every row, as an import that kept creation times could make.
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("recordValues").collect()) await ctx.db.patch(row._id, { at: 1 });
		});
		const pages = async (filters: FunctionArgs<typeof api.records.list>["filters"], numItems: number) => {
			const seen: string[] = [];
			let cursor: string | null = null;
			for (;;) {
				const r: List = await owner.query(api.records.list, { typeId: task._id, filters, paginationOpts: { numItems, cursor } });
				seen.push(...r.page.map((x) => x._id));
				if (r.isDone) break;
				cursor = r.continueCursor;
			}
			return seen;
		};
		const expected = [...ids].sort().reverse();
		expect(await pages([{ field: "status", eq: "done" }], 1)).toEqual(expected);
		expect(await pages([{ field: "status", in: ["done", "to_do"] }], 2)).toEqual(expected);
		expect(await pages([], 5)).toEqual(expected);
	});

	it("refuses a cursor once the workspace's currency changes what a filter means", async () => {
		const { owner, deal } = await setup();
		for (const [name, value] of [["EUR old", "EUR 100"], ["USD old", "USD 100"], ["EUR new", "EUR 100"], ["USD new", "USD 100"]])
			await owner.mutation(api.records.create, { typeId: deal._id, values: { name, value } });
		const args = { typeId: deal._id, filters: [{ field: "value", eq: 100 }] };
		const first = await owner.query(api.records.list, { ...args, paginationOpts: { numItems: 1, cursor: null } });
		expect(first.page.map((r) => r.title)).toEqual(["USD new"]);
		const settings = (await owner.query(api.workspace.settings))!;
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, currency: "EUR", expectedVersion: settings.version });
		await expect(owner.query(api.records.list, { ...args, paginationOpts: { numItems: 1, cursor: first.continueCursor } })).rejects.toThrow(
			"out of date",
		);
		// Naming the currency keeps meaning the same, so its cursors carry on.
		const usd = { typeId: deal._id, filters: [{ field: "value", eq: "USD 100" }] };
		const before = await owner.query(api.records.list, { ...usd, paginationOpts: { numItems: 1, cursor: null } });
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, currency: "GBP", expectedVersion: settings.version + 1 });
		const after = await owner.query(api.records.list, { ...usd, paginationOpts: { numItems: 1, cursor: before.continueCursor } });
		expect(after.page.map((r) => r.title)).toEqual(["USD old"]);
	});

	it("treats links to archived records as empty, one or several", async () => {
		const { owner, client, deal } = await setup();
		const gone = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Gone" } });
		const kept = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Kept" } });
		await owner.mutation(api.fields.create, { typeId: deal._id, label: "Partners", kind: "link", linkTypeId: client._id, multiple: true });
		await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "To gone", client: gone, partners: [gone] } });
		await owner.mutation(api.records.create, { typeId: deal._id, values: { name: "Mixed", client: kept, partners: [gone, kept] } });
		await owner.mutation(api.records.archive, { recordId: gone });
		const list = (field: string, empty: boolean) => titles(owner, { typeId: deal._id, filters: [{ field, empty }] });
		expect(await list("client", true)).toEqual(["To gone"]);
		expect(await list("client", false)).toEqual(["Mixed"]);
		expect(await list("partners", true)).toEqual(["To gone"]);
		expect(await list("partners", false)).toEqual(["Mixed"]);
	});
});
