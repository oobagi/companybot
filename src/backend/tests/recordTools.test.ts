import { ownerAndMember, signIn, setMemberSwitch } from "./helpers";
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
		types: () => t.mutation(internal.recordTools.typesFor, { turnId }),
		find: (input: object) => result(t.mutation(internal.recordTools.findFor, { turnId, input: { numItems: 20, ...input } })),
		get: (id: string) => result(t.mutation(internal.recordTools.getFor, { turnId, id })),
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
		const { t, member } = await ownerAndMember();
		const { types } = await turnFor(t, member);
		const result = await types();
		expect(result.currency).toBe("USD");
		const deal = result.types.find((x) => x.type === "deal")!;
		expect(deal).toMatchObject({ name: "Deal", plural: "Deals" });
		expect(deal.fields.find((f) => f.key === "stage")).toMatchObject({
			key: "stage",
			label: "Stage",
			kind: "choice",
			options: ["New", "Qualified", "Proposal", "Won", "Lost"],
		});
		expect(deal.fields.find((f) => f.key === "client")).toMatchObject({ key: "client", label: "Client", kind: "link", linksTo: "client" });
	});

	it("create and change records as the person, by key and id, with history naming both", async () => {
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		// Writes name databases, fields and linked records by key or id: names can change before a held call runs.
		expect(await tools.save({ type: "Clients", values: { name: "Acme Roofing" } })).toEqual({ error: expect.stringContaining("by its key or id") });
		expect(await tools.save({ type: "deal", values: { name: "x", "Close date": "2026-10-30" } })).toEqual({ error: expect.stringContaining("by key") });
		const client = await tools.save({ type: "client", values: { name: "Acme Roofing", status: "lead" } });
		expect(client).toMatchObject({ type: "client", typeName: "Client", name: "Acme Roofing", values: { name: "Acme Roofing", status: "Lead" } });
		const deal = await tools.save({
			type: "deal",
			values: { name: "Acme roof", client: client.id, stage: "Proposal", value: 12000, owner: "me", close_date: "2026-10-30" },
		});
		expect(deal.values).toEqual({
			name: "Acme roof",
			client: "Acme Roofing",
			stage: "Proposal",
			value: "$12,000.00",
			close_date: "Oct 30, 2026",
			owner: "member@co.com",
		});
		expect(await tools.save({ id: deal.id, values: { client: "Acme Roofing" } })).toEqual({ error: expect.stringContaining("by record id") });
		const won = await tools.save({ id: deal.id, values: { stage: "won" } });
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
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		const deal = await tools.save({ type: "deal", values: { name: "Berlin", value: "EUR 1250.5" } });
		expect(deal.values.value).toBe("€1,250.50");
		const yen = await tools.save({ type: "deal", values: { name: "Tokyo", value: { amount: 99.5, currency: "JPY" } } });
		expect(yen.values.value).toBe("¥100");
		expect((await tools.find({ type: "deal", filters: [{ field: "value", gte: "EUR 1000" }] })).rows.map((r) => r.name)).toEqual(["Berlin"]);
	});

	it("refuse a teammate whose name is someone else's email, as for two names", async () => {
		const { t, owner, member } = await ownerAndMember();
		await member.mutation(api.preferences.update, { displayName: "owner@co.com" });
		const tools = await turnFor(t, owner);
		expect(await tools.find({ type: "deal", filters: [{ field: "owner", eq: "owner@co.com" }] })).toEqual({ error: expect.stringContaining("Several teammates") });
		// Writes take an email as that person's, never a name.
		expect(await tools.save({ type: "deal", values: { name: "x", owner: "owner@co.com" } })).toMatchObject({ values: { owner: "owner@co.com" } });
	});

	// COMPAT(0.1.0-alpha.10): delete with migrations.memberProfiles.
	it("find a teammate by name before their membership has a copy of it", async () => {
		const { t, owner, member } = await ownerAndMember();
		await member.mutation(api.preferences.update, { displayName: "Mia", timeZone: "Asia/Tokyo" });
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("members").collect()) await ctx.db.patch(row._id, { name: undefined, image: undefined, timeZone: undefined });
		});
		const tools = await turnFor(t, owner);
		await tools.save({ type: "deal", values: { name: "Mia's deal", owner: "member@co.com" } });
		expect((await tools.find({ type: "deal", filters: [{ field: "owner", eq: "mia" }] })).rows.map((r) => [r.name, r.owner])).toEqual([["Mia's deal", "Mia"]]);
		const team = (await owner.query(api.workspace.team))!;
		expect(team.members.find((m) => m.email === "member@co.com")).toMatchObject({ name: "Mia", timeZone: "Asia/Tokyo" });
	});

	it("explain what's wrong instead of failing the reply", async () => {
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		expect(await tools.save({ type: "job", values: { name: "x" } })).toEqual({ error: expect.stringContaining("by its key or id") });
		expect(await tools.save({ type: "deal", values: { name: "x", client: "Nobody" } })).toEqual({ error: expect.stringContaining("by record id") });
		expect(await tools.save({ type: "deal", values: { name: "x", owner: "Bob" } })).toEqual({ error: expect.stringContaining("Name teammates by id, email") });
		expect(await tools.save({ type: "deal", values: { name: "x", stage: "Maybe" } })).toEqual({ error: expect.stringContaining("is one of") });
		expect(await tools.save({ type: "deal", values: { name: "x", color: "red" } })).toEqual({ error: expect.stringContaining("fields by key") });
		expect(await tools.get("nope")).toEqual({ error: "Record not found." });
	});

	it("list with combined filters, a sort and pages, and search", async () => {
		const { t, member, owner } = await ownerAndMember();
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

	it("resolve exact keys before labels in reads, and refuse names that could mean two things", async () => {
		const { t, owner, member } = await ownerAndMember();
		await setMemberSwitch(owner, "fields.edit", true);
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
		expect(await tools.find({ type: "client", filters: [{ field: "TIER LEVEL", eq: "Gold" }] })).toEqual({
			error: "“TIER LEVEL” could be Tier level (tier_level) or Tier level (tier_level_2). Use the exact key.",
		});
		expect((await tools.save({ id: acme.id, values: { tier_level_2: "Gold" } })).values).toMatchObject({ tier_level_2: "Gold" });
		// Types: a key beats another type's name; names two types share are refused.
		await owner.mutation(api.recordTypes.create, { plural: "Pipelines" });
		await t.run(async (ctx) => {
			const type = (await ctx.db.query("recordTypes").collect()).find((x) => x.key === "pipeline")!;
			await ctx.db.patch(type._id, { name: "deal", plural: "Deals" });
		});
		expect((await tools.save({ type: "deal", values: { name: "x" } })).type).toBe("deal");
		expect(await tools.find({ type: "DEALS" })).toEqual({
			error: "“DEALS” could be Deals (deal) or Deals (pipeline). Use the exact key.",
		});
	});

	it("find linked records by exact name in reads, refusing duplicates beyond any search window", async () => {
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		const byClient = (name: string) => tools.find({ type: "deal", filters: [{ field: "client", eq: name }] });
		// 25 near-misses that search ranks alike, and two exact duplicates after them.
		for (let i = 0; i < 25; i++) await tools.save({ type: "client", values: { name: `Acme Roofing ${i}` } });
		const one = await tools.save({ type: "client", values: { name: "Acme Roofing" } });
		const roof = await tools.save({ type: "deal", values: { name: "Roof", client: one.id } });
		expect((await byClient("ACME roofing")).rows.map((r) => r._id)).toEqual([roof.id]);
		await tools.save({ type: "client", values: { name: "acme roofing" } });
		expect(await byClient("Acme Roofing")).toEqual({ error: expect.stringContaining("Several clients are named “Acme Roofing”") });
		// Archived ones don't count.
		await tools.save({ id: one.id, trash: true });
		expect((await byClient("Acme Roofing")).rows).toEqual([]);
		// Long names (indexed by prefix + hash) still match exactly.
		const long = `Northwest ${"Roofing ".repeat(20)}LLC`;
		const northwest = await tools.save({ type: "client", values: { name: long } });
		const big = await tools.save({ type: "deal", values: { name: "Big", client: northwest.id } });
		expect((await byClient(long.toUpperCase())).rows.map((r) => r._id)).toEqual([big.id]);
		expect(await byClient(`${long}!`)).toEqual({ error: expect.stringContaining("No client named") });
	});

	it("bound name lookups: list limits first, repeats looked up once, a cap on distinct names", async () => {
		const { t, owner, member } = await ownerAndMember();
		await setMemberSwitch(owner, "fields.edit", true);
		const tools = await turnFor(t, member);
		await tools.saveField({ type: "deal", label: "Partners", kind: "link", linksTo: "client", multiple: true });
		const acme = await tools.save({ type: "client", values: { name: "Acme" } });
		const many = Array.from({ length: 51 }, (_, i) => `Client ${i}`);
		expect(await tools.save({ type: "deal", values: { name: "x", partners: many } })).toEqual({ error: "“Partners” takes up to 50 values." });
		expect(await tools.save({ type: "deal", values: { name: "x", client: ["Acme"] } })).toEqual({ error: "“Client” holds one value." });
		const repeated = await tools.save({ type: "deal", values: { name: "x", partners: Array(50).fill(acme.id) } });
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
		const { t, owner, member } = await ownerAndMember();
		await setMemberSwitch(owner, "fields.edit", true);
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

	it("delete to Archive, restore and undo", async () => {
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		const client = await tools.save({ type: "client", values: { name: "Acme", status: "Lead" } });
		const changed = await tools.save({ id: client.id, values: { status: "Active" } });
		const undone = await tools.undo(changed.change!);
		expect(undone).toMatchObject({ undone: changed.change, id: client.id, values: { status: "Lead" } });
		expect(await tools.undo(changed.change!)).toEqual({ error: "That change was already undone." });
		const deleted = await tools.save({ id: client.id, trash: true });
		expect(deleted).toMatchObject({ inTrash: true });
		expect((await tools.find({ type: "client" })).rows).toEqual([]);
		expect((await tools.find({ type: "client", trashed: true })).rows.map((r) => r.name)).toEqual(["Acme"]);
		expect(await tools.undo(deleted.change!)).not.toHaveProperty("inTrash");
		expect(await tools.save({ id: client.id, trash: true, values: { status: "Past" } })).toEqual({ error: expect.stringContaining("on its own") });
		// Undoing a new record deletes it.
		const extra = await tools.save({ type: "client", values: { name: "Oops" } });
		expect(await tools.undo(extra.change!)).toMatchObject({ name: "Oops", inTrash: true });
	});

	it("show a record's links and what links to it", async () => {
		const { t, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		const client = await tools.save({ type: "client", values: { name: "Acme" } });
		const deal = await tools.save({ type: "deal", values: { name: "Roof", client: client.id } });
		expect((await tools.get(deal.id)).links).toEqual({ client: [{ id: client.id, name: "Acme" }] });
		expect((await tools.get(client.id)).linkedFrom).toEqual([{ id: deal.id, type: "deal", name: "Roof", via: "Client" }]);
	});

	it("add and change fields with the databases switch, whoever added them, read fresh each call", async () => {
		const { t, owner, member } = await ownerAndMember();
		await setMemberSwitch(owner, "fields.edit", true);
		const tools = await turnFor(t, member);
		const roof = await tools.saveField({ type: "client", label: "Roof type", kind: "choice", options: ["Shingle", "Metal"] });
		expect(roof).toMatchObject({ type: "client", typePlural: "Clients", key: "roof_type", label: "Roof type", kind: "choice", options: ["Shingle", "Metal"] });
		const acme = await tools.save({ type: "client", values: { name: "Acme", roof_type: "metal" } });
		expect(acme.values.roof_type).toBe("Metal");
		expect(await tools.saveField({ type: "client", field: "roof type", options: ["Shingle"] })).toEqual({ error: expect.stringContaining("by key") });
		expect(await tools.saveField({ type: "client", field: "roof_type", options: ["Shingle", "Metal", "Tile"] })).toMatchObject({ options: ["Shingle", "Metal", "Tile"] });
		const stages = { type: "deal", field: "stage", options: ["New", "Qualified", "Proposal", "Negotiation", "Won", "Lost"] };
		await setMemberSwitch(owner, "fields.edit", false);
		expect(await tools.saveField(stages)).toEqual({ error: "Only people with the Owner role can add and change databases and fields. Ask someone who has it." });
		expect(await tools.saveField({ type: "client", field: "roof_type", options: ["Shingle"] })).toHaveProperty("error");
		const row = await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first());
		const ownerRole = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "owner")!.id;
		await owner.mutation(api.workspace.setRoles, { id: row!._id, roles: [ownerRole] });
		expect(await tools.saveField(stages)).toMatchObject({ options: stages.options });
		expect(await tools.saveField({ type: "deal", field: "stage", kind: "text" })).toEqual({ error: expect.stringContaining("Only a field's name, icon and options") });
		const linked = await tools.saveField({ type: "task", label: "Call", kind: "link", linksTo: "call" });
		expect(linked).toMatchObject({ key: "call", kind: "link", linksTo: "call" });
	});

	it("set a field's icon and its options' colors, and read them back", async () => {
		const { t, owner } = await ownerAndMember();
		const tools = await turnFor(t, owner);
		const priority = await tools.saveField({ type: "client", label: "Priority", kind: "choice", icon: "flag", options: [{ label: "High", color: "red" }, "Low"] });
		expect(priority).toMatchObject({ icon: "flag", choices: [{ label: "High", color: "red" }, { label: "Low", color: "brown" }] });
		// Plain labels keep the colors they have.
		expect(await tools.saveField({ type: "client", field: "priority", icon: null, options: ["High", "Low", "Medium"] })).toMatchObject({
			choices: [{ label: "High", color: "red" }, { label: "Low", color: "brown" }, { label: "Medium", color: "orange" }],
		});
		const field = (await tools.types()).types.find((x) => x.type === "client")!.fields.find((f) => f.key === "priority")!;
		expect(field.icon).toBeUndefined();
		// Only the set's icons: the tool's input schema lists them.
		await expect(tools.saveField({ type: "client", field: "priority", icon: "rocket" })).rejects.toThrow("flag");
	});

	it("stop working once the person leaves, and never reach another workspace", async () => {
		const { t, owner, member } = await ownerAndMember();
		const tools = await turnFor(t, member);
		const other = await signIn(t, "other@else.com");
		await other.mutation(api.recordTypes.create, { plural: "Clients" });
		const theirs = await turnFor(t, other);
		const secret = await theirs.save({ type: "client", values: { name: "Their client" } });
		expect(await tools.get(secret.id)).toEqual({ error: "Record not found." });
		expect(await tools.save({ id: secret.id, values: { name: "Mine now" } })).toEqual({ error: "Record not found." });
		expect(await tools.undo(secret.change!)).toEqual({ error: "Change not found." });
		expect((await tools.find({ search: "Their client" })).rows).toEqual([]);
		expect(await tools.save({ type: "deal", values: { name: "x", client: secret.id } })).toEqual({ error: expect.stringContaining("doesn't exist") });
		const otherType = (await other.query(api.recordTypes.list))[0]!._id;
		expect(await tools.find({ type: otherType })).toEqual({ error: expect.stringContaining("no database") });
		const row = await t.run((ctx) => ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first());
		await owner.mutation(api.workspace.removeMember, { id: row!._id as Id<"members"> });
		await expect(tools.save({ type: "client", values: { name: "After" } })).rejects.toThrow("no longer in the workspace");
		await expect(tools.types()).rejects.toThrow("no longer in the workspace");
	});
});
