import { Transform } from "@tiptap/pm/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { DELTA_MAX_BYTES, IDLE_MS, PAGE_MAX_BYTES, PAGE_VERSIONS_MAX, VERSION_MS, pageSchema, readDoc, sync } from "../convex/pageOps";
import { type As, agentsOf, generalOf, agentTurn, settle, setup, signIn } from "./helpers";

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
const snapshotAt = (t: T, pageId: Id<"pages">, version?: number) =>
	t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: pageId, version })) as Promise<{ content: string | null; version?: number }>;

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

		// A pause starts a new one. Others editing meanwhile (people, or agents for them) join it, so
		// co-editing can't flood history past PAGE_VERSIONS_MAX.
		vi.advanceTimersByTime(IDLE_MS + 1);
		await type(t, owner, pageId, "a ");
		await type(t, member, pageId, "b ");
		await (await turnFor(t, member)).write({ page: pageId, mode: "append" }, [paragraph("From the agent")]);
		await type(t, owner, pageId, "1 ");
		await type(t, member, pageId, "2 ");
		const history = await historyOf(owner, pageId);
		expect(history.map((h) => [h.user, h.agent, h.others])).toEqual([
			["owner@co.com", null, [{ user: "member@co.com", agent: null }, { user: "member@co.com", agent: "Companybot" }]],
			["owner@co.com", null, []],
		]);
		// Every version can still be opened.
		for (const h of history) expect(await owner.query(api.pages.version, { versionId: h._id })).toBeTypeOf("string");
		expect(await textOf(t, pageId)).toBe("2 1 b a there Hello From the agent");
		vi.advanceTimersByTime(IDLE_MS + 1);
		await type(t, member, pageId, "c ");
		expect((await historyOf(owner, pageId))[0]).toMatchObject({ user: "member@co.com", others: [] });
	});

	it("restores an old version as a new one, so nothing is lost", async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "SOP" });
		await type(t, owner, pageId, "Hello");
		vi.advanceTimersByTime(IDLE_MS + 1);
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

	it("saves accepted edits before a client snapshot and ignores forged or delayed snapshots", async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Concurrent" });
		await type(t, owner, pageId, "First");
		const first = (await historyOf(owner, pageId))[0]!;
		vi.advanceTimersByTime(IDLE_MS + 1);
		const editor = t.withIdentity({ subject: `${member.userId}|session` });
		const current = await t.run(async (ctx) => { const { doc, version } = await sync.getDoc(ctx, pageId, pageSchema()); return { doc: doc.toJSON(), version }; });
		const tr = new Transform(pageSchema().nodeFromJSON(current.doc)).insert(3, pageSchema().text("Second "));
		const steps = tr.steps.map((s) => JSON.stringify(s.toJSON()));
		await editor.mutation(api.pageSync.submitSteps, { id: pageId, version: current.version, clientId: "second", steps });
		const second = (await historyOf(owner, pageId))[0]!;
		expect(second.user).toBe("member@co.com");
		await owner.mutation(api.pages.restore, { versionId: first._id });
		expect(await textOf(t, pageId)).toBe("First");
		// A snapshot can neither invent a future version nor rewrite an accepted one.
		await editor.mutation(api.pageSync.submitSnapshot, { id: pageId, version: 999_999, content: "{}" });
		await editor.mutation(api.pageSync.submitSnapshot, { id: pageId, version: current.version + steps.length, content: JSON.stringify(tr.doc.toJSON()) });
		expect(await textOf(t, pageId)).toBe("First");
		await owner.mutation(api.pages.restore, { versionId: second._id });
		expect(await textOf(t, pageId)).toBe("Second First");
		const stale = await editor.mutation(api.pageSync.submitSteps, { id: pageId, version: current.version, clientId: "second", steps });
		expect(stale.status).toBe("needs-rebase");
		await expect(editor.mutation(api.pageSync.submitSteps, { id: pageId, version: 999_999, clientId: "second", steps })).rejects.toThrow("Invalid page version");
	});

	it("ends continuous groups at ten minutes and updates edited time within a group", async () => {
		const { t, owner } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Long edit" });
		for (let i = 0; i < 11; i++) {
			await type(t, owner, pageId, "x");
			vi.advanceTimersByTime(VERSION_MS / 10 + 1000);
		}
		expect(await historyOf(owner, pageId)).toHaveLength(2);
		const before = (await owner.query(api.pages.list, {}))[0]!.updatedAt;
		await type(t, owner, pageId, "y");
		expect((await owner.query(api.pages.list, {}))[0]!.updatedAt).toBeGreaterThan(before);
	});

	it("bounds the document, each block and each stored delta in bytes, including multibyte text", async () => {
		// The component reads up to 100 deltas at once, twice when it deletes them, plus a few snapshots.
		expect(2 * 100 * DELTA_MAX_BYTES + 4 * PAGE_MAX_BYTES).toBeLessThan(16 * 2 ** 20);
		const { t, owner } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Large" });
		await expect(type(t, owner, pageId, "a".repeat(DELTA_MAX_BYTES))).rejects.toThrow("too much");
		await expect(type(t, owner, pageId, "🌙".repeat(DELTA_MAX_BYTES / 4))).rejects.toThrow("too much");
		await type(t, owner, pageId, "a".repeat(DELTA_MAX_BYTES / 2));
		// Typing on in one block stops before it outgrows a delta.
		await expect(type(t, owner, pageId, "a".repeat(DELTA_MAX_BYTES / 2))).rejects.toThrow("too much");
		const tools = await turnFor(t, owner);
		for (let i = 0; i < 9; i++) await tools.write({ page: pageId }, [paragraph("b".repeat(50_000))]);
		expect(await tools.write({ page: pageId }, [paragraph("c".repeat(50_000))])).toMatchObject({ error: expect.stringContaining("too long") });
		expect((await textOf(t, pageId)).length).toBe(DELTA_MAX_BYTES / 2 + 450_000);
		// A whole-page change goes in a block at a time, so the biggest page can still be restored.
		const [biggest] = await historyOf(owner, pageId);
		vi.advanceTimersByTime(IDLE_MS + 1);
		await tools.write({ page: pageId, mode: "replace" }, [paragraph("short")]);
		await owner.mutation(api.pages.restore, { versionId: biggest!._id });
		expect((await textOf(t, pageId)).length).toBe(DELTA_MAX_BYTES / 2 + 450_000);
	});

	it("compacts large deltas and deletes snapshots and deltas across bounded component batches", async () => {
		const { t, owner } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Large cleanup" });
		const tools = await turnFor(t, owner);
		// Over a hundred 50 KB deltas: the component cleans up 100 at a time, rescheduling the rest.
		for (let i = 0; i < 60; i++) await tools.write({ page: pageId, mode: "replace" }, [paragraph(String(i).padEnd(50_000, "x")), paragraph("y".repeat(50_000))]);
		vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
		await type(t, owner, pageId, "compacted");
		await settle(t);
		await owner.mutation(api.pages.setArchived, { pageId, archived: true });
		await owner.mutation(api.pages.remove, { pageId });
		await settle(t);
		expect(await snapshotAt(t, pageId)).toEqual({ content: null });
		expect(await t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id: pageId }))).toBeNull();
	});

	it(`keeps the latest ${PAGE_VERSIONS_MAX} versions, deleting older ones with their snapshots`, { timeout: 60_000 }, async () => {
		const { t, owner, member } = await setup();
		const pageId = await owner.mutation(api.pages.create, { title: "Busy" });
		for (let i = 0; i < PAGE_VERSIONS_MAX + 2; i++) {
			await type(t, i % 2 ? member : owner, pageId, "x");
			vi.advanceTimersByTime(IDLE_MS + 1);
		}
		const rows = await t.run((ctx) => ctx.db.query("pageVersions").collect());
		expect(rows).toHaveLength(PAGE_VERSIONS_MAX);
		expect(rows[0]!.n).toBe(3);
		// The first two versions' snapshots are gone (the page's first one stays).
		expect((await snapshotAt(t, pageId, rows[0]!.version - 1)).version).toBe(1);
	});
});

describe("pages", () => {
	it("are created, renamed, deleted to Trash and deleted forever, content and history too", async () => {
		const { t, owner, member } = await setup();
		const pageId = await member.mutation(api.pages.create, { title: "  Meeting   notes " });
		await member.mutation(api.pages.rename, { pageId, title: "Weekly notes" });
		expect(await owner.query(api.pages.list, {})).toEqual([expect.objectContaining({ _id: pageId, title: "Weekly notes" })]);
		await type(t, member, pageId, "Agenda");
		await member.mutation(api.trash.move, { kind: "page", id: pageId });
		expect(await owner.query(api.pages.list, {})).toEqual([]);
		expect(await member.query(api.pages.get, { pageId })).toMatchObject({ archived: true, canEdit: false, trash: { by: "member@co.com", canRestore: true } });
		await expect(type(t, member, pageId, "more")).rejects.toThrow("in Trash");
		await expect(member.mutation(api.trash.purge, { id: pageId })).rejects.toThrow("permission");
		await owner.mutation(api.trash.purge, { id: pageId });
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
		await expect(type(t, owner, pageId, "x")).rejects.toThrow("record is in Trash");
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

		await tools.write({ page: pageId, trash: true });
		expect(await tools.write({ page: pageId, markdown: "x" }, [paragraph("no")])).toMatchObject({ error: expect.stringContaining("in Trash") });
		expect(await tools.write({ title: "A", trash: true })).toMatchObject({ error: expect.stringContaining("on its own") });
	});

	it("rechecks the acting person's membership on each call", async () => {
		const { t, owner, member } = await setup();
		const tools = await turnFor(t, member);
		const pageId = await owner.mutation(api.pages.create, { title: "Workspace only" });
		const other = await signIn(t, "other@co.com");
		const otherPage = await other.mutation(api.pages.create, { title: "Other workspace" });
		expect(await tools.read({ page: otherPage })).toMatchObject({ error: expect.any(String) });
		expect(await tools.write({ page: otherPage, title: "Stolen" })).toMatchObject({ error: expect.any(String) });
		await t.run(async (ctx) => {
			const seat = await ctx.db.query("members").withIndex("by_user", q => q.eq("userId", member.userId)).first();
			await ctx.db.delete(seat!._id);
		});
		await expect(tools.read({ page: pageId })).rejects.toThrow("no longer in the workspace");
		await expect(tools.write({ page: pageId, title: "No" })).rejects.toThrow("no longer in the workspace");
	});

	it("stops page tools when the acting person loses access to a private chat", async () => {
		const { t, member } = await setup();
		const chatId = await member.mutation(api.chats.createChannel, { name: "private-plans", private: true });
		const { companybot } = await agentsOf(member);
		const turnId = await agentTurn(t, member, chatId, companybot._id);
		const pageId = await member.mutation(api.pages.create, { title: "Team plans" });
		await t.run(async (ctx) => {
			const seat = await ctx.db.query("chatMembers").withIndex("by_chat", q => q.eq("chatId", chatId)).first();
			await ctx.db.delete(seat!._id);
		});
		await expect(t.query(internal.pageTools.readFor, { turnId, page: pageId })).rejects.toThrow("no longer see this chat");
		await expect(t.mutation(internal.pageTools.writeFor, { turnId, input: { page: pageId, title: "No" } })).rejects.toThrow("no longer see this chat");
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
