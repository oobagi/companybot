import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { PAGE_DEPTH_MAX } from "../convex/pageTree";
import { IDLE_MS, readDoc, writeBlocks } from "../convex/pageOps";
import { memberOf } from "../convex/lib";
import { TRASH_MS } from "../convex/trashOps";
import { agentTurn, agentsOf, generalOf, settle, ownerAndMember, signIn, identityOf } from "./helpers";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());
const opts = { paginationOpts: { numItems: 50, cursor: null } };

describe("nested pages", () => {
	it("lists paged levels and breadcrumbs while old clients still get a flat list", async () => {
		const { owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		const leaf = await owner.mutation(api.pages.create, { title: "Checklist", parentId: child });
		expect((await owner.query(api.pages.list, {})).map((p) => p._id)).toEqual([leaf, child, root]);
		expect((await owner.query(api.pages.children, opts)).page.map((p) => p._id)).toEqual([root]);
		expect((await owner.query(api.pages.children, { ...opts, parentId: root })).page.map((p) => p._id)).toEqual([child]);
		expect(await owner.query(api.pages.get, { pageId: leaf })).toMatchObject({ parentId: child, ancestors: [{ _id: root }, { _id: child }] });
		expect(await owner.query(api.pages.get, { pageId: "invalid-link" })).toBeNull();
	});

	it("keeps record bodies out of the top level, so they can't page standalone pages out of view", async () => {
		const { owner } = await ownerAndMember();
		const type = (await owner.query(api.recordTypes.list))[0]!;
		for (let i = 0; i < 60; i++) await owner.mutation(api.pages.create, { recordId: await owner.mutation(api.records.create, { typeId: type._id, values: { name: `R${i}` } }) });
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		expect((await owner.query(api.pages.children, opts)).page).toEqual([expect.objectContaining({ _id: root, hasChildren: true })]);
	});

	it("rejects cycles, foreign parents, record bodies and moves after membership is revoked", async () => {
		const { t, owner, member } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Root" });
		const child = await owner.mutation(api.pages.create, { title: "Child", parentId: root });
		await expect(owner.mutation(api.pages.move, { pageId: root, parentId: child })).rejects.toThrow("descendants");
		await expect(owner.mutation(api.pages.move, { pageId: root, parentId: root })).rejects.toThrow("descendants");
		const other = await signIn(t, "other@co.com");
		const foreign = await other.mutation(api.pages.create, { title: "Foreign" });
		await expect(owner.mutation(api.pages.move, { pageId: root, parentId: foreign })).rejects.toThrow("Page not found");
		await expect(other.mutation(api.pages.create, { title: "Foreign child", parentId: root })).rejects.toThrow("Page not found");
		const type = (await owner.query(api.recordTypes.list))[0]!;
		const recordId = await owner.mutation(api.records.create, { typeId: type._id, values: { name: "Record" } });
		const body = await owner.mutation(api.pages.create, { recordId });
		await expect(owner.mutation(api.pages.create, { recordId, parentId: root })).rejects.toThrow("can't be nested");
		await expect(owner.mutation(api.pages.create, { title: "No", parentId: body })).rejects.toThrow("Record bodies");
		await expect(owner.mutation(api.pages.move, { pageId: body, parentId: root })).rejects.toThrow("Record bodies");
		await t.run(async (ctx) => {
			const seat = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", member.userId)).first();
			await ctx.db.delete(seat!._id);
		});
		await expect(member.mutation(api.pages.move, { pageId: child })).rejects.toThrow();
	});

	it("prunes saved expansion ids for deleted, inherited-Trash, foreign and invalid pages in bounded batches", async () => {
		const { t, owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Root" });
		const child = await owner.mutation(api.pages.create, { title: "Child", parentId: root });
		const other = await signIn(t, "other@co.com");
		const foreign = await other.mutation(api.pages.create, { title: "Foreign" });
		expect(await owner.query(api.pages.liveIds, { ids: [root, child, foreign, "invalid"] })).toEqual([root, child]);
		await expect(owner.query(api.pages.liveIds, { ids: Array(101).fill(root) })).rejects.toThrow("100");
		expect(await t.query(api.pages.liveIds, { ids: [root] })).toBeNull();
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		expect(await owner.query(api.pages.liveIds, { ids: [root, child] })).toEqual([]);
		await owner.mutation(api.trash.purge, { id: root });
		await settle(t);
		expect(await owner.query(api.pages.liveIds, { ids: [root, child] })).toEqual([]);
	});

	it("labels subtree Trash only when live children were actually deleted with the parent", async () => {
		const { owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Root" });
		const child = await owner.mutation(api.pages.create, { title: "Child", parentId: root });
		await owner.mutation(api.pages.create, { title: "Grandchild", parentId: child });
		await owner.mutation(api.trash.move, { kind: "page", id: child });
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		const entries = (await owner.query(api.trash.list, opts)).page;
		expect(entries.find((e) => e.itemId === root)).toMatchObject({ hasChildren: false });
		expect(entries.find((e) => e.itemId === child)).toMatchObject({ hasChildren: true });
		await owner.mutation(api.trash.restore, { kind: "page", id: root });
		await owner.mutation(api.pages.create, { title: "Live child", parentId: root });
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		expect((await owner.query(api.trash.list, opts)).page.find((e) => e.itemId === root)).toMatchObject({ hasChildren: true });
	});

	it("moves an entire branch and attributes metadata history without changing content history", async () => {
		const { owner, member } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		const leaf = await owner.mutation(api.pages.create, { title: "Checklist", parentId: child });
		await member.mutation(api.pages.move, { pageId: child });
		expect(await owner.query(api.pages.get, { pageId: leaf })).toMatchObject({ ancestors: [{ _id: child }] });
		expect((await owner.query(api.pages.moves, { pageId: child, ...opts })).page).toEqual([expect.objectContaining({ from: "Wiki", to: "Pages", user: "member@co.com", agent: null })]);
		expect((await owner.query(api.pages.history, { pageId: child, ...opts })).page).toEqual([]);
	});

	it("bounds depth on creation and deeper moves, including descendants", async () => {
		const { owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Root" });
		let deepest = root;
		for (let i = 1; i < PAGE_DEPTH_MAX; i++) deepest = await owner.mutation(api.pages.create, { title: `Level ${i}`, parentId: deepest });
		await expect(owner.mutation(api.pages.create, { title: "Too deep", parentId: deepest })).rejects.toThrow("levels deep");
		const destination = await owner.mutation(api.pages.create, { title: "Destination" });
		await expect(owner.mutation(api.pages.move, { pageId: root, parentId: destination })).rejects.toThrow("levels deep");
		expect((await owner.query(api.pages.get, { pageId: deepest }))!.ancestors).toHaveLength(PAGE_DEPTH_MAX - 1);
	});

	it("gates the whole subtree atomically, restores it once, and preserves independently deleted children", async () => {
		const { t, owner, member } = await ownerAndMember();
		const root = await member.mutation(api.pages.create, { title: "Wiki" });
		const child = await member.mutation(api.pages.create, { title: "Guide", parentId: root });
		const leaf = await member.mutation(api.pages.create, { title: "Checklist", parentId: child });
		await member.mutation(api.trash.move, { kind: "page", id: leaf });
		await member.mutation(api.trash.move, { kind: "page", id: root });
		expect((await owner.query(api.trash.list, opts)).page).toHaveLength(2);
		expect((await owner.query(api.trash.list, opts)).page.find((p) => p.itemId === root)).toMatchObject({ hasChildren: true });
		expect(await owner.query(api.pages.list, {})).toEqual([]);
		expect(await owner.query(api.pages.get, { pageId: child })).toMatchObject({ archived: true, canEdit: false, trash: { itemId: root } });
		expect((await owner.query(api.pages.children, { ...opts, parentId: root })).page).toEqual([]);
		await expect(owner.mutation(api.pages.rename, { pageId: child, title: "No" })).rejects.toThrow("in Trash");
		await expect(owner.mutation(api.pages.move, { pageId: child })).rejects.toThrow("in Trash");
		await expect(owner.mutation(api.pages.create, { title: "No", parentId: child })).rejects.toThrow("in Trash");
		const raw = identityOf(t, member.userId);
		await expect(raw.mutation(api.pageSync.submitSteps, { id: child, version: 1, clientId: "old-editor", steps: [] })).rejects.toThrow("in Trash");
		await member.mutation(api.trash.restore, { kind: "page", id: root });
		expect((await owner.query(api.pages.list, {})).map((p) => p._id)).toEqual([child, root]);
		expect(await owner.query(api.pages.get, { pageId: leaf })).toMatchObject({ archived: true });
	});

	it("restores a separately trashed child to top level when its parent is unavailable, respecting restore authority", async () => {
		const { t, owner, member } = await ownerAndMember();
		const root = await member.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		await owner.mutation(api.trash.move, { kind: "page", id: child });
		await member.mutation(api.trash.move, { kind: "page", id: root });
		// Anyone who can edit pages can restore one, whoever deleted it.
		await member.mutation(api.trash.restore, { kind: "page", id: child });
		expect(await owner.query(api.pages.get, { pageId: child })).toMatchObject({ parentId: null, archived: false });
		// A missing parent also falls back to Pages (e.g. an old orphan), unless its purge is in progress.
		await owner.mutation(api.trash.restore, { kind: "page", id: root });
		await owner.mutation(api.pages.move, { pageId: child, parentId: root });
		await owner.mutation(api.trash.move, { kind: "page", id: child });
		await t.run((ctx) => ctx.db.delete(root));
		await owner.mutation(api.trash.restore, { kind: "page", id: child });
		expect(await owner.query(api.pages.get, { pageId: child })).toMatchObject({ parentId: null });
	});

	it("purges all descendants, versions, content and separate Trash entries, refusing a mid-purge escape", async () => {
		const { t, owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		const leaf = await owner.mutation(api.pages.create, { title: "Checklist", parentId: child });
		await t.run(async (ctx) => {
			const page = (await ctx.db.get(leaf))!;
			const member = (await memberOf(ctx, owner.userId, page.workspaceId))!;
			await writeBlocks(ctx, { member }, page, JSON.stringify([{ type: "blockContainer", attrs: { id: "leaf-block" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nested content with a version" }] }] }]), "replace");
		});
		expect((await owner.query(api.pages.history, { pageId: leaf, ...opts })).page).toHaveLength(1);
		await owner.mutation(api.pages.move, { pageId: leaf });
		await owner.mutation(api.pages.move, { pageId: leaf, parentId: child });
		await owner.mutation(api.trash.move, { kind: "page", id: child });
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		await owner.mutation(api.trash.purge, { id: root });
		await expect(owner.mutation(api.trash.restore, { kind: "page", id: child })).rejects.toThrow("being deleted forever");
		await settle(t);
		expect((await owner.query(api.pages.children, { parentId: child, ...opts })).page).toEqual([]);
		expect((await owner.query(api.pages.moves, { pageId: child, ...opts })).page).toEqual([]);
		for (const table of ["pages", "pageVersions", "pageMoves", "trash", "cascades"] as const) expect(await t.run((ctx) => ctx.db.query(table).first()), table).toBeNull();
		for (const id of [root, child, leaf]) expect(await t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id }))).toBeNull();
	});

	it("sweeps a subtree after 30 days", async () => {
		const { t, owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		await t.run(async (ctx) => {
			const entry = await ctx.db.query("trash").withIndex("by_item", (q) => q.eq("itemId", root)).first();
			await ctx.db.patch(entry!._id, { deletedAt: Date.now() - TRASH_MS - 1 });
		});
		await t.mutation(internal.trash.sweep, {});
		await settle(t);
		expect(await owner.query(api.pages.get, { pageId: child })).toBeNull();
	});

	it("gives agents parent creation, tree reads, moves, sub-page lists and attribution through the same rules", async () => {
		const { t, owner, member } = await ownerAndMember();
		const turnId = await agentTurn(t, member, (await generalOf(member))._id, (await agentsOf(member)).companybot._id);
		const write = (input: object) => t.mutation(internal.pageTools.writeFor, { turnId, input });
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const made = await write({ title: "Guide", parent: "Wiki" }) as { id: Id<"pages"> };
		const tree = await t.query(internal.pageTools.findFor, { turnId, input: { parent: root } });
		expect(tree.rows).toEqual([expect.objectContaining({ id: made.id, parentId: root })]);
		const read = await t.query(internal.pageTools.readFor, { turnId, page: root });
		expect(read).toMatchObject({ subpages: [{ id: made.id, title: "Guide" }], subpagesMore: false });
		expect(await write({ action: "move", page: root, parent: made.id })).toMatchObject({ error: expect.stringContaining("descendants") });
		await write({ action: "move", page: made.id, parent: null });
		expect((await member.query(api.pages.moves, { pageId: made.id, ...opts })).page[0]).toMatchObject({ agent: "Companybot", user: "member@co.com" });
		await owner.mutation(api.trash.move, { kind: "page", id: root });
		expect(await write({ action: "move", page: made.id, parent: root })).toMatchObject({ error: expect.stringContaining("in Trash") });
		expect(await write({ title: "No blank page", parent: root })).toMatchObject({ error: expect.any(String) });
		const trashedChild = await owner.mutation(api.pages.create, { title: "Guide", parentId: made.id });
		await owner.mutation(api.trash.move, { kind: "page", id: made.id });
		expect((await t.query(internal.pageTools.findFor, { turnId, input: { parent: made.id, trashed: true } })).rows).toEqual([expect.objectContaining({ id: trashedChild })]);
		const live = await write({ title: "Guide" }) as { id: string };
		expect(await t.query(internal.pageTools.readFor, { turnId, page: "Guide" })).toMatchObject({ id: live.id });
		expect((await owner.query(api.pages.list, {})).map((p) => p.title)).toEqual(["Guide"]);
	});

	it("keeps alpha.7-compatible page link blocks through Markdown, sync and history, and removing one keeps the child", async () => {
		const { t, owner } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Guide", parentId: root });
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, (await agentsOf(owner)).companybot._id);
		const blocks = await t.action(internal.pageMarkdown.fromMarkdown, { markdown: `[Guide](companybot://page/${child})` });
		await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: root, blocks, mode: "replace" } });
		const history = (await owner.query(api.pages.history, { pageId: root, ...opts })).page[0]!;
		expect(await owner.query(api.pages.version, { versionId: history._id })).toContain(child);
		const doc = await owner.query(api.pages.version, { versionId: history._id });
		expect(doc).toContain(`companybot://page/${child}`);
		expect(await t.action(internal.pageMarkdown.toMarkdown, { doc: doc! })).toContain(`[Guide](companybot://page/${child})`);
		await owner.mutation(api.pages.rename, { pageId: child, title: "Renamed" });
		expect(await t.run(async (ctx) => (await readDoc(ctx, root)).textContent)).toBe("Renamed");
		await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: root, blocks: "[]", mode: "replace" } });
		expect(await owner.query(api.pages.get, { pageId: child })).toMatchObject({ parentId: root, archived: false });
		expect(await t.run(async (ctx) => (await readDoc(ctx, root)).textContent)).toBe("");
	});

	it("relabels the parent's links to a renamed child, as the renamer, unless they were reworded", async () => {
		const { t, owner, member } = await ownerAndMember();
		const root = await owner.mutation(api.pages.create, { title: "Wiki" });
		const child = await owner.mutation(api.pages.create, { title: "Untitled", parentId: root });
		const link = (text: string) => ({ type: "text", text, marks: [{ type: "link", attrs: { href: `companybot://page/${child}` } }] });
		const block = (id: string, content: object[]) => ({ type: "blockContainer", attrs: { id }, content: [{ type: "paragraph", content }] });
		await t.run(async (ctx) => {
			const page = (await ctx.db.get(root))!;
			await writeBlocks(ctx, { member: (await memberOf(ctx, owner.userId, page.workspaceId))! }, page, JSON.stringify([block("a", [link("Untitled")]), block("b", [{ type: "text", text: "See " }, link("the guide")]), block("c", [{ type: "text", text: "Untitled" }])]), "replace");
		});
		vi.advanceTimersByTime(IDLE_MS + 1);
		await member.mutation(api.pages.rename, { pageId: child, title: "Roof SOP" });
		const blocks = await t.run(async (ctx) => (await readDoc(ctx, root)).firstChild!.content.content.map((b) => b.textContent));
		expect(blocks.slice(0, 3)).toEqual(["Roof SOP", "See the guide", "Untitled"]);
		const [latest, first] = (await owner.query(api.pages.history, { pageId: root, ...opts })).page;
		expect(latest!.user).not.toEqual(first!.user);
		// Renaming the parent, or to the same title, leaves the parent's content alone.
		await member.mutation(api.pages.rename, { pageId: root, title: "Handbook" });
		await member.mutation(api.pages.rename, { pageId: child, title: "Roof SOP" });
		expect((await owner.query(api.pages.history, { pageId: root, ...opts })).page).toHaveLength(2);
	});
});
