// @vitest-environment node
import { safeFetch } from "@companybot/core/safe-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pngOf } from "../../core/test/files";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fetchPreview, previewFrom } from "../convex/linkUnfurl";
import { fetchBody } from "../convex/webFetch";
import { type As, agentsOf, generalOf, noMentions, ownerAndMember, settle, workspaceOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

const bytes = (s: string) => new TextEncoder().encode(s);
const page = (head: string, url = "https://news.example.com/story") =>
	previewFrom({ url, status: 200, contentType: "text/html", bytes: bytes(`<!doctype html><html><head>${head}</head><body>Hi</body></html>`), cut: false });

describe("reading a page's details", () => {
	it("prefers Open Graph, then the Twitter card, then <title> and the description meta", () => {
		expect(
			page(`<title>Plain title</title><meta name="description" content="Plain description">
				<meta property="og:title" content="OG title"><meta property="og:description" content="OG &amp; more">
				<meta property="og:site_name" content="The Daily"><meta property="og:image" content="/img/cover.png">
				<meta name="twitter:title" content="Tweet title"><meta name="twitter:image" content="/other.png">`),
		).toEqual({ title: "OG title", description: "OG & more", siteName: "The Daily", imageUrl: "https://news.example.com/img/cover.png" });
		expect(page(`<title>Plain title</title><meta name="twitter:title" content="Tweet title"><meta name="twitter:description" content="Tweet text"><meta name="twitter:image" content="https://cdn.example.com/t.jpg">`)).toEqual({
			title: "Tweet title",
			description: "Tweet text",
			siteName: "news.example.com",
			imageUrl: "https://cdn.example.com/t.jpg",
		});
		expect(page(`<title>\n  Plain   title\n</title><meta name="description" content="Plain description">`)).toEqual({
			title: "Plain title",
			description: "Plain description",
			siteName: "news.example.com",
			imageUrl: undefined,
		});
	});

	it("takes the first tag, drops non-web pictures, strips www, and cuts long text", () => {
		const found = page(`<meta property="og:title" content="First"><meta property="og:title" content="Second"><meta property="og:image" content="javascript:alert(1)"><meta property="og:description" content="${"word ".repeat(100)}">`, "https://www.acme.com/");
		expect(found).toMatchObject({ title: "First", siteName: "acme.com", imageUrl: undefined });
		expect(found!.description).toHaveLength(300);
		expect(found!.description).toMatch(/…$/);
	});

	it("gives nothing for a page with no title or description, an error page, or a file that isn't HTML", () => {
		expect(page(`<meta charset="utf-8"><meta property="og:image" content="/x.png">`)).toBeUndefined();
		const read = (status: number, contentType: string) => previewFrom({ url: "https://a.com/", status, contentType, bytes: bytes("<title>Hi</title>"), cut: false });
		expect(read(404, "text/html")).toBeUndefined();
		expect(read(200, "application/pdf")).toBeUndefined();
		expect(read(200, "text/html")).toEqual({ title: "Hi", description: undefined, siteName: "a.com", imageUrl: undefined });
	});
});

/** A web of two pages and a picture, served through the real safeFetch with a public address for every name. */
function fakeWeb(pages: Record<string, { type: string; body: Uint8Array | string }>) {
	const asked: string[] = [];
	const get: typeof fetchBody = (url, { maxBytes }) =>
		safeFetch(url, {
			resolve: async () => ["93.184.216.34"],
			request: async (u) => {
				asked.push(u.href);
				const found = pages[u.href];
				return found ? new Response(found.body as BodyInit, { headers: { "content-type": found.type } }) : new Response("", { status: 404 });
			},
		}, { maxBytes });
	return { get, asked };
}

describe("fetching a preview", () => {
	it("keeps a copy of the picture only if its bytes say it is one and it is under 1 MB", async () => {
		const html = (image: string) => ({ type: "text/html", body: `<meta property="og:title" content="Story"><meta property="og:image" content="${image}">` });
		const web = fakeWeb({
			"https://a.com/ok": html("/ok.png"),
			"https://a.com/ok.png": { type: "image/png", body: pngOf(8, 8) },
			"https://a.com/lie": html("/lie.png"),
			"https://a.com/lie.png": { type: "image/png", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
			"https://a.com/big": html("/big.png"),
			"https://a.com/big.png": { type: "image/png", body: pngOf(8, 8, 1_000_001) },
		});
		expect(await fetchPreview("https://a.com/ok", web.get)).toMatchObject({ title: "Story", image: { type: "image/png" } });
		expect(await fetchPreview("https://a.com/lie", web.get)).toMatchObject({ title: "Story", image: undefined });
		expect(await fetchPreview("https://a.com/big", web.get)).toMatchObject({ title: "Story", image: undefined });
	});

	it("refuses private and local addresses, for the page and for its picture", async () => {
		const web = fakeWeb({ "https://a.com/story": { type: "text/html", body: '<meta property="og:title" content="Story"><meta property="og:image" content="http://169.254.169.254/latest/meta-data">' } });
		expect(await fetchPreview("https://a.com/story", web.get)).toMatchObject({ title: "Story", image: undefined });
		expect(web.asked).toEqual(["https://a.com/story"]);
		for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/admin", "http://[::1]/", "http://user:pass@a.com/"]) {
			await expect(fetchBody(url, { timeoutMs: 1000, maxBytes: 1000, accept: "text/html" }), url).rejects.toThrow();
			expect(await fetchPreview(url), url).toBeUndefined();
		}
	});
});

// ---- On messages ----

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
const link = "https://news.example.com/story";
const found = { url: link, title: "Big story", description: "What happened.", siteName: "The Daily" };

/** Unfurl jobs the sends so far scheduled (their URLs). All scheduled work is dropped, so nothing reaches the network. */
const fetches = (t: T) =>
	t.run(async (ctx) => {
		const out: string[][] = [];
		for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
			if (job.state.kind !== "pending") continue;
			if (job.name.includes("linkUnfurl")) out.push((job.args[0] as { urls: string[] }).urls);
			await ctx.scheduler.cancel(job._id);
		}
		return out;
	});
const post = async (as: As, text: string) => as.mutation(api.messages.send, { chatId: (await generalOf(as))._id, text, mentions: noMentions });
const cards = async (as: As, id: Id<"chatMessages">) => (await as.query(api.messages.list, { chatId: (await generalOf(as))._id })).find((m) => m._id === id)!.linkPreviews;
const store = (t: T, id: Id<"chatMessages">, ...results: (Partial<typeof found> & { url: string; image?: Id<"_storage"> })[]) => t.mutation(internal.linkPreviews.save, { messageId: id, results });
const picture = (t: T) => t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(pngOf(8, 8))], { type: "image/png" })));
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));

describe("previews on messages", () => {
	it("asks for the first distinct links of a message, never for ones in code or in-app addresses", async () => {
		const { t, owner } = await ownerAndMember();
		await post(owner, `read ${link} and ${link}#top, http://a.org/x, https://b.org/y, https://c.org/z`);
		expect(await fetches(t)).toEqual([[link, "http://a.org/x", "https://b.org/y"]]);
		await post(owner, "run `curl https://a.org/in-code` then [Members](#/settings/members) and [Plan](companybot://page/abc)\n```\nhttps://a.org/fenced\n```");
		await post(owner, "no links here");
		expect(await fetches(t)).toEqual([]);
	});

	it("shows a card once the page was read, with our copy of the picture, and the same link later needs no fetch", async () => {
		const { t, owner, member } = await ownerAndMember();
		const first = await post(owner, link);
		expect(await cards(owner, first)).toEqual([]);
		await fetches(t);
		const image = await picture(t);
		await store(t, first, { ...found, image });
		const [card] = await cards(member, first);
		expect(card).toMatchObject({ url: link, title: "Big story", description: "What happened.", siteName: "The Daily" });
		expect(card!.imageUrl).toMatch(/^https?:\/\//);
		expect(card!.imageUrl).not.toContain("example.com");
		const second = await post(member, `again: ${link}`);
		expect(await fetches(t)).toEqual([]);
		expect(await cards(owner, second)).toHaveLength(1);
	});

	it("refetches a day-old one but keeps showing it, and keeps the last good card if the refresh fails (one row per link, in the sender's workspace)", async () => {
		const { t, owner } = await ownerAndMember();
		const first = await post(owner, link);
		await store(t, first, found);
		await fetches(t);
		await t.run(async (ctx) => void (await ctx.db.query("linkPreviews").collect()).forEach((r) => ctx.db.patch(r._id, { fetchedAt: Date.now() - 25 * 60 * 60_000 })));
		const second = await post(owner, link);
		expect(await cards(owner, second)).toHaveLength(1);
		expect(await fetches(t)).toEqual([[link]]);
		await store(t, second, { url: link });
		expect(await cards(owner, second)).toMatchObject([{ title: "Big story" }]);
		expect(await t.run((ctx) => ctx.db.query("linkPreviews").collect())).toMatchObject([{ workspaceId: await workspaceOf(owner), url: link }]);
	});

	it("tries a link that had nothing to show again after an hour, not at once", async () => {
		const { t, owner } = await ownerAndMember();
		const first = await post(owner, link);
		await store(t, first, { url: link });
		expect(await cards(owner, first)).toEqual([]);
		await fetches(t);
		await post(owner, link);
		expect(await fetches(t)).toEqual([]);
		await t.run(async (ctx) => void (await ctx.db.query("linkPreviews").collect()).forEach((r) => ctx.db.patch(r._id, { fetchedAt: Date.now() - 61 * 60_000 })));
		await post(owner, link);
		expect(await fetches(t)).toEqual([[link]]);
	});

	it("follows edits: new links are asked for, removed ones lose their card", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await post(owner, link);
		await store(t, id, found);
		await fetches(t);
		await owner.mutation(api.messages.edit, { messageId: id, text: `${link} and https://b.org/y` });
		expect(await fetches(t)).toEqual([["https://b.org/y"]]);
		expect(await cards(owner, id)).toHaveLength(1);
		await owner.mutation(api.messages.edit, { messageId: id, text: "no link now" });
		expect(await cards(owner, id)).toEqual([]);
	});

	it("never fetches links an agent wrote, so injected text can't send data out through a preview", async () => {
		const { t, owner } = await ownerAndMember();
		vi.useFakeTimers();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "hi", mentions: { userIds: [], agentIds: [companybot._id] } });
		await fetches(t);
		const turn = (await t.run((ctx) => ctx.db.query("agentTurns").collect())).at(-1)!;
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: `Here: ${link}`, parts: [{ type: "text", text: `Here: ${link}` }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		expect(await fetches(t)).toEqual([]);
	});

	it("drops what comes back for a message deleted meanwhile, or in a workspace being deleted, picture included", async () => {
		const { t, owner } = await ownerAndMember();
		const gone = await post(owner, link);
		await fetches(t);
		await owner.mutation(api.messages.remove, { messageId: gone });
		const image = await picture(t);
		await store(t, gone, { ...found, image });
		expect(await t.run((ctx) => ctx.db.query("linkPreviews").collect())).toEqual([]);
		expect(await exists(t, image)).toBe(false);

		const live = await post(owner, link);
		await fetches(t);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		const late = await picture(t);
		await store(t, live, { ...found, image: late });
		expect(await t.run((ctx) => ctx.db.query("linkPreviews").collect())).toEqual([]);
		expect(await exists(t, late)).toBe(false);
	});

	it("deletes the row and its picture when the workspace goes", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await post(owner, link);
		await fetches(t);
		const image = await picture(t);
		await store(t, id, { ...found, image });
		expect(await exists(t, image)).toBe(true);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("linkPreviews").collect())).toEqual([]);
		expect(await exists(t, image)).toBe(false);
	});

	it("deletes a replaced picture, and the previews of a deleted message are gone with it", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await post(owner, link);
		const [first, second] = [await picture(t), await picture(t)];
		await store(t, id, { ...found, image: first });
		await store(t, id, { ...found, image: second });
		expect(await exists(t, first)).toBe(false);
		expect(await exists(t, second)).toBe(true);
		await owner.mutation(api.messages.remove, { messageId: id });
		expect(await cards(owner, id)).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(id)))!.linkPreviews).toBeUndefined();
	});
});

describe("hiding a preview", () => {
	it("is for the sender: others, including owners, are refused, and the link stays in the text", async () => {
		const { t, owner, member } = await ownerAndMember();
		const id = await post(member, `see ${link}`);
		await store(t, id, found);
		await fetches(t);
		await expect(owner.mutation(api.messages.hidePreview, { messageId: id, url: link })).rejects.toThrow("only change your own");
		expect(await cards(owner, id)).toHaveLength(1);
		await member.mutation(api.messages.hidePreview, { messageId: id, url: `${link}#section` });
		expect(await cards(owner, id)).toEqual([]);
		expect(await cards(member, id)).toEqual([]);
		expect((await member.query(api.messages.list, { chatId: (await generalOf(member))._id })).find((m) => m._id === id)!.text).toBe(`see ${link}`);
	});

	it("stays hidden when the message is edited or the page is refreshed, and refuses a link with no card", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await post(owner, link);
		await store(t, id, found);
		await fetches(t);
		await expect(owner.mutation(api.messages.hidePreview, { messageId: id, url: "https://other.example.com/" })).rejects.toThrow("no preview");
		await owner.mutation(api.messages.hidePreview, { messageId: id, url: link });
		await owner.mutation(api.messages.edit, { messageId: id, text: `${link} (edited)` });
		await store(t, id, { ...found, title: "New title" });
		expect(await cards(owner, id)).toEqual([]);
		// Another message with the same link has its own card.
		const other = await post(owner, link);
		expect(await cards(owner, other)).toHaveLength(1);
	});

	it("can't be done by someone who can't see the message", async () => {
		const { t, owner, member } = await ownerAndMember();
		const privateId = await owner.mutation(api.chats.createChannel, { name: "secret", private: true });
		const id = await owner.mutation(api.messages.send, { chatId: privateId, text: link, mentions: noMentions });
		await store(t, id, found);
		await fetches(t);
		await expect(member.mutation(api.messages.hidePreview, { messageId: id, url: link })).rejects.toThrow();
	});
});
