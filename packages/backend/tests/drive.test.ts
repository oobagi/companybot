import { DOCX, XLSX } from "@companybot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docx, pngOf, xlsx } from "../../core/test/files";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentTurn, agentsOf, generalOf, identityOf, noMentions, ownerAndMember, settle, signIn, upload, workspaceOf } from "./helpers";

// Drive (driveFiles.ts, pageTree.ts folders): folders hold pages, files and folders; files are claimed
// uploads; Who can access and Archive follow the folder; agents find, read and save files as their person.

afterEach(() => vi.useRealTimers());

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
const text = (s: string) => new TextEncoder().encode(s);
const opts = { paginationOpts: { numItems: 50, cursor: null } };

const filesIn = async (as: As, parentId?: Id<"pages">) => (await as.query(api.driveFiles.children, { parentId, ...opts })).page;
const pagesIn = async (as: As, parentId?: Id<"pages">) => (await as.query(api.pages.children, { parentId, ...opts })).page;
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));

/** A running Companybot turn for `as`, and its file tools as the runner calls them (agent.ts fileStore). */
async function turnFor(t: T, as: As, chatId?: Id<"chats">) {
	const { companybot } = await agentsOf(as);
	const turnId = await agentTurn(t, as, chatId ?? (await generalOf(as))._id, companybot._id);
	return {
		turnId,
		find: (input: object) => t.mutation(internal.driveTools.findFor, { turnId, input }) as Promise<{ rows: { id: string; name: string; folderId: string | null }[] } & { error?: string }>,
		read: (input: object) => t.mutation(internal.driveTools.readFor, { turnId, input }) as Promise<Record<string, unknown>>,
		write: (input: object, upload?: Id<"_storage">) => t.mutation(internal.driveTools.writeFor, { turnId, input, upload }) as Promise<Record<string, unknown>>,
	};
}

describe("folders", () => {
	it("hold pages, files and folders; pages hold sub-pages only; folders and files go in folders or at the top level", async () => {
		const { t, owner } = await ownerAndMember();
		const contracts = await owner.mutation(api.pages.create, { title: " Contracts ", kind: "folder" });
		const signed = await owner.mutation(api.pages.create, { title: "Signed", kind: "folder", parentId: contracts });
		const guide = await owner.mutation(api.pages.create, { title: "Guide", parentId: contracts });
		const sub = await owner.mutation(api.pages.create, { title: "Terms", parentId: guide });
		expect(await owner.query(api.pages.get, { pageId: contracts })).toMatchObject({ kind: "folder", title: "Contracts", canEdit: true });
		expect(await pagesIn(owner, contracts)).toEqual([
			expect.objectContaining({ _id: guide, kind: "page", hasChildren: true }),
			expect.objectContaining({ _id: signed, kind: "folder", hasChildren: false }),
		]);
		expect(await pagesIn(owner, guide)).toEqual([expect.objectContaining({ _id: sub, kind: "page" })]);
		await expect(owner.mutation(api.pages.create, { title: "Nope", kind: "folder", parentId: guide })).rejects.toThrow("Folders go in folders");
		await expect(owner.mutation(api.pages.move, { pageId: signed, parentId: guide })).rejects.toThrow("Folders go in folders");
		await expect(owner.mutation(api.driveFiles.add, { file: await upload(owner), parentId: guide })).rejects.toThrow("Files go in folders");
		await expect(owner.mutation(api.pages.move, { pageId: contracts, parentId: signed })).rejects.toThrow("inside itself");
		await expect(owner.mutation(api.pages.create, { title: "  ", kind: "folder" })).rejects.toThrow("Give the folder a name");
		// A folder has no content: the editor can't open it, and agents can't write in it.
		await expect(identityOf(t, owner.userId).query(api.pageSync.getSnapshot, { id: contracts })).rejects.toThrow("A folder has no content");
		expect((await owner.query(api.pages.history, { pageId: contracts, ...opts })).page).toEqual([]);
		// Pages in a folder are listed by the tree, and the folder shows in Move to… searches with its kind.
		await owner.mutation(api.pages.rename, { pageId: contracts, title: "Agreements" });
		expect(await owner.query(api.pages.search, { query: "agreements" })).toEqual([expect.objectContaining({ _id: contracts, kind: "folder" })]);
		expect(await owner.query(api.pages.list, {})).toEqual(expect.arrayContaining([expect.objectContaining({ _id: contracts, kind: "folder" }), expect.objectContaining({ _id: guide, kind: "page" })]));
	});

	it("go to Archive with everything in them, come back the same way, and are deleted forever with their files", async () => {
		const { t, owner } = await ownerAndMember();
		const folder = await owner.mutation(api.pages.create, { title: "Old", kind: "folder" });
		const inner = await owner.mutation(api.pages.create, { title: "Deeper", kind: "folder", parentId: folder });
		const storageId = await upload(owner, docx("Signed"), "msa.docx");
		const fileId = await owner.mutation(api.driveFiles.add, { file: storageId, parentId: inner });
		await owner.mutation(api.trash.move, { kind: "folder", id: folder });
		expect((await owner.query(api.trash.list, { ...opts })).page).toEqual([expect.objectContaining({ kind: "folder", itemId: folder, name: "Old", hasChildren: true })]);
		expect(await owner.query(api.driveFiles.get, { fileId })).toMatchObject({ archived: true, canEdit: false, trash: { name: "Old" } });
		expect(await filesIn(owner, inner)).toEqual([]);
		await expect(owner.mutation(api.driveFiles.rename, { fileId, name: "x.docx" })).rejects.toThrow("in Archive");
		await owner.mutation(api.trash.restore, { kind: "folder", id: folder });
		expect(await owner.query(api.driveFiles.get, { fileId })).toMatchObject({ archived: false, canEdit: true, trash: null });
		// A file archived on its own, then its folder deleted forever: the file and its entry go too.
		await owner.mutation(api.trash.move, { kind: "file", id: fileId });
		expect((await owner.query(api.trash.list, { kind: "file", ...opts })).page).toEqual([expect.objectContaining({ kind: "file", itemId: fileId, name: "msa.docx" })]);
		await owner.mutation(api.trash.move, { kind: "folder", id: folder });
		await owner.mutation(api.trash.purge, { id: folder });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("driveFiles").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("trash").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual([]);
		expect(await exists(t, storageId)).toBe(false);
	});

	it("restore a file to the top level when its folder is still in Archive, keeping the list it had", async () => {
		const { t, owner } = await ownerAndMember();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const folder = await owner.mutation(api.pages.create, { title: "Office only", kind: "folder" });
		await owner.mutation(api.pages.setAccess, { pageId: folder, access: [{ role: office, level: "edit" }] });
		const fileId = await owner.mutation(api.driveFiles.add, { file: await upload(owner), parentId: folder });
		await owner.mutation(api.trash.move, { kind: "file", id: fileId });
		await owner.mutation(api.trash.move, { kind: "folder", id: folder });
		await owner.mutation(api.trash.restore, { kind: "file", id: fileId });
		const row = (await t.run((ctx) => ctx.db.get(fileId)))!;
		expect(row.parentId).toBeUndefined();
		expect(row).toMatchObject({ archived: false, access: [{ role: office, level: "edit" }] });
		expect(await filesIn(owner)).toEqual([expect.objectContaining({ _id: fileId, lock: { who: "Office and Owners", edit: false } })]);
	});
});

describe("files", () => {
	it("are the uploader's own unclaimed uploads, put in a folder or at the top level, with their sniffed type", async () => {
		const { t, owner, member } = await ownerAndMember();
		const folder = await owner.mutation(api.pages.create, { title: "Quotes", kind: "folder" });
		const storageId = await upload(member, xlsx("Q3", [["Deal", "Amount"], ["Acme", 1200]]), "quotes.pdf");
		await expect(owner.mutation(api.driveFiles.add, { file: storageId, parentId: folder })).rejects.toThrow("isn't available");
		const fileId = await member.mutation(api.driveFiles.add, { file: storageId, parentId: folder });
		await expect(member.mutation(api.driveFiles.add, { file: storageId })).rejects.toThrow("isn't available");
		const file = (await owner.query(api.driveFiles.get, { fileId }))!;
		expect(file).toMatchObject({ name: "quotes.pdf", type: XLSX, kind: "Excel", parentId: folder, canEdit: true, canManageAccess: true, ownAccess: null, restricted: false });
		expect(file.url).toMatch(/^https?:\/\//);
		expect(file.ancestors).toEqual([expect.objectContaining({ _id: folder, title: "Quotes" })]);
		expect(await filesIn(owner, folder)).toEqual([expect.objectContaining({ _id: fileId, name: "quotes.pdf", type: XLSX, canEdit: true })]);
		expect(await filesIn(owner)).toEqual([]);
		expect(await pagesIn(owner)).toEqual([expect.objectContaining({ _id: folder, hasChildren: true })]);
		// A picture upload (images.upload) isn't a file for Drive, and a file upload isn't a picture.
		await expect(member.mutation(api.pages.addImage, { pageId: await member.mutation(api.pages.create, { title: "P" }), file: await upload(member, pngOf(2, 2), "a.png") })).rejects.toThrow("isn't available");
		await member.mutation(api.driveFiles.rename, { fileId, name: "  Q3  quotes.xlsx " });
		await member.mutation(api.driveFiles.move, { fileId });
		expect(await owner.query(api.driveFiles.get, { fileId })).toMatchObject({ name: "Q3 quotes.xlsx", parentId: null, ancestors: [] });
		expect(await owner.query(api.driveFiles.titles, { ids: [fileId, folder, "nonsense"] })).toEqual([{ _id: fileId, name: "Q3 quotes.xlsx", type: XLSX }]);
		await expect(member.mutation(api.driveFiles.rename, { fileId, name: " " })).rejects.toThrow("Give the file a name");
		// Deleted forever: the row and the stored bytes go at once.
		await member.mutation(api.trash.move, { kind: "file", id: fileId });
		await expect(member.mutation(api.trash.purge, { id: fileId })).rejects.toThrow("Only people with the");
		await owner.mutation(api.trash.purge, { id: fileId });
		expect(await t.run((ctx) => ctx.db.get(fileId))).toBeNull();
		expect(await exists(t, storageId)).toBe(false);
	});

	it("follow their folder's Who can access list unless they set their own, and never widen on a move", async () => {
		const { t, owner, member } = await ownerAndMember();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const folder = await owner.mutation(api.pages.create, { title: "Office", kind: "folder" });
		const open = await owner.mutation(api.pages.create, { title: "Open", kind: "folder" });
		const fileId = await owner.mutation(api.driveFiles.add, { file: await upload(owner), parentId: folder });
		await owner.mutation(api.pages.setAccess, { pageId: folder, access: [{ role: office, level: "view" }] });
		expect(await member.query(api.driveFiles.get, { fileId })).toBeNull();
		expect(await member.query(api.driveFiles.children, { parentId: folder, ...opts })).toEqual({ page: [], isDone: true, continueCursor: "" });
		expect(await member.query(api.driveFiles.titles, { ids: [fileId] })).toEqual([]);
		await expect(member.mutation(api.driveFiles.rename, { fileId, name: "x" })).rejects.toThrow("Only Office and Owners can see");
		// Its own list opens it to the member at View: they see it, but can't change it.
		await owner.mutation(api.driveFiles.setAccess, { fileId, access: [{ role: "everyone", level: "view" }] });
		expect(await member.query(api.driveFiles.get, { fileId })).toMatchObject({ canEdit: false, canManageAccess: false, ownAccess: [{ role: "everyone", level: "view" }] });
		await expect(member.mutation(api.driveFiles.rename, { fileId, name: "x" })).rejects.toThrow("can change");
		await owner.mutation(api.driveFiles.setAccess, { fileId, access: null });
		expect(await member.query(api.driveFiles.get, { fileId })).toBeNull();
		// Moved to an open folder, a file that followed a stricter list keeps that list.
		await owner.mutation(api.driveFiles.move, { fileId, parentId: open });
		expect(await t.run((ctx) => ctx.db.get(fileId))).toMatchObject({ parentId: open, access: [{ role: office, level: "view" }] });
		expect(await member.query(api.driveFiles.get, { fileId })).toBeNull();
		expect(await member.query(api.driveFiles.children, { parentId: open, ...opts })).toMatchObject({ page: [] });
	});

	it("are only reachable from their own workspace, and go with it", async () => {
		const { t, owner } = await ownerAndMember();
		const storageId = await upload(owner);
		const fileId = await owner.mutation(api.driveFiles.add, { file: storageId });
		const other = await signIn(t, "other@co.com");
		expect(await other.query(api.driveFiles.get, { fileId })).toBeNull();
		await expect(other.mutation(api.driveFiles.rename, { fileId, name: "Mine" })).rejects.toThrow();
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("driveFiles").collect())).toEqual([]);
		expect(await exists(t, storageId)).toBe(false);
	});
});

describe("file tools", () => {
	it("find, read and save files as Companybot for the person, in folders by name or id", async () => {
		const { t, owner } = await ownerAndMember();
		const folder = await owner.mutation(api.pages.create, { title: "Contracts", kind: "folder" });
		const word = await upload(owner, docx("Signed by Ada"), "msa.docx");
		const fileId = await owner.mutation(api.driveFiles.add, { file: word, parentId: folder });
		const tools = await turnFor(t, owner);
		expect(await tools.find({})).toMatchObject({ rows: [{ id: fileId, name: "msa.docx", type: DOCX, folderId: folder }], more: false });
		expect(await tools.find({ folder: "Contracts" })).toMatchObject({ rows: [{ id: fileId }] });
		expect(await tools.find({ folder: null })).toMatchObject({ rows: [] });
		expect(await tools.find({ search: "msa" })).toMatchObject({ rows: [{ id: fileId }] });
		expect(await tools.find({ folder: "Nowhere" })).toMatchObject({ error: expect.stringContaining("No folder named") });
		const found = await tools.read({ file: "msa.docx" });
		expect(found).toMatchObject({ storageId: word, name: "msa.docx", type: DOCX });
		expect(await t.action(internal.fileText.page, { storageId: word, type: DOCX })).toEqual({ text: "Signed by Ada", page: 1, pages: 1 });
		expect(await tools.read({ file: "nope.docx" })).toMatchObject({ error: expect.stringContaining("No file named") });
		// Text the agent wrote: stored as the person's upload, typed by its name, then claimed into the folder.
		const saved = (await t.action(internal.driveTools.saveText, { turnId: tools.turnId, name: "leads.csv", text: "Name,Deal\nAcme,1200" })) as { storageId: Id<"_storage"> };
		expect(saved.storageId).toBeDefined();
		expect(await t.action(internal.driveTools.saveText, { turnId: tools.turnId, name: "page.html", text: "<p>hi</p>" })).toEqual({ error: expect.stringContaining(".txt, .md, .csv or .json") });
		const wrote = await tools.write({ text: "Name,Deal\nAcme,1200", name: "leads.csv", folder: folder }, saved.storageId);
		expect(wrote).toMatchObject({ name: "leads.csv", folderId: folder });
		expect(await filesIn(owner, folder)).toEqual([expect.objectContaining({ name: "leads.csv", type: "text/csv" }), expect.objectContaining({ _id: fileId })]);
		// A copy of a chat file, by its file id, as files.copyFor makes it.
		const messageId = await owner.mutation(api.messages.send, { chatId: (await generalOf(owner))._id, text: "", mentions: noMentions, attachments: [await upload(owner, text("# Plan"), "plan.md")] });
		const copied = (await t.action(internal.files.copyFor, { turnId: tools.turnId, ids: [`${messageId}/0`], picture: false })) as { copies: Record<string, Id<"_storage">> };
		const fromChat = await tools.write({ from: `${messageId}/0`, name: "Q3 plan.md" }, copied.copies[`${messageId}/0`]);
		expect(fromChat).toMatchObject({ name: "Q3 plan.md", folderId: null });
		expect(await filesIn(owner)).toEqual([expect.objectContaining({ name: "Q3 plan.md", type: "text/markdown" })]);
		// Rename, move, archive and restore by id only: a name could point at another file by the time a held call runs.
		expect(await tools.write({ file: "Q3 plan.md", name: "Plan.md" })).toMatchObject({ error: expect.stringContaining("by its id") });
		expect(await tools.write({ file: fromChat.id as string, name: "Plan.md", folder: "Contracts" })).toMatchObject({ error: expect.stringContaining("by its id") });
		expect(await tools.write({ file: fromChat.id as string, name: "Plan.md", folder })).toMatchObject({ name: "Plan.md", folderId: folder });
		expect(await tools.write({ file: fileId, folder: null })).toMatchObject({ name: "msa.docx", folderId: null });
		expect(await tools.write({ file: fileId, trash: true })).toMatchObject({ name: "msa.docx" });
		expect(await tools.find({ trashed: true })).toMatchObject({ rows: [{ id: fileId }] });
		expect(await tools.write({ file: fileId, trash: false })).toMatchObject({ name: "msa.docx" });
		expect(await tools.write({ file: fileId })).toMatchObject({ error: expect.stringContaining("new name") });
		expect(await tools.write({ name: "x.txt" })).toMatchObject({ error: expect.stringContaining("Say what to do") });
		// A refused save drops the copy, so no upload lingers.
		const extra = (await t.action(internal.driveTools.saveText, { turnId: tools.turnId, name: "notes.txt", text: "hi" })) as { storageId: Id<"_storage"> };
		expect(await tools.write({ text: "hi", name: "notes.txt", folder: "Nowhere" }, extra.storageId)).toMatchObject({ error: expect.stringContaining("by its id") });
		await t.mutation(internal.files.dropCopies, { turnId: tools.turnId, storageIds: [extra.storageId] });
		expect(await exists(t, extra.storageId)).toBe(false);
	});

	it("read only files the person can see, and note a restricted one as the reply's source", async () => {
		const { t, owner, member } = await ownerAndMember();
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const folder = await owner.mutation(api.pages.create, { title: "Board", kind: "folder" });
		await owner.mutation(api.pages.setAccess, { pageId: folder, access: [{ role: office, level: "view" }] });
		const fileId = await owner.mutation(api.driveFiles.add, { file: await upload(owner, text("secret"), "board.txt"), parentId: folder });
		const asMember = await turnFor(t, member);
		expect(await asMember.find({})).toMatchObject({ rows: [] });
		expect(await asMember.read({ file: "board.txt" })).toMatchObject({ error: "Only Office and Owners can see board.txt." });
		expect(await asMember.read({ file: fileId })).toMatchObject({ error: expect.stringContaining("Only Office and Owners can see") });
		// The member's turn still holds #general for Companybot, so the owner's runs in another channel.
		const asOwner = await turnFor(t, owner, await owner.mutation(api.chats.createChannel, { name: "owners", private: false }));
		expect(await asOwner.read({ file: "board.txt" })).toMatchObject({ name: "board.txt" });
		const turn = (await t.run((ctx) => ctx.db.get("agentTurns", asOwner.turnId)))!;
		expect((await t.run((ctx) => ctx.db.get("chatMessages", turn.replyId!)))!.usedPlaces).toEqual([fileId]);
	});

	it("make folders and read them as their contents through the page tools", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		const made = (await t.mutation(internal.pageTools.writeFor, { turnId, input: { title: "Vendors", kind: "folder" } })) as { id: Id<"pages">; kind: string };
		expect(made).toMatchObject({ kind: "folder", title: "Vendors" });
		const page = (await t.mutation(internal.pageTools.writeFor, { turnId, input: { title: "Notes", parent: made.id } })) as { id: Id<"pages"> };
		const fileId = await owner.mutation(api.driveFiles.add, { file: await upload(owner), parentId: made.id });
		expect(await t.mutation(internal.pageTools.readFor, { turnId, page: "Vendors" })).toMatchObject({ kind: "folder", doc: null, subpages: [{ id: page.id, kind: "page", title: "Notes" }], files: [{ id: fileId, name: "notes.txt", type: "text/plain" }] });
		const blocks = JSON.stringify([{ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }]);
		expect(await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: made.id, markdown: "hi" }, blocks })).toMatchObject({ error: expect.stringContaining("A folder has no content") });
		expect(await t.mutation(internal.pageTools.findFor, { turnId, input: { parent: null } })).toMatchObject({ rows: [{ id: made.id, kind: "folder", title: "Vendors" }] });
		expect(await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: page.id, kind: "folder" } })).toMatchObject({ error: expect.stringContaining("kind only makes a new folder") });
	});
});
