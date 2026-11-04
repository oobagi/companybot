"use node";

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { DOCX, FILE_MAX_BYTES, PAGE_CHARS, type FileType, type SavedFile, type WebPage, XLSX, cleanFileName, clipPage, imageSize, isImageType, sniffDocument, sniffFile } from "@companybot/core";
import { fileText } from "@companybot/core/file-text";
import { type FetchedBody, UnsafeUrlError, safeFetch, textOf } from "@companybot/core/safe-fetch";
import { Readability } from "@mozilla/readability";
import { v } from "convex/values";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, fetch } from "undici";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

// web.fetch's network side (and link previews', linkUnfurl.ts). Node, for DNS: safeFetch (core)
// checks every address a link resolves to, and undici then connects only to those, so a link can't
// reach our own network.

const USER_AGENT = "Mozilla/5.0 (compatible; Companybot/1.0; +https://github.com/oobagi/companybot)";

const ACCEPT = `text/html, text/*;q=0.9, application/pdf;q=0.9, ${XLSX};q=0.9, ${DOCX};q=0.9, application/json;q=0.8, application/xml;q=0.8`;

/** Fetches one page or file and returns it as Markdown or text, cut at PAGE_CHARS. Expected problems come back as `{ error }`. */
export const fetchPage = internalAction({
	args: { url: v.string() },
	handler: async (_ctx, { url }): Promise<WebPage | { error: string }> => {
		try {
			// Files get the same limit as attachments: a cut-off PDF or spreadsheet can't be read at all.
			return await pageFrom(await fetchBody(url, { timeoutMs: 15_000, maxBytes: FILE_MAX_BYTES, accept: ACCEPT }));
		} catch (e) {
			return failure(e, "page");
		}
	},
});

/** Why a fetch failed, for the model. */
function failure(e: unknown, what: string) {
	if (e instanceof UnsafeUrlError) return { error: e.message };
	if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { error: `The ${what} took too long to load.` };
	return { error: `Couldn't load the ${what}: ${reason(e)}` };
}

/**
 * web.save: downloads a file and attaches it to the turn's reply (files.attachToReply), so the agent
 * can use it by file id. Its type comes from its bytes, as for an upload; anything a message can't take is refused.
 */
export const saveFile = internalAction({
	args: { turnId: v.id("agentTurns"), url: v.string() },
	handler: async (ctx, { turnId, url }): Promise<SavedFile | { error: string }> => {
		let body: FetchedBody;
		try {
			body = await fetchBody(url, { timeoutMs: 15_000, maxBytes: FILE_MAX_BYTES, accept: "image/png, image/jpeg, image/webp, image/gif, application/pdf, */*;q=0.5" });
		} catch (e) {
			return failure(e, "file");
		}
		const file = savedFrom(body);
		if ("error" in file) return file;
		const { name, type } = file;
		const storageId = await ctx.storage.store(new Blob([new Uint8Array(body.bytes)], { type }));
		const attached = await ctx.runMutation(internal.files.attachToReply, { turnId, storageId, name, ...(isImageType(type) && imageSize(body.bytes, type)) });
		return "error" in attached ? attached : { id: attached.id, name, type };
	},
});

/** What web.save keeps of a download: its type by its bytes and a name with a matching extension, or why not. */
export function savedFrom(body: FetchedBody): { name: string; type: FileType } | { error: string } {
	if (body.status >= 400) return { error: `The link answered ${body.status}.` };
	if (body.cut) return { error: `The file is over ${FILE_MAX_BYTES / 1024 / 1024} MB, too large to save.` };
	const name = fileNameOf(body.url);
	const type = sniffFile(body.bytes, name);
	if (!type) return { error: "That's not a file messages take: save a picture (PNG, JPEG, WebP, GIF), PDF, Word, Excel or text file. For a page, read it with web_fetch." };
	return { name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${extensions[type]}`, type };
}

const extensions: Record<FileType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"application/pdf": "pdf",
	[DOCX]: "docx",
	[XLSX]: "xlsx",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"application/json": "json",
};

/** The last part of a link's path, as a file name ("logo.png"), or "file". */
function fileNameOf(url: string) {
	try {
		return cleanFileName(decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""));
	} catch {
		return "file";
	}
}

/** undici's own message ("fetch failed", "terminated") says nothing; the cause says why. */
function reason(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}

export type BodyFetcher = typeof fetchBody;

/**
 * One link someone else picked, read safely: the only way to fetch one (web pages, link previews, pictures on them).
 * No Brotli: Convex's Node runtime refuses to decompress it, and undici asks for it by default, so
 * every page a CDN (Vercel, Cloudflare, Akamai) sends as `br` died with "terminated".
 */
export const fetchBody = (url: string, { timeoutMs, maxBytes, accept }: { timeoutMs: number; maxBytes: number; accept: string }) =>
	safeFetch(url, { resolve, request }, { timeoutMs, maxBytes, headers: { "user-agent": USER_AGENT, accept, "accept-encoding": "gzip, deflate" } });

async function resolve(hostname: string) {
	return (await dnsLookup(hostname, { all: true })).map((a) => a.address);
}

/** One GET that can only connect to `addresses`, the ones safeFetch checked. */
async function request(url: URL, addresses: string[], { signal, headers }: { signal: AbortSignal; headers: Record<string, string> }) {
	const pinned: LookupFunction = (_host, options, callback) => {
		const all = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
		if (options.all) callback(null, all);
		else callback(null, all[0]!.address, all[0]!.family);
	};
	const dispatcher = new Agent({ connect: { lookup: pinned } });
	try {
		return (await fetch(url, { headers, signal, redirect: "manual", dispatcher })) as unknown as Response;
	} finally {
		// Graceful: the body still reads to the end (or to safeFetch's maxBytes), then it closes.
		void dispatcher.close();
	}
}

/**
 * HTML through Readability to Markdown; PDF, Word and Excel files as their text (`fileText`, as
 * chat.read_file reads them); text, JSON and XML as served; anything else refused.
 */
export async function pageFrom(body: FetchedBody): Promise<WebPage | { error: string }> {
	const { url, status, contentType, cut } = body;
	if (status >= 400) return { error: `The page answered ${status}.` };
	// By its bytes first: servers often send files as application/octet-stream.
	const file = sniffDocument(body.bytes) ?? ["application/pdf", DOCX, XLSX].find((type) => type === contentType);
	if (file) {
		if (cut) return { error: `The file is over ${FILE_MAX_BYTES / 1024 / 1024} MB, too large to read.` };
		return { url, ...clipPage(await fileText(body.bytes, file)) };
	}
	const text = textOf(body);
	const note = cut ? "\n\n[The page was too large; only its start was read.]" : "";
	if (contentType === "text/html" || contentType === "application/xhtml+xml" || (!contentType && /^\s*</.test(text))) {
		const { title, markdown, files } = readable(text, url);
		const page = clipPage(markdown + note, PAGE_CHARS - files.length);
		return { url, ...(title && { title }), content: page.content + files, truncated: page.truncated };
	}
	if (contentType.startsWith("text/") || /^application\/([\w.-]+\+)?(json|xml)$/.test(contentType) || !contentType) return { url, ...clipPage(text + note) };
	return { error: `Can't read ${contentType} files: only web pages, PDF, Word and Excel files, text, JSON and XML.` };
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form"] as TurndownService.Filter);
// Images cost characters the model can't use. A rule, since turndown's own image rule beats `remove`.
turndown.addRule("noImages", { filter: "img", replacement: () => "" });

/** Files a page links to that web.fetch can read, by extension. */
const READABLE_FILE = /\.(pdf|xlsx|docx|csv|tsv|txt|json|xml|md)$/i;
/** Room the list of linked files may take out of a page's PAGE_CHARS. */
const FILES_CHARS = 6_000;

/**
 * The page's main text as Markdown (Mozilla Readability), with links made absolute so they can be
 * followed and cited. Readability drops download lists as clutter, so `files` lists the data files
 * the page links to that didn't make it in: often the source itself (a statistics office's tables).
 */
export function readable(html: string, url: string): { title?: string; markdown: string; files: string } {
	const { document } = parseHTML(html);
	const linked = new Map<string, string>();
	for (const a of document.querySelectorAll("a[href]")) {
		try {
			const href = new URL(a.getAttribute("href")!, url);
			a.setAttribute("href", href.href);
			if (READABLE_FILE.test(href.pathname) && !linked.has(href.href)) linked.set(href.href, a.textContent ?? "");
		} catch {
			a.removeAttribute("href");
		}
	}
	const title = document.querySelector("title")?.textContent?.trim() || undefined;
	// Before Readability, which takes the <head> and most logos out of the document.
	const pictures = pictureList(document, url);
	const article = new Readability(document as unknown as Document).parse();
	const markdown = turndown.turndown(article?.content ?? document.body?.innerHTML ?? "").trim();
	return { title: article?.title?.trim() || title, markdown, files: fileList(linked, markdown) + pictures };
}

/** Pictures listed per page: a logo, icons and the preview image are all anyone saves. */
const PICTURES_MAX = 8;
/** Formats web.save takes; SVG and ICO aren't. */
const SAVABLE_PICTURE = /\.(png|jpe?g|webp|gif)$/i;

/**
 * "Pictures on this page": its icons (apple-touch-icon first, the usual square logo), pictures named
 * logo, and its preview image, as links web.save can take. Images are otherwise dropped from the Markdown.
 */
function pictureList(document: ReturnType<typeof parseHTML>["document"], url: string) {
	const found = new Map<string, string>();
	const add = (raw: string | null | undefined, label: string, savable = true) => {
		if (!raw || found.size >= PICTURES_MAX) return;
		try {
			const href = new URL(raw, url);
			if ((href.protocol === "https:" || href.protocol === "http:") && savable && !found.has(href.href)) found.set(href.href, label);
		} catch {}
	};
	const typed = (el: Element) => SAVABLE_PICTURE.test(el.getAttribute("href") ?? "") || /^image\/(png|jpeg|webp|gif)$/.test(el.getAttribute("type") ?? "");
	for (const el of document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]')) add(el.getAttribute("href"), "Icon (apple-touch-icon)", typed(el) || !el.getAttribute("type"));
	for (const el of document.querySelectorAll("img")) {
		const words = ["src", "alt", "class", "id"].map((a) => el.getAttribute(a) ?? "").join(" ");
		if (/logo/i.test(words)) add(el.getAttribute("src"), `Logo${el.getAttribute("alt") ? `: ${el.getAttribute("alt")!.replace(/\s+/g, " ").trim().slice(0, 80)}` : ""}`, !/\.svg(\?|$)/i.test(el.getAttribute("src") ?? ""));
	}
	for (const el of document.querySelectorAll('link[rel~="icon"]')) add(el.getAttribute("href"), `Icon${el.getAttribute("sizes") ? ` (${el.getAttribute("sizes")})` : ""}`, typed(el));
	for (const el of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) add(el.getAttribute("content"), "Preview image");
	if (found.size === 0) return "";
	return `\n\n## Pictures on this page\n${[...found].map(([href, label]) => `- [${label.replace(/[[\]]/g, "")}](${href})`).join("\n")}`;
}

/** "Files linked on this page" as Markdown links, for the ones not already in `markdown`, within FILES_CHARS. */
function fileList(linked: Map<string, string>, markdown: string) {
	const lines: string[] = [];
	let size = 0;
	const missing = [...linked].filter(([href]) => !markdown.includes(href));
	for (const [href, text] of missing) {
		const name = text.replace(/\s+/g, " ").trim() || (href.split("/").pop() ?? href);
		const line = `- [${(name.length > 140 ? `${name.slice(0, 139)}…` : name).replace(/[[\]]/g, "")}](${href})`;
		if (size + line.length + 1 > FILES_CHARS) break;
		lines.push(line);
		size += line.length + 1;
	}
	if (lines.length === 0) return "";
	const more = missing.length - lines.length;
	return `\n\n## Files linked on this page\n${lines.join("\n")}${more > 0 ? `\n(${more} more not listed.)` : ""}`;
}
