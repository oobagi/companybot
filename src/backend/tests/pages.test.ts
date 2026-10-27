import { Transform } from "@tiptap/pm/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { IDLE_MS, PAGE_VERSIONS_MAX, pageSchema, readDoc, sync } from "../convex/pageOps";
import { type As, agentsOf, generalOf, settle, setup, signIn } from "./helpers";

// Pages (pageOps.ts): the editor's sync, versions grouped like Notion's, restore, agent tools, and cleanup.

type T = Awaited<ReturnType<typeof setup>>["t"];
type Person = Awaited<ReturnType<typeof signIn>>;

/** Types `text` at the start of the page as `as`'s editor does: steps, then a snapshot. */
async function type(t: T, as: Person, pageId: Id<"pages">, text: string) {
	const editor = t.withIdentity({ subject: `${as.userId}|session` });
	const { doc, version } = await t.run(async (ctx) => {
		const latest = await sync.getDoc(ctx, pageId, pageSchema());
		return { doc: latest.doc.toJSON(), version: latest.version };
	});
	const tr = new Transform(pageSchema().nodeFromJSON(doc)).insert(3, pageSchema().text(text));
	const steps = tr.steps.map((s) => JSON.stringify(s.toJSON()));
	await editor.mutation(api.pageSync.submitSteps, { id: pageId, version, clientId: "editor", steps });
	await editor.mutation(api.pageSync.submitSnapshot, { id: pageId, version: version + steps.length, content: JSON.stringify(tr.doc.toJSON()) });
}

const textOf = (t: T, pageId: Id<"pages">) => t.run(async (ctx) => (await readDoc(ctx, pageId)).textContent);
const historyOf = async (as: As, pageId: Id<"pages">) => (await as.query(api.pages.history, { pageId, paginationOpts: { numItems: 20, cursor: null } })).page;
/** The component's newest snapshot at or before `version`. */
const snapshotAt = (t: T, pageId: Id<"pages">, version?: number) => t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: pageId, version }));

/** A running Companybot turn for `as`, and its pages tools as the runner calls them (markdown already converted). */
async function turnFor(t: T, as: Person) {
	const { companybot } = await agentsOf(as);
	const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	await as.mutation(api.messages.send, { chatId: (await generalOf(as))._id, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
	const turnId = (await t.run((ctx) => ctx.db.query("agentTurns").collect())).find((x) => !before.some((b) => b._id === x._id))!._id;
	return {
		read: (input: { page?: string; record?: string }) => t.query(internal.pageTools.readFor, { turnId, ...input }),
		write: (input: object, blocks?: object[]) =>
			t.mutation(internal.pageTools.writeFor, { turnId, input, ...(blocks && { blocks: JSON.stringify(blocks) }) }) as Promise<Record<string, string>>,
	};
}

/** A paragraph block, as pageMarkdown.fromMarkdown makes them. */
const paragraph = (text: string) => ({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("page history", () => {
	it("groups one person's continuous edits into one version, like Notion", async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Onboarding" });
		await type(t, owner, pageId, "Hello ");
		const first = (await historyOf(owner, pageId))[0]!;
		vi.advanceTimersByTime(IDLE_MS / 2);
		await type(t, owner, pageId, "there ");
		expect(await historyOf(owner, pageId)).toEqual([expect.objectContaining({ _id: first._id, user: "owner@co.com", agent: null })]);
		// The run's earlier snapshot went; the page's first (empty) one stays.
		expect((await snapshotAt(t, pageId, 2)).version).toBe(1);

		// A pause, another person, or an agent each start a new one.
		vi.advanceTimersByTime(IDLE_MS + 1);
		await type(t, owner, pageId, "a ");
		await type(t, member, pageId, "b ");
		await (await turnFor(t, member)).write({ page: pageId, mode: "append" }, [paragraph("From the agent")]);
		const history = await historyOf(owner, pageId);
		expect(history.map((h) => [h.user, h.agent])).toEqual([
			["member@co.com", "Companybot"],
			["member@co.com", null],
			["owner@co.com", null],
			["owner@co.com", null],
		]);
		// Every version can still be opened.
		for (const h of history) expect(await owner.query(api.pages.version, { versionId: h._id })).toBeTypeOf("string");
		expect(await textOf(t, pageId)).toBe("b a there Hello From the agent");
	});

	it("restores an old version as a new one, so nothing is lost", async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "SOP" });
		await type(t, owner, pageId, "Hello");
		await type(t, member, pageId, "World ");
		const [newest, oldest] = await historyOf(owner, pageId);
		await member.mutation(api.pages.restore, { versionId: oldest!._id });
		expect(await textOf(t, pageId)).toBe("Hello");
		const history = await historyOf(owner, pageId);
		expect(history).toHaveLength(3);
		expect(history[0]).toMatchObject({ user: "member@co.com", restored: oldest!.time });
		// The version it replaced is still there, and can be brought back too.
		await owner.mutation(api.pages.restore, { versionId: newest!._id });
		expect(await textOf(t, pageId)).toBe("World Hello");
	});

	it(`keeps the latest ${PAGE_VERSIONS_MAX} versions, deleting older ones with their snapshots`, { timeout: 60_000 }, async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Busy" });
		for (let i = 0; i < PAGE_VERSIONS_MAX + 2; i++) await type(t, i % 2 ? member : owner, pageId, "x");
		const rows = await t.run((ctx) => ctx.db.query("pageVersions").collect());
		expect(rows).toHaveLength(PAGE_VERSIONS_MAX);
		expect(rows[0]!.n).toBe(3);
		// The first two versions' snapshots are gone (the page's first one stays).
		expect((await snapshotAt(t, pageId, rows[0]!.version - 1)).version).toBe(1);
	});
});

describe("pages", () => {
	it("are created, renamed, archived and deleted, content and history too", async () => {
		const { t, owner, member } = await setup();
		const pageId = await member.mutation(api.pages.create, { title: "  Meeting   notes " });
		await member.mutation(api.pages.rename, { pageId, title: "Weekly notes" });
		expect(await owner.query(api.pages.list, {})).toEqual([expect.objectContaining({ _id: pageId, title: "Weekly notes" })]);
		await type(t, member, pageId, "Agenda");
		await expect(member.mutation(api.pages.remove, { pageId })).rejects.toThrow("Archive the page first");
		await member.mutation(api.pages.setArchived, { pageId, archived: true });
		expect(await owner.query(api.pages.list, {})).toEqual([]);
		await expect(type(t, member, pageId, "more")).rejects.toThrow("archived");
		await member.mutation(api.pages.remove, { pageId });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("pageVersions").collect())).toEqual([]);
		expect(await snapshotAt(t, pageId)).toEqual({ content: null });
		expect(await t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id: pageId }))).toBeNull();
	});

	it("are deleted with their workspace, content included", async () => {
		const { t, owner } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Wiki" });
		await type(t, owner, pageId, "Hi");
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual([]);
		expect(await snapshotAt(t, pageId)).toEqual({ content: null });
	});

	it("are only reachable from their own workspace", async () => {
		const { t, owner } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Private plans" });
		const other = await signIn(t, "other@co.com");
		await expect(t.withIdentity({ subject: `${other.userId}|session` }).query(api.pageSync.getSnapshot, { id: pageId })).rejects.toThrow("Page not found");
		await expect(type(t, other, pageId, "x")).rejects.toThrow("Page not found");
		expect(await other.query(api.pages.get, { pageId })).toBeNull();
		await expect(other.mutation(api.pages.rename, { pageId, title: "Mine" })).rejects.toThrow();
	});

	it("give every record a body, created when someone first writes in it", async () => {
		const { t, owner } = await setup();
		const types = await owner.query(api.recordTypes.list);
		const client = types.find((x) => x.key === "client")!;
		const recordId = await owner.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		expect(await owner.query(api.pages.forRecord, { recordId })).toBeNull();
		const pageId = await owner.mutation(api.pages.create, { recordId });
		expect(await owner.mutation(api.pages.create, { recordId })).toBe(pageId);
		expect(await owner.query(api.pages.forRecord, { recordId })).toBe(pageId);
		await expect(owner.mutation(api.pages.rename, { pageId, title: "x" })).rejects.toThrow("Rename the record");
		// Bodies aren't standalone pages.
		expect(await owner.query(api.pages.list, {})).toEqual([]);
		await owner.mutation(api.records.archive, { recordId });
		await expect(type(t, owner, pageId, "x")).rejects.toThrow("record is archived");
	});
});

describe("pages tools", () => {
	it("create, read, append, replace and restore as Companybot for the person", async () => {
		const { t, member } = await setup();
		const tools = await turnFor(t, member);
		const made = await tools.write({ title: "Pricing", markdown: "x" }, [paragraph("Roofs are $10/sqft")]);
		expect(made).toMatchObject({ title: "Pricing" });
		const pageId = made.id as Id<"pages">;
		await tools.write({ page: "Pricing", markdown: "x" }, [paragraph("Gutters are extra")]);
		expect(await textOf(t, pageId)).toBe("Roofs are $10/sqftGutters are extra");
		await tools.write({ page: pageId, markdown: "x", mode: "replace" }, [paragraph("Call for a quote")]);
		expect(await textOf(t, pageId)).toBe("Call for a quote");

		const read = await tools.read({ page: "Pricing" });
		if ("error" in read) throw new Error(read.error);
		// One continuous run by the agent for them: one version.
		expect(read.versions).toEqual([expect.objectContaining({ by: "member@co.com", agent: "Companybot" })]);
		expect(read.doc).toContain("Call for a quote");

		await tools.write({ page: pageId, archived: true });
		expect(await tools.write({ page: pageId, markdown: "x" }, [paragraph("no")])).toMatchObject({ error: expect.stringContaining("archived") });
		expect(await tools.write({ title: "A", archived: true })).toMatchObject({ error: expect.stringContaining("on its own") });
	});

	it("write a record's body, creating it on first write", async () => {
		const { t, member } = await setup();
		const client = (await member.query(api.recordTypes.list)).find((x) => x.key === "client")!;
		const recordId = await member.mutation(api.records.create, { typeId: client._id, values: { name: "Acme" } });
		const tools = await turnFor(t, member);
		expect(await tools.read({ record: recordId })).toMatchObject({ title: "Acme", doc: null, versions: [] });
		const wrote = await tools.write({ record: recordId, markdown: "x" }, [paragraph("Prefers email")]);
		expect(wrote).toMatchObject({ title: "Acme" });
		const pageId = (await member.query(api.pages.forRecord, { recordId }))!;
		expect(await textOf(t, pageId)).toBe("Prefers email");
		expect((await historyOf(member, pageId))[0]).toMatchObject({ user: "member@co.com", agent: "Companybot" });
	});
});

describe("page markdown", () => {
	it("converts both ways, for agent tools", async () => {
		const { t } = await setup();
		const markdown = "# Plan\n\n- [ ] Call Acme\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
		const blocks = JSON.parse(await t.action(internal.pageMarkdown.fromMarkdown, { markdown })) as object[];
		const doc = JSON.stringify({ type: "doc", content: [{ type: "blockGroup", content: blocks }] });
		const back = await t.action(internal.pageMarkdown.toMarkdown, { doc });
		expect(back).toContain("# Plan");
		expect(back).toContain("[ ] Call Acme");
		expect(back).toMatch(/\| 1 +\| 2 +\|/);
	});
});
