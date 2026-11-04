import { imageMaxBytes } from "@companybot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docx, pngOf } from "../../core/test/files";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, settle, workspaceOf } from "./helpers";

// Agents using a chat file elsewhere: files.copyFor copies it as the person's upload, and the app's own
// mutations claim the copy (images.set, messages.send, a page's pictures), as they would a person's.

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));
const uploads = (t: T) => t.run((ctx) => ctx.db.query("uploads").collect());

/** Posts these files in #general as `as`; returns the message and its file ids. */
async function posted(as: As, files: [Uint8Array, string][]) {
	const workspaceId = await workspaceOf(as);
	const attachments: Id<"_storage">[] = [];
	for (const [body, name] of files) {
		const response = await as.fetch(`/files/upload?${new URLSearchParams({ name, workspaceId })}`, { method: "POST", body: body as Uint8Array<ArrayBuffer> });
		expect(response.status).toBe(200);
		attachments.push(((await response.json()) as { storageId: Id<"_storage"> }).storageId);
	}
	const messageId = await as.mutation(api.messages.send, { chatId: (await generalOf(as))._id, text: "", mentions: noMentions, attachments });
	return { messageId, ids: files.map((_, i) => `${messageId}/${i}`) };
}

/** A running turn of Companybot for `as`, in their DM with it. */
async function turnOf(t: T, as: As) {
	const { companybot, scribe } = await agentsOf(as);
	const dm = await as.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	return { turnId: await agentTurn(t, as, dm, companybot._id), scribe };
}

/** A manage tool call as agent.ts runs one: chat files copied first. */
async function run(t: T, turnId: Id<"agentTurns">, tool: string, request: Record<string, unknown>, ids: string[], picture: boolean) {
	const copied = await t.action(internal.files.copyFor, { turnId, ids, picture });
	if ("error" in copied) return copied;
	return t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request }, uploads: copied.copies });
}

describe("agents using chat files", () => {
	it("sets the workspace logo, the person's photo and an agent's picture from copies that outlive the message", async () => {
		const { t, owner } = await ownerAndMember();
		const { messageId, ids } = await posted(owner, [[pngOf(512, 512), "logo.png"]]);
		const { turnId, scribe } = await turnOf(t, owner);
		expect(await run(t, turnId, "workspace.settings", { action: "set_image", of: "workspace", file: ids[0] }, ids, true)).toEqual({ done: "set_image" });
		expect(await run(t, turnId, "workspace.settings", { action: "set_image", of: "me", file: ids[0] }, ids, true)).toEqual({ done: "set_image" });
		expect(await run(t, turnId, "agents.manage", { action: "set_image", id: scribe._id, file: ids[0] }, ids, true)).toMatchObject({ done: "set_image" });

		const logo = (await t.run(async (ctx) => (await ctx.db.get(await workspaceOf(owner)))!.image))!;
		const photo = (await t.run(async (ctx) => (await ctx.db.query("preferences").collect())[0]!.image))!;
		const picture = (await t.run((ctx) => ctx.db.get(scribe._id)))!.image!;
		const original = (await t.run((ctx) => ctx.db.get(messageId)))!.attachments![0]!.storageId;
		expect(new Set([logo, photo, picture, original]).size).toBe(4);
		expect(await uploads(t)).toHaveLength(0);

		// null still goes back to initials, and deletes the copy.
		expect(await run(t, turnId, "agents.manage", { action: "set_image", id: scribe._id, file: null }, [], true)).toMatchObject({ done: "set_image" });
		expect(await exists(t, picture)).toBe(false);

		await owner.mutation(api.messages.remove, { messageId });
		await settle(t);
		expect(await exists(t, original)).toBe(false);
		expect([await exists(t, logo), await exists(t, photo)]).toEqual([true, true]);
	});

	it("takes only pictures a person could upload as one, from chats the person can see, and leaves no copy behind", async () => {
		const { t, owner, member } = await ownerAndMember();
		const big = new Uint8Array(imageMaxBytes + 1);
		big.set(pngOf(4000, 4000));
		const { ids } = await posted(owner, [[docx("Quote"), "quote.docx"], [big, "huge.png"], [pngOf(64, 64), "ok.png"]]);
		const { turnId } = await turnOf(t, owner);
		const logo = (file: string) => run(t, turnId, "workspace.settings", { action: "set_image", of: "workspace", file }, [file], true);
		expect(await logo(ids[0]!)).toEqual({ error: "quote.docx isn't a picture (PNG, JPEG, WebP or GIF)." });
		expect(await logo(ids[1]!)).toEqual({ error: "huge.png is 10.0 MB; pictures here can be up to 10 MB." });
		expect(await logo("nonsense/0")).toEqual({ error: 'No file "nonsense/0" in a chat you can see.' });

		// A member's agent copies it, but the logo needs the settings switch: the copy goes.
		const { turnId: memberTurn } = await turnOf(t, member);
		const copied = await t.action(internal.files.copyFor, { turnId: memberTurn, ids: [ids[2]!], picture: true });
		expect(copied).toHaveProperty("copies");
		const copy = Object.values((copied as { copies: Record<string, Id<"_storage">> }).copies)[0]!;
		const refused = await t.mutation(internal.manageTools.runFor, { turnId: memberTurn, tool: "workspace.settings", input: { request: { action: "set_image", of: "workspace", file: ids[2] } }, uploads: { [ids[2]!]: copy } });
		expect(refused).toMatchObject({ error: expect.stringContaining("Only people with the") });
		await t.mutation(internal.files.dropCopies, { turnId: memberTurn, storageIds: [copy] });
		expect(await exists(t, copy)).toBe(false);
		expect(await uploads(t)).toHaveLength(0);

		// Without a copy, a file id is just text.
		expect(await t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "set_image", of: "workspace", file: ids[2] } } })).toMatchObject({
			error: expect.stringMatching(/No file/),
		});
	});

	it("sends chat files to another chat as copies of their own", async () => {
		const { t, owner } = await ownerAndMember();
		const { messageId, ids } = await posted(owner, [[pngOf(64, 64), "logo.png"], [docx("Quote"), "quote.docx"]]);
		const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
		const { turnId } = await turnOf(t, owner);
		const sent = (await run(t, turnId, "chat.manage", { action: "send", chat: "#sales", files: ids }, ids, false)) as { messageId: Id<"chatMessages"> };
		const [original, copy] = await t.run(async (ctx) => [(await ctx.db.get(messageId))!, (await ctx.db.get(sent.messageId))!]);
		expect(copy.chatId).toBe(sales);
		expect(copy.attachments!.map((a) => [a.name, a.type, a.width])).toEqual([
			["logo.png", "image/png", 64],
			["quote.docx", original.attachments![1]!.type, undefined],
		]);
		expect(copy.attachments!.map((a) => a.storageId)).not.toContain(original.attachments![0]!.storageId);
	});

	it("puts chat pictures in a page by file id, as the page's own", async () => {
		const { t, owner } = await ownerAndMember();
		const { messageId, ids } = await posted(owner, [[pngOf(64, 64), "logo.png"]]);
		const { turnId } = await turnOf(t, owner);
		const blocks = await t.action(internal.pageMarkdown.fromMarkdown, { markdown: `# Brand\n\n![Our logo](${ids[0]})` });
		expect(blocks).toContain(ids[0]);
		const found = await t.action(internal.pageTools.copyPictures, { turnId, blocks });
		if ("error" in found) throw new Error(found.error);
		expect(found.pictures).toHaveLength(1);
		expect(found.blocks).not.toContain(ids[0]);
		expect(found.blocks).toContain(found.pictures[0]!.url);
		const markdown = `# Brand\n\n![Our logo](${ids[0]})`;
		const page = (await t.mutation(internal.pageTools.writeFor, { turnId, input: { title: "Brand", markdown }, ...found })) as { id: Id<"pages"> };
		expect(await t.run((ctx) => ctx.db.query("pageImages").collect())).toMatchObject([{ pageId: page.id, storageId: found.pictures[0]!.storageId, url: found.pictures[0]!.url }]);

		await owner.mutation(api.messages.remove, { messageId });
		await settle(t);
		expect(await exists(t, found.pictures[0]!.storageId)).toBe(true);
		expect(await t.action(internal.pageTools.copyPictures, { turnId, blocks: "not json" })).toEqual({ blocks: "not json", pictures: [] });
	});
});
