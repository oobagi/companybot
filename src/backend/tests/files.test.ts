import { DOCX, FILE_MAX_BYTES } from "@companybot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docx, pngOf } from "../../core/test/files";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, settle, sideWorkspace, workspaceOf } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
const text = (s: string) => new TextEncoder().encode(s);
/** POSTs a file to the upload endpoint as `as`, as the app does. */
const post = async (as: As, body: Uint8Array<ArrayBuffer>, name: string, workspaceId: Id<"workspaces"> | null = null) => {
	const query = new URLSearchParams({ name, ...(workspaceId && { workspaceId }) });
	return as.fetch(`/files/upload?${query}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
};
/** Uploads a file as `as`, in their open workspace, and returns its storage id. */
const upload = async (as: As, body: Uint8Array<ArrayBuffer> = text("notes"), name = "notes.txt") => {
	const response = await post(as, body, name, await workspaceOf(as));
	expect(response.status).toBe(200);
	return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
};
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));
const send = async (as: As, attachments: Id<"_storage">[], body = "") =>
	as.mutation(api.messages.send, { chatId: (await generalOf(as))._id, text: body, mentions: noMentions, attachments });
const messageOf = (t: T, id: Id<"chatMessages">) => t.run(async (ctx) => (await ctx.db.get(id))!);

describe("uploading files", () => {
	it("stores each file with the type its bytes say, never HTML or SVG", async () => {
		const { t, owner } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		const word = await upload(owner, docx("Hello"), "letter.pdf");
		expect((await t.run((ctx) => ctx.db.system.get(word)))!.contentType).toBe(DOCX);
		const picture = await upload(owner, pngOf(640, 480), "C:\\photos\\roof.png");
		expect(await t.run((ctx) => ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", picture)).unique())).toMatchObject({
			file: { name: "roof.png", type: "image/png", size: 64, width: 640, height: 480 },
		});
		expect((await post(owner, text("<!doctype html><script>alert(1)</script>"), "notes.txt", workspaceId)).status).toBe(415);
		expect((await post(owner, text('<svg xmlns="http://www.w3.org/2000/svg"/>'), "a.txt", workspaceId)).status).toBe(415);
		expect((await post(owner, new Uint8Array(FILE_MAX_BYTES + 1), "big.txt", workspaceId)).status).toBe(413);
	});

	it("needs someone signed in, in the workspace it names", async () => {
		const { t, owner, member } = await ownerAndMember();
		const before = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
		expect((await t.fetch("/files/upload?name=a.txt", { method: "POST", body: text("hi") })).status).toBe(401);
		// Files are for a workspace's chats: one must be named, and be theirs.
		expect((await post(member, text("hi"), "a.txt")).status).toBe(403);
		const { workspaceId: elsewhere } = await sideWorkspace(t, "owner@co.com");
		expect((await post(member, text("hi"), "a.txt", elsewhere)).status).toBe(403);
		expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(before);
		expect((await owner.fetch("/files/upload", { method: "OPTIONS" })).status).toBe(204);
	});
});

describe("attaching files to messages", () => {
	it("attaches only the sender's own unclaimed uploads, once, and shows them with URLs", async () => {
		const { t, owner, member } = await ownerAndMember();
		const mine = await upload(member, docx("Hi"), "plan.docx");
		const theirs = await upload(owner);
		await expect(send(member, [theirs])).rejects.toThrow("isn't available");
		// A message with files needs no text.
		const messageId = await send(member, [mine]);
		await expect(send(member, [mine])).rejects.toThrow("isn't available");
		// A file stored any other way was never an upload.
		const raw = await t.run((ctx) => ctx.storage.store(new Blob([text("x")], { type: "text/plain" })));
		await expect(send(owner, [raw])).rejects.toThrow("isn't available");

		const listed = (await owner.query(api.messages.list, { chatId: (await generalOf(owner))._id })).find((m) => m._id === messageId)!;
		expect(listed.attachments).toEqual([{ name: "plan.docx", type: DOCX, size: docx("Hi").length, url: expect.any(String) }]);
		expect(listed.text).toBe("");
		await expect(send(member, [])).rejects.toThrow("Write something");
	});

	it("keeps pictures and message files apart", async () => {
		const { owner } = await ownerAndMember();
		const file = await upload(owner, pngOf(10, 10), "a.png");
		await expect(owner.mutation(api.images.set, { of: "me", file })).rejects.toThrow("isn't available");
		const response = await owner.fetch(`/images/upload?workspaceId=${await workspaceOf(owner)}`, { method: "POST", body: pngOf(10, 10) });
		const { storageId: picture } = (await response.json()) as { storageId: Id<"_storage"> };
		await expect(send(owner, [picture])).rejects.toThrow("isn't available");
	});

	it("takes an upload only in the workspace it was made in", async () => {
		const { t, owner } = await ownerAndMember();
		const { workspaceId: side } = await sideWorkspace(t, "owner@co.com");
		const response = await post(owner, text("side notes"), "a.txt", side);
		const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
		await expect(send(owner, [storageId])).rejects.toThrow("isn't available");
	});

	it("takes at most 10 files, and a refused message keeps its uploads", async () => {
		const { t, owner } = await ownerAndMember();
		const files: Id<"_storage">[] = [];
		for (let i = 0; i < 11; i++) files.push(await upload(owner, text(`file ${i}`)));
		await expect(send(owner, files)).rejects.toThrow("up to 10");
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(11);
		await send(owner, files.slice(0, 10));
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(1);
	});

	it("deletes a message's files when it's deleted, and a discarded upload's", async () => {
		const { t, owner, member } = await ownerAndMember();
		const file = await upload(owner);
		const messageId = await send(owner, [file], "see attached");
		await owner.mutation(api.messages.remove, { messageId });
		expect(await exists(t, file)).toBe(false);
		expect((await messageOf(t, messageId)).attachments).toBeUndefined();

		const pending = await upload(owner);
		await member.mutation(api.files.discard, { file: pending });
		expect(await exists(t, pending)).toBe(true);
		await owner.mutation(api.files.discard, { file: pending });
		expect(await exists(t, pending)).toBe(false);
	});

	it("deletes files with a channel deleted forever, and with the workspace", async () => {
		const { t, owner } = await ownerAndMember();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "deals", private: false });
		const inChannel = await upload(owner);
		await owner.mutation(api.messages.send, { chatId, text: "", mentions: noMentions, attachments: [inChannel] });
		await owner.mutation(api.trash.move, { kind: "channel", id: chatId });
		// In Trash, it can still be restored: files stay.
		expect(await exists(t, inChannel)).toBe(true);
		await owner.mutation(api.trash.purge, { id: chatId });
		await settle(t);
		expect(await exists(t, inChannel)).toBe(false);

		const inGeneral = await upload(owner);
		await send(owner, [inGeneral]);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await settle(t);
		expect(await exists(t, inGeneral)).toBe(false);
	});
});

describe("agents and files", () => {
	it("lists a message's files in the turn, with pictures for a model that sees them", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chat = await generalOf(owner);
		const photo = await upload(owner, pngOf(800, 600), "roof.png");
		const word = await upload(owner, docx("Quote: $12,000"), "quote.docx");
		vi.useFakeTimers();
		const messageId = await owner.mutation(api.messages.send, { chatId: chat._id, text: "@Companybot thoughts?", mentions: { userIds: [], agentIds: [companybot._id] }, attachments: [photo, word] });
		const turn = (await t.run((ctx) => ctx.db.query("agentTurns").collect())).at(-1)!;
		const context = await t.query(internal.turns.turnContext, { turnId: turn._id });
		expect(context.messages.at(-1)!.files).toEqual([
			{ id: `${messageId}/0`, name: "roof.png", type: "image/png", size: 64 },
			{ id: `${messageId}/1`, name: "quote.docx", type: DOCX, size: docx("Quote: $12,000").length },
		]);
		// The default model doesn't see pictures; Claude does.
		expect(context).toMatchObject({ vision: false, images: [] });
		await t.run((ctx) => ctx.db.patch(companybot._id, { model: "anthropic/claude-sonnet-5.5" }));
		expect(await t.query(internal.turns.turnContext, { turnId: turn._id })).toMatchObject({
			vision: true,
			images: [{ id: `${messageId}/0`, storageId: photo, type: "image/png" }],
		});

		// chat.read_file finds it as the turn's person, and reads the Word file's text.
		const found = await t.query(internal.files.readFor, { turnId: turn._id, id: `${messageId}/1` });
		expect(found).toMatchObject({ storageId: word, name: "quote.docx", type: DOCX });
		expect(await t.action(internal.fileText.page, { storageId: word, type: DOCX })).toEqual({ text: "Quote: $12,000", page: 1, pages: 1 });
		expect(await t.query(internal.files.readFor, { turnId: turn._id, id: `${messageId}/7` })).toBeNull();
		expect(await t.query(internal.files.readFor, { turnId: turn._id, id: "nonsense" })).toBeNull();
	});

	it("reads files only in chats the turn's person can see", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const file = await upload(owner);
		const messageId = await owner.mutation(api.messages.send, { chatId: secret, text: "", mentions: noMentions, attachments: [file] });
		const turnId = await agentTurn(t, member, (await generalOf(member))._id, companybot._id);
		expect(await t.query(internal.files.readFor, { turnId, id: `${messageId}/0` })).toBeNull();
	});

	it("attaches a file the runner made to the running reply, and refuses once it's done", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		const store = () => t.run((ctx) => ctx.storage.store(new Blob([pngOf(4, 4)], { type: "image/png" })));
		const made = await store();
		expect(await t.mutation(internal.files.attachToReply, { turnId, storageId: made, name: "chart.png", width: 4, height: 4 })).toEqual({ attached: true });
		const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await messageOf(t, replyId)).attachments).toEqual([{ storageId: made, name: "chart.png", type: "image/png", size: 64, width: 4, height: 4 }]);

		const html = await t.run((ctx) => ctx.storage.store(new Blob(["<html>"], { type: "text/html" })));
		expect(await t.mutation(internal.files.attachToReply, { turnId, storageId: html, name: "x.html" })).toEqual({ error: expect.stringContaining("type") });
		expect(await exists(t, html)).toBe(false);

		await t.mutation(internal.turns.finishReply, { turnId });
		const late = await store();
		expect(await t.mutation(internal.files.attachToReply, { turnId, storageId: late, name: "late.png" })).toEqual({ error: expect.any(String) });
		expect(await exists(t, late)).toBe(false);
	});
});
