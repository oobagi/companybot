import { setup, signIn } from "./helpers";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

// Records tools (recordTools.ts), as an agent turn calls them: acting for the person who asked.

type As = Awaited<ReturnType<typeof signIn>>;

/** A tool's answer, read as any outcome: the success shape, with `error` set when it refused and `change` unset when nothing changed. */
type Result<T> = Exclude<T, { error: string }> & { error?: string; change?: Id<"recordHistory">; unchanged?: boolean };
const result = <T,>(answer: Promise<T>) => answer as Promise<Result<T>>;

/** A running Companybot turn for `as`, started by mentioning it in #general. */
async function turnFor(t: ReturnType<typeof convexTest>, as: As) {
	const general = (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
	const companybot = (await as.query(api.agents.list)).find((a) => a.name === "Companybot")!;
	const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	await as.mutation(api.messages.send, { chatId: general._id, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
	const turns = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	const turnId = turns.find((x) => !before.some((b) => b._id === x._id))!._id;
	const tools = {
		types: () => t.query(internal.recordTools.typesFor, { turnId }),
		find: (input: object) => result(t.query(internal.recordTools.findFor, { turnId, input: { numItems: 20, ...input } })),
		get: (id: string) => result(t.query(internal.recordTools.getFor, { turnId, id })),
		save: (input: object) => result(t.mutation(internal.recordTools.saveFor, { turnId, input })),
		undo: (change: string) => result(t.mutation(internal.recordTools.undoFor, { turnId, change })),
		saveField: (input: object) => result(t.mutation(internal.recordTools.saveFieldFor, { turnId, input })),
	};
	return { turnId, ...tools };
}

describe("records tools", () => {
	// Holds back the scheduled reply (it would call a model), so the turn stays running.
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it("describe the types, fields and currency", async () => {
		const { t, member } = await setup();
		const { types } = await turnFor(t, member);
		const result = await types();
		expect(result.currency).toBe("USD");
		const deal = result.types.find((x) => x.type === "deal")!;
		expect(deal).toMatchObject({ name: "Deal", plural: "Deals" });
		expect(deal.fields.find((f) => f.key === "stage")).toEqual({
			key: "stage",
			label: "Stage",
			kind: "choice",
			options: ["New", "Qualified", "Proposal", "Won", "Lost"],
		});
		expect(deal.fields.find((f) => f.key === "client")).toEqual({ key: "client", label: "Client", kind: "link", linksTo: "client" });
	});

	it("create and change records as the person, named the way people say things, with history naming both", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		const client = await tools.save({ type: "Clients", values: { Name: "Acme Roofing", status: "lead" } });
		expect(client).toMatchObject({ type: "client", typeName: "Client", name: "Acme Roofing", values: { name: "Acme Roofing", status: "Lead" } });
		const deal = await tools.save({
			type: "deal",
			values: { name: "Acme roof", client: "acme roofing", stage: "Proposal", value: 12000, owner: "me", close_date: "2026-10-30" },
		});
		expect(deal.values).toEqual({
			name: "Acme roof",
			client: "Acme Roofing",
			stage: "Proposal",
			value: "$12,000.00",
			close_date: "Oct 30, 2026",
			owner: "member@co.com",
		});
		const won = await tools.save({ id: deal.id, values: { Stage: "won" } });
		expect(won.values.stage).toBe("Won");
		const history = await member.query(api.records.history, { recordId: deal.id, paginationOpts: { numItems: 10, cursor: null } });
		expect(history.page.map((e) => [e.action, e.user, e.agent])).toEqual([
			["updated", "member@co.com", "Companybot"],
			["created", "member@co.com", "Companybot"],
		]);
		expect((await tools.get(deal.id)).changes[0]).toMatchObject({
			change: won.change,
			action: "updated",
			by: "member@co.com",
			agent: "Companybot",
			changed: ["Stage: Proposal → Won"],
		});
		expect(await tools.save({ id: deal.id, values: { stage: "Won" } })).toMatchObject({ unchanged: true });
	});

	it("keep amounts in their own currency", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		const deal = await tools.save({ type: "deal", values: { name: "Berlin", value: "EUR 1250.5" } });
		expect(deal.values.value).toBe("€1,250.50");
		const yen = await tools.save({ type: "deal", values: { name: "Tokyo", value: { amount: 99.5, currency: "JPY" } } });
		expect(yen.values.value).toBe("¥100");
		expect((await tools.find({ type: "deal", filters: [{ field: "value", gte: "EUR 1000" }] })).rows.map((r) => r.name)).toEqual(["Berlin"]);
	});

	it("explain what's wrong instead of failing the reply", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		expect(await tools.save({ type: "job", values: { name: "x" } })).toEqual({ error: expect.stringContaining("no record type “job”") });
		expect(await tools.save({ type: "deal", values: { name: "x", client: "Nobody" } })).toEqual({ error: expect.stringContaining("No client named “Nobody”.") });
		expect(await tools.save({ type: "deal", values: { name: "x", owner: "Bob" } })).toEqual({ error: expect.stringContaining("No teammate “Bob”") });
		expect(await tools.save({ type: "deal", values: { name: "x", stage: "Maybe" } })).toEqual({ error: expect.stringContaining("is one of") });
		expect(await tools.save({ type: "deal", values: { name: "x", color: "red" } })).toEqual({ error: expect.stringContaining("no field “color”") });
		expect(await tools.get("nope")).toEqual({ error: "Record not found." });
	});

	it("list with combined filters, a sort and pages, and search", async () => {
		const { t, member, owner } = await setup();
		const tools = await turnFor(t, member);
		for (const [i, stage] of ["New", "Proposal", "Proposal", "Won", "Proposal"].entries())
			await tools.save({ type: "deal", values: { name: `Deal ${i}`, stage, value: (i + 1) * 1000, close_date: `2026-10-${10 + i}`, owner: i % 2 ? "me" : "owner@co.com" } });
		const filters = [
			{ field: "close_date", gte: "2026-10-01", lte: "2026-10-31" },
			{ field: "Stage", in: ["Proposal", "won"] },
		];
		const first = await tools.find({ type: "deal", filters, sort: { field: "value", order: "desc" }, numItems: 2 });
		expect(first.rows.map((r) => [r.name, r.value])).toEqual([
			["Deal 4", "$5,000.00"],
			["Deal 3", "$4,000.00"],
		]);
		expect(first.more).toBe(true);
		const next = await tools.find({ type: "deal", filters, sort: { field: "value", order: "desc" }, numItems: 2, cursor: first.cursor });
		expect(next.rows.map((r) => r.name)).toEqual(["Deal 2", "Deal 1"]);
		expect((await tools.find({ type: "deal", filters, sort: { field: "value", order: "asc" }, cursor: first.cursor })).error).toMatch("out of date");
		const mine = await tools.find({ type: "deal", filters: [{ field: "owner", eq: "me" }] });
		expect(mine.rows.map((r) => r.name)).toEqual(["Deal 3", "Deal 1"]);
		expect(mine.rows[0]).toMatchObject({ _id: expect.any(String), owner: "member@co.com", stage: "Won" });
		const found = await tools.find({ search: "deal" });
		expect(found).toMatchObject({ type: "Records", typeName: "Record", more: false });
		expect(found.rows).toHaveLength(5);
		expect(found.rows[0]).toMatchObject({ _type: "deal" });
		expect((await tools.find({ search: "Deal", filters })).error).toMatch("Search on its own");
		// The same list the app shows.
		const deals = (await owner.query(api.recordTypes.list)).find((x) => x.key === "deal")!;
		const app = await owner.query(api.records.list, {
			typeId: deals._id,
			filters: [{ field: "stage", in: ["proposal", "won"] }],
			sort: { field: "value", order: "desc" },
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(app.page.map((r) => r.title)).toEqual(["Deal 4", "Deal 3", "Deal 2", "Deal 1"]);
	});

	it("resolve exact keys before labels, and refuse names that could mean two things", async () => {
		const { t, owner, member } = await setup();
		const tools = await turnFor(t, member);
		const first = await tools.saveField({ type: "client", label: "First slot", kind: "text" });
		await tools.saveField({ type: "client", label: "Second slot", kind: "text" });
		await tools.saveField({ type: "client", field: first.key, label: "Second_slot" });
		const acme = await tools.save({ type: "client", values: { name: "Acme", second_slot: "B", first_slot: "A" } });
		expect(acme.values).toMatchObject({ first_slot: "A", second_slot: "B" });
		// Labels are unique when saved, but don't count on it: two alike are refused, not guessed.
		await tools.saveField({ type: "client", label: "Tier level", kind: "text" });
		await t.run(async (ctx) => {
			const { _id, _creationTime, ...tier } = (await ctx.db.query("recordFields").collect()).find((f) => f.key === "tier_level")!;
			await ctx.db.insert("recordFields", { ...tier, key: "tier_level_2", position: 99 });
		});
		expect(await tools.save({ id: acme.id, values: { "TIER LEVEL": "Gold" } })).toEqual({
			error: "“TIER LEVEL” could be Tier level (tier_level) or Tier level (tier_level_2). Use the exact key.",
		});
		expect((await tools.save({ id: acme.id, values: { tier_level_2: "Gold" } })).values).toMatchObject({ tier_level_2: "Gold" });
		// Types: a key beats another type's name; names two types share are refused.
		await owner.mutation(api.recordTypes.create, { name: "Pipeline", plural: "Pipelines" });
		await t.run(async (ctx) => {
			const type = (await ctx.db.query("recordTypes").collect()).find((x) => x.key === "pipeline")!;
			await ctx.db.patch(type._id, { name: "deal", plural: "Deals" });
		});
		expect((await tools.save({ type: "deal", values: { name: "x" } })).type).toBe("deal");
		expect(await tools.save({ type: "DEALS", values: { name: "x" } })).toEqual({
			error: "“DEALS” could be Deals (deal) or Deals (pipeline). Use the exact key.",
		});
	});

	it("find linked records by exact name, refusing duplicates beyond any search window", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		// 25 near-misses that search ranks alike, and two exact duplicates after them.
		for (let i = 0; i < 25; i++) await tools.save({ type: "client", values: { name: `Acme Roofing ${i}` } });
		const one = await tools.save({ type: "client", values: { name: "Acme Roofing" } });
		expect((await tools.save({ type: "deal", values: { name: "Roof", client: "ACME roofing" } })).values.client).toBe("Acme Roofing");
		await tools.save({ type: "client", values: { name: "acme roofing" } });
		expect(await tools.save({ type: "deal", values: { name: "Roof", client: "Acme Roofing" } })).toEqual({
			error: expect.stringContaining("Several clients are named “Acme Roofing”"),
		});
		// Archived ones don't count.
		await tools.save({ id: one.id, archived: true });
		expect((await tools.save({ type: "deal", values: { name: "Roof", client: "Acme Roofing" } })).values.client).toBe("acme roofing");
		// Long names (indexed by prefix + hash) still match exactly.
		const long = `Northwest ${"Roofing ".repeat(20)}LLC`;
		await tools.save({ type: "client", values: { name: long } });
		expect((await tools.save({ type: "deal", values: { name: "Big", client: long.toUpperCase() } })).values.client).toBe(long);
		expect(await tools.save({ type: "deal", values: { name: "Big", client: `${long}!` } })).toEqual({ error: expect.stringContaining("No client named") });
	});

	it("bound name lookups: list limits first, repeats looked up once, a cap on distinct names", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		await tools.saveField({ type: "deal", label: "Partners", kind: "link", linksTo: "client", multiple: true });
		await tools.save({ type: "client", values: { name: "Acme" } });
		const many = Array.from({ length: 51 }, (_, i) => `Client ${i}`);
		expect(await tools.save({ type: "deal", values: { name: "x", partners: many } })).toEqual({ error: "“Partners” takes up to 50 values." });
		expect(await tools.save({ type: "deal", values: { name: "x", client: ["Acme"] } })).toEqual({ error: "“Client” holds one value." });
		const repeated = await tools.save({ type: "deal", values: { name: "x", partners: Array(50).fill("Acme") } });
		expect(repeated.values.partners).toBe("Acme");
		// 101 distinct names in one call: refused at the cap, before reading the rest.
		const clients = (await member.query(api.recordTypes.list)).find((x) => x.key === "client")!;
		for (let i = 0; i < 101; i++) await member.mutation(api.records.create, { typeId: clients._id, values: { name: `C${i}` } });
		const names = (from: number, n: number) => Array.from({ length: n }, (_, i) => `C${from + i}`);
		const filters = [names(0, 50), names(50, 50), names(100, 1)].map((list) => ({ field: "partners", in: list }));
		expect(await tools.find({ type: "deal", filters: filters.slice(0, 2) })).toMatchObject({ rows: [] });
		expect(await tools.find({ type: "deal", filters })).toEqual({ error: expect.stringContaining("more than 100 names") });
		expect(await tools.find({ type: "deal", filters: [{ field: "partners", in: Array(51).fill("Acme") }] })).toEqual({ error: "“Partners” takes up to 50 values." });
	});

	it("keep a custom field called id or type apart from the row's own id and type", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		await tools.saveField({ type: "client", label: "ID", kind: "text" });
		await tools.saveField({ type: "client", label: "Type", kind: "text" });
		const acme = await tools.save({ type: "client", values: { name: "Acme", id: "C-42", type: "Commercial" } });
		expect(acme).toMatchObject({ type: "client", values: { id: "C-42", type: "Commercial" } });
		expect((await tools.get(acme.id)).values).toMatchObject({ id: "C-42", type: "Commercial" });
		const [row] = (await tools.find({ type: "client" })).rows;
		expect(row).toMatchObject({ _id: acme.id, id: "C-42", type: "Commercial" });
		expect((await tools.find({ search: "Acme" })).rows[0]).toMatchObject({ _id: acme.id, _type: "client", id: "C-42", type: "Commercial" });
	});

	it("archive, restore and undo", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		const client = await tools.save({ type: "client", values: { name: "Acme", status: "Lead" } });
		const changed = await tools.save({ id: client.id, values: { status: "Active" } });
		const undone = await tools.undo(changed.change!);
		expect(undone).toMatchObject({ undone: changed.change, id: client.id, values: { status: "Lead" } });
		expect(await tools.undo(changed.change!)).toEqual({ error: "That change was already undone." });
		const archived = await tools.save({ id: client.id, archived: true });
		expect(archived).toMatchObject({ archived: true });
		expect((await tools.find({ type: "client" })).rows).toEqual([]);
		expect((await tools.find({ type: "client", archived: true })).rows.map((r) => r.name)).toEqual(["Acme"]);
		expect(await tools.undo(archived.change!)).not.toHaveProperty("archived");
		expect(await tools.save({ id: client.id, archived: true, values: { status: "Past" } })).toEqual({ error: expect.stringContaining("on its own") });
		// Undoing a new record archives it.
		const extra = await tools.save({ type: "client", values: { name: "Oops" } });
		expect(await tools.undo(extra.change!)).toMatchObject({ name: "Oops", archived: true });
	});

	it("show a record's links and what links to it", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		const client = await tools.save({ type: "client", values: { name: "Acme" } });
		const deal = await tools.save({ type: "deal", values: { name: "Roof", client: client.id } });
		expect((await tools.get(deal.id)).links).toEqual({ client: [{ id: client.id, name: "Acme" }] });
		expect((await tools.get(client.id)).linkedFrom).toEqual([{ id: deal.id, type: "deal", name: "Roof", via: "Client" }]);
	});

	it("add fields as anyone, but change built-in ones only as an owner, read fresh each call", async () => {
		const { t, owner, member } = await setup();
		const tools = await turnFor(t, member);
		const roof = await tools.saveField({ type: "client", label: "Roof type", kind: "choice", options: ["Shingle", "Metal"] });
		expect(roof).toEqual({ type: "client", typePlural: "Clients", key: "roof_type", label: "Roof type", kind: "choice", options: ["Shingle", "Metal"] });
		const acme = await tools.save({ type: "client", values: { name: "Acme", "Roof type": "metal" } });
		expect(acme.values.roof_type).toBe("Metal");
		expect(await tools.saveField({ type: "client", field: "roof type", options: ["Shingle", "Metal", "Tile"] })).toMatchObject({ options: ["Shingle", "Metal", "Tile"] });
		const stages = { type: "deal", field: "Stage", options: ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"] };
		expect(await tools.saveField(stages)).toEqual({ error: "Only the person who made this or an owner can change it." });
		const row = await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first());
		await owner.mutation(api.workspace.setRole, { id: row!._id, role: "owner" });
		expect(await tools.saveField(stages)).toMatchObject({ options: stages.options });
		expect(await tools.saveField({ type: "deal", field: "stage", kind: "text" })).toEqual({ error: expect.stringContaining("Only a field's name and options") });
		const linked = await tools.saveField({ type: "task", label: "Call", kind: "link", linksTo: "Calls" });
		expect(linked).toMatchObject({ key: "call", kind: "link", linksTo: "call" });
	});

	it("stop working once the person leaves, and never reach another workspace", async () => {
		const { t, owner, member } = await setup();
		const tools = await turnFor(t, member);
		const other = await signIn(t, "other@else.com");
		const theirs = await turnFor(t, other);
		const secret = await theirs.save({ type: "client", values: { name: "Their client" } });
		expect(await tools.get(secret.id)).toEqual({ error: "Record not found." });
		expect(await tools.save({ id: secret.id, values: { name: "Mine now" } })).toEqual({ error: "Record not found." });
		expect(await tools.undo(secret.change!)).toEqual({ error: "Change not found." });
		expect((await tools.find({ search: "Their client" })).rows).toEqual([]);
		expect(await tools.save({ type: "deal", values: { name: "x", client: secret.id } })).toEqual({ error: expect.stringContaining("doesn't exist") });
		const otherType = (await other.query(api.recordTypes.list))[0]!._id;
		expect(await tools.find({ type: otherType })).toEqual({ error: expect.stringContaining("no record type") });
		const row = await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first());
		await owner.mutation(api.workspace.removeMember, { id: row!._id as Id<"members"> });
		await expect(tools.save({ type: "client", values: { name: "After" } })).rejects.toThrow("no longer in the workspace");
		await expect(tools.types()).rejects.toThrow("no longer in the workspace");
	});
});
