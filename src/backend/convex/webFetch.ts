"use node";

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { DOCX, FILE_MAX_BYTES, PAGE_CHARS, type WebPage, XLSX, clipPage, sniffDocument } from "@companybot/core";
import { fileText } from "@companybot/core/file-text";
import { type FetchedBody, UnsafeUrlError, safeFetch, textOf } from "@companybot/core/safe-fetch";
import { Readability } from "@mozilla/readability";
import { v } from "convex/values";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, fetch } from "undici";
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
			if (e instanceof UnsafeUrlError) return { error: e.message };
			if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { error: "The page took too long to load." };
			return { error: `Couldn't load the page: ${e instanceof Error ? e.message : String(e)}` };
		}
	},
});

export type BodyFetcher = typeof fetchBody;

/** One link someone else picked, read safely: the only way to fetch one (web pages, link previews, pictures on them). */
export const fetchBody = (url: string, { timeoutMs, maxBytes, accept }: { timeoutMs: number; maxBytes: number; accept: string }) =>
	safeFetch(url, { resolve, request }, { timeoutMs, maxBytes, headers: { "user-agent": USER_AGENT, accept } });

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
	const article = new Readability(document as unknown as Document).parse();
	const markdown = turndown.turndown(article?.content ?? document.body?.innerHTML ?? "").trim();
	return { title: article?.title?.trim() || title, markdown, files: fileList(linked, markdown) };
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
