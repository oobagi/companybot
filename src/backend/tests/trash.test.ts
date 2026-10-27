import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { TRASH_MS } from "../convex/trashOps";
import { agentTurn, agentsOf, generalOf, newTest, noMentions, settle, setup, signIn } from "./helpers";

afterEach(() => vi.useRealTimers());
const page = { numItems: 50, cursor: null };

/** Clients and deals, a deal linking to a client, and a channel the member made. */
async function seeded() {
	const s = await setup();
	const types = await s.owner.query(api.recordTypes.list);
	const client = types.find((t) => t.key === "client")!;
	const deal = types.find((t) => t.key === "deal")!;
	const acme = await s.member.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
	const roof = await s.member.mutation(api.records.create, { typeId: deal._id, values: { name: "Roof", client: acme } });
	return { ...s, client, deal, acme, roof };
}

const trashOf = async (as: Awaited<ReturnType<typeof setup>>["owner"], args: { kind?: "record" | "channel"; search?: string } = {}) =>
	(await as.query(api.trash.list, { ...args, paginationOpts: page })).page;

describe("trash", () => {
	it("moves a record to Trash and back, links included, with who deleted it", async () => {
		const { owner, member, client, acme, roof } = await seeded();
		await member.mutation(api.trash.move, { kind: "record", id: acme });
		expect(await trashOf(owner)).toEqual([expect.objectContaining({ kind: "record", itemId: acme, name: "Acme", in: "Clients", by: "member@co.com", canRestore: true })]);
		expect((await owner.query(api.records.list, { typeId: client._id, paginationOpts: page })).page).toEqual([]);
		expect(await owner.query(api.records.search, { query: "Acme" })).toEqual([]);
		// Links show it as deleted, and can't be pointed at it again.
		expect((await owner.query(api.records.get, { recordId: roof }))?.refs[acme]).toEqual({ name: "Acme", archived: true });
		expect(await owner.query(api.records.get, { recordId: acme })).toMatchObject({ archived: true, trash: { by: "member@co.com", canRestore: true } });
		expect(await member.query(api.records.get, { recordId: acme })).toMatchObject({ trash: { canRestore: true } });
		await expect(owner.mutation(api.records.update, { recordId: roof, values: { client: acme } })).rejects.toThrow("doesn't exist");
		await expect(member.mutation(api.records.update, { recordId: acme, values: { name: "Acme 2" } })).rejects.toThrow("in Trash");
		await member.mutation(api.trash.restore, { kind: "record", id: acme });
		expect(await trashOf(owner)).toEqual([]);
		expect((await owner.query(api.records.get, { recordId: roof }))?.refs[acme]).toEqual({ name: "Acme" });
		expect((await owner.query(api.records.linked, { recordId: acme, paginationOpts: page })).page.map((r) => r._id)).toEqual([roof]);
		expect((await owner.query(api.records.search, { query: "Acme" })).map((r) => r._id)).toEqual([acme]);
	});

	it("lets whoever deleted it, or an owner, restore; only owners delete forever", async () => {
		const { t, owner, member, acme, roof } = await seeded();
		await owner.mutation(api.trash.move, { kind: "record", id: acme });
		expect((await trashOf(member))[0]).toMatchObject({ canRestore: false });
		await expect(member.mutation(api.trash.restore, { kind: "record", id: acme })).rejects.toThrow("Only owner@co.com, who deleted it, or an owner");
		await member.mutation(api.trash.move, { kind: "record", id: roof });
		await owner.mutation(api.trash.restore, { kind: "record", id: roof });
		await expect(member.mutation(api.trash.purge, { id: acme })).rejects.toThrow("permission");
		await owner.mutation(api.trash.purge, { id: acme });
		// Gone from Trash at once; it can't come back while its cascade runs.
		expect(await trashOf(owner)).toEqual([]);
		await settle(t);
		expect(await t.run((ctx) => ctx.db.get(acme))).toBeNull();
		expect((await owner.query(api.records.get, { recordId: roof }))?.refs[acme]).toEqual({ name: "Deleted record", archived: true });
	});

	it("deletes forever after 30 days: values, history, mentions and the record's page", async () => {
		const { t, owner, member, acme } = await seeded();
		vi.useFakeTimers();
		const pageId = await member.mutation(api.pages.create, { recordId: acme });
		await member.mutation(api.messages.send, { chatId: (await generalOf(member))._id, text: "Acme", mentions: { ...noMentions, recordIds: [acme] } });
		await member.mutation(api.trash.move, { kind: "record", id: acme });
		vi.advanceTimersByTime(TRASH_MS - 60_000);
		await t.mutation(internal.trash.sweep, {});
		expect(await trashOf(owner)).toHaveLength(1);
		vi.advanceTimersByTime(120_000);
		await t.mutation(internal.trash.sweep, {});
		await settle(t);
		expect(await trashOf(owner)).toEqual([]);
		const left = await t.run(async (ctx) => ({
			record: await ctx.db.get(acme),
			page: await ctx.db.get(pageId),
			history: await ctx.db.query("recordHistory").withIndex("by_record", (q) => q.eq("recordId", acme)).collect(),
			mentions: await ctx.db.query("recordMentions").withIndex("by_record", (q) => q.eq("recordId", acme)).collect(),
			cascades: await ctx.db.query("cascades").collect(),
		}));
		expect(left).toEqual({ record: null, page: null, history: [], mentions: [], cascades: [] });
		expect(await t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id: pageId }))).toBeNull();
	});

	it("hides a database's records while it's in Trash, and deletes them, its fields and views forever", async () => {
		const { t, owner, member, client, acme, roof } = await seeded();
		const viewId = await member.mutation(api.databaseViews.save, { typeId: client._id, name: "All", filters: [], columns: ["name"] });
		await expect(member.mutation(api.trash.move, { kind: "database", id: client._id })).rejects.toThrow("permission");
		await owner.mutation(api.trash.move, { kind: "database", id: client._id });
		expect(await owner.query(api.records.search, { query: "Acme" })).toEqual([]);
		expect((await owner.query(api.records.get, { recordId: roof }))?.refs[acme]).toEqual({ name: "Acme", archived: true });
		expect(await owner.query(api.records.get, { recordId: acme })).toMatchObject({ archived: true, trash: { kind: "database", name: "Clients" } });
		await owner.mutation(api.trash.purge, { id: client._id });
		await settle(t);
		const gone = await t.run(async (ctx) => ({
			type: await ctx.db.get(client._id),
			record: await ctx.db.get(acme),
			view: await ctx.db.get(viewId),
			fields: await ctx.db.query("recordFields").withIndex("by_type", (q) => q.eq("typeId", client._id)).collect(),
			history: await ctx.db.query("recordHistory").withIndex("by_type", (q) => q.eq("typeId", client._id)).collect(),
		}));
		expect(gone).toEqual({ type: null, record: null, view: null, fields: [], history: [] });
		// The deal stays, its link shown as deleted.
		expect((await owner.query(api.records.get, { recordId: roof }))?.refs[acme]).toEqual({ name: "Deleted record", archived: true });
	});

	it("deletes a field's values from every record forever, so its key can be reused", async () => {
		const { t, owner, member, client, acme } = await seeded();
		const field = await member.mutation(api.fields.create, { typeId: client._id, label: "Roof type", kind: "text" });
		await member.mutation(api.records.update, { recordId: acme, values: { roof_type: "Metal" } });
		await member.mutation(api.trash.move, { kind: "field", id: field._id });
		expect(await trashOf(owner)).toEqual([expect.objectContaining({ kind: "field", name: "Roof type", in: "Clients" })]);
		await owner.mutation(api.trash.purge, { id: field._id });
		await settle(t);
		const record = await t.run((ctx) => ctx.db.get(acme));
		expect(record).toMatchObject({ values: { name: "Acme" }, searchText: "Acme" });
		const again = await member.mutation(api.fields.create, { typeId: client._id, label: "Roof type", kind: "number" });
		expect(again.key).toBe("roof_type");
		expect((await owner.query(api.records.get, { recordId: acme }))?.values).toEqual({ name: "Acme" });
	});

	it("deletes channels as their managers may; their messages go forever, #general stays", async () => {
		const { t, owner, member } = await setup();
		const chatId = await member.mutation(api.chats.createChannel, { name: "sales", private: false });
		await member.mutation(api.messages.send, { chatId, text: "hello", mentions: noMentions });
		await expect(owner.mutation(api.trash.move, { kind: "channel", id: (await generalOf(owner))._id })).rejects.toThrow("stays");
		await member.mutation(api.trash.move, { kind: "channel", id: chatId });
		expect((await member.query(api.chats.list))!.channels.map((c) => c.name)).toEqual(["general"]);
		expect(await member.query(api.chats.get, { chatId })).toMatchObject({ trash: { name: "#sales", canRestore: true } });
		await expect(member.mutation(api.messages.send, { chatId, text: "x", mentions: noMentions })).rejects.toThrow("in Trash");
		// Its name is free while it's in Trash; restoring then needs it back.
		const again = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
		await expect(member.mutation(api.trash.restore, { kind: "channel", id: chatId })).rejects.toThrow("already exists");
		await owner.mutation(api.trash.move, { kind: "channel", id: again });
		await member.mutation(api.trash.restore, { kind: "channel", id: chatId });
		await member.mutation(api.trash.move, { kind: "channel", id: chatId });
		await owner.mutation(api.trash.purge, { id: chatId });
		await settle(t);
		const left = await t.run(async (ctx) => ({
			chat: await ctx.db.get(chatId),
			messages: await ctx.db.query("chatMessages").withIndex("by_chat_thread", (q) => q.eq("chatId", chatId)).collect(),
			seats: await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect(),
		}));
		expect(left).toEqual({ chat: null, messages: [], seats: [] });
	});

	it("searches and filters by kind", async () => {
		const { owner, member, acme, roof } = await seeded();
		const pageId = await member.mutation(api.pages.create, { title: "Roof SOP" });
		for (const [kind, id] of [["record", acme], ["record", roof], ["page", pageId]] as const) await member.mutation(api.trash.move, { kind, id });
		expect((await trashOf(owner)).map((e) => e.name)).toEqual(["Roof SOP", "Roof", "Acme"]);
		expect((await trashOf(owner, { kind: "record" })).map((e) => e.name)).toEqual(["Roof", "Acme"]);
		expect((await trashOf(owner, { search: "roof" })).map((e) => e.name).sort()).toEqual(["Roof", "Roof SOP"]);
	});

	it("lets agents delete and restore as the person, never forever", async () => {
		const { t, owner, member, acme } = await seeded();
		const { companybot } = await agentsOf(member);
		const turnId = await agentTurn(t, member, (await generalOf(member))._id, companybot._id);
		expect(await t.mutation(internal.recordTools.saveFor, { turnId, input: { id: acme, trash: true } })).toMatchObject({ inTrash: true });
		expect(await trashOf(owner)).toEqual([expect.objectContaining({ itemId: acme, by: "member@co.com", agent: "Companybot" })]);
		expect(await t.query(internal.recordTools.getFor, { turnId, id: acme })).toMatchObject({ inTrash: true });
		expect(await t.mutation(internal.recordTools.saveFor, { turnId, input: { id: acme, trash: false } })).not.toHaveProperty("inTrash");
		// Fields and databases by name, in Trash or not, within the person's rights.
		await t.mutation(internal.recordTools.saveFieldFor, { turnId, input: { type: "client", field: "Status", trash: true } }).then((r) => expect(r).toHaveProperty("error"));
		await t.mutation(internal.recordTools.saveFieldFor, { turnId, input: { type: "client", label: "Roof", kind: "text" } });
		expect(await t.mutation(internal.recordTools.saveFieldFor, { turnId, input: { type: "client", field: "Roof", trash: true } })).toMatchObject({ inTrash: true });
		expect(await t.mutation(internal.recordTools.saveFieldFor, { turnId, input: { type: "client", field: "Roof", trash: false } })).not.toHaveProperty("inTrash");
		expect(await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: "client", trash: true } })).toEqual({ error: expect.stringContaining("permission") });
		// Pages too, by title once in Trash.
		const pageId = await member.mutation(api.pages.create, { title: "SOP" });
		await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: pageId, trash: true } });
		expect((await t.query(internal.pageTools.findFor, { turnId, input: { trashed: true } })).rows.map((r) => r.title)).toEqual(["SOP"]);
		await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: "SOP", trash: false } });
		expect(await member.query(api.pages.get, { pageId })).toMatchObject({ archived: false });
		// No agent tool reaches delete forever.
		expect(Object.keys(internal.recordTools).concat(Object.keys(internal.pageTools)).some((k) => /purge|forever/i.test(k))).toBe(false);
	});

	it("keeps alpha.6 archive calls working, mapped to Trash", async () => {
		const { owner, member, client, acme } = await seeded();
		await member.mutation(api.records.archive, { recordId: acme });
		const field = await member.mutation(api.fields.create, { typeId: client._id, label: "Roof", kind: "text" });
		await member.mutation(api.fields.archive, { fieldId: field._id });
		const pageId = await member.mutation(api.pages.create, { title: "SOP" });
		await member.mutation(api.pages.setArchived, { pageId, archived: true });
		expect((await member.query(api.pages.list, { archived: true })).map((p) => p._id)).toEqual([pageId]);
		const jobs = await owner.mutation(api.recordTypes.create, { plural: "Jobs" });
		await owner.mutation(api.recordTypes.update, { typeId: jobs, version: 0, archived: true });
		expect((await trashOf(owner)).map((e) => e.kind)).toEqual(["database", "page", "field", "record"]);
		expect((await member.query(api.records.list, { typeId: client._id, archived: true, paginationOpts: page })).page.map((r) => r._id)).toEqual([acme]);
		await member.mutation(api.records.restore, { recordId: acme });
		await member.mutation(api.fields.restore, { fieldId: field._id });
		await member.mutation(api.pages.setArchived, { pageId, archived: false });
		expect((await trashOf(owner)).map((e) => e.kind)).toEqual(["database"]);
		// Deleting an archived page for good is an owner's "Delete forever" now.
		await member.mutation(api.pages.setArchived, { pageId, archived: true });
		await expect(member.mutation(api.pages.remove, { pageId })).rejects.toThrow("permission");
		await owner.mutation(api.pages.remove, { pageId });
		expect(await owner.query(api.pages.get, { pageId })).toBeNull();
	});
});

describe("trash migration", () => {
	it("moves archived records, databases, fields and pages to Trash, deleted at deploy time", async () => {
		const t = newTest();
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const typeId = (await ctx.db.query("recordTypes").first())!._id;
			const now = Date.now();
			const record = await ctx.db.insert("records", { workspaceId, typeId, title: "Old", values: { name: "Old" }, searchText: "Old", archived: true, createdBy: userId, updatedAt: now, updatedBy: userId });
			await ctx.db.insert("records", { workspaceId, typeId, title: "Live", values: { name: "Live" }, searchText: "Live", archived: false, createdBy: userId, updatedAt: now, updatedBy: userId });
			const type = await ctx.db.insert("recordTypes", { workspaceId, key: "job", name: "Job", plural: "Jobs", archived: true, createdBy: userId, updatedAt: now });
			const field = await ctx.db.insert("recordFields", { workspaceId, typeId, key: "roof", label: "Roof", kind: "text", position: 9, archived: true, createdBy: userId, updatedAt: now });
			const page = await ctx.db.insert("pages", { workspaceId, title: "Old SOP", archived: true, createdBy: userId, updatedAt: now, updatedBy: userId });
			return [record, type, field, page] as string[];
		});
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const entries = await t.run((ctx) => ctx.db.query("trash").collect());
		expect(entries.map((e) => [e.kind, e.itemId, e.name]).sort()).toEqual(
			[["record", ids[0], "Old"], ["database", ids[1], "Jobs"], ["field", ids[2], "Roof"], ["page", ids[3], "Old SOP"]].sort(),
		);
		// Deploy time, give or take the migration's own run: the full 30 days from now.
		for (const e of entries) expect(e.deletedAt - new Date("2026-11-01T00:00:00Z").getTime()).toBeLessThan(1_000);
		expect((await owner.query(api.trash.list, { paginationOpts: page })).page).toHaveLength(4);
		await owner.mutation(api.trash.restore, { kind: "record", id: ids[0]! as Id<"records"> });
	});
});
