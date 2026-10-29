"use node";

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { type FetchedBody, UnsafeUrlError, safeFetch } from "@companybot/core/safe-fetch";
import { type WebPage, clipPage } from "@companybot/core";
import { Readability } from "@mozilla/readability";
import { v } from "convex/values";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Agent, fetch } from "undici";
import { internalAction } from "./_generated/server";

// web.fetch's network side. Node, for DNS: safeFetch (core) checks every address a link resolves
// to, and undici then connects only to those, so a link can't reach our own network.

const USER_AGENT = "Mozilla/5.0 (compatible; Companybot/1.0; +https://github.com/oobagi/companybot)";

/** Fetches one page and returns it as Markdown, cut at PAGE_CHARS. Expected problems come back as `{ error }`. */
export const fetchPage = internalAction({
	args: { url: v.string() },
	handler: async (_ctx, { url }): Promise<WebPage | { error: string }> => {
		try {
			const body = await safeFetch(url, { resolve, request }, { timeoutMs: 15_000, maxBytes: 5_000_000, headers: { "user-agent": USER_AGENT, accept: "text/html, text/*;q=0.9, application/json;q=0.8" } });
			return pageFrom(body);
		} catch (e) {
			if (e instanceof UnsafeUrlError) return { error: e.message };
			if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { error: "The page took too long to load." };
			return { error: `Couldn't load the page: ${e instanceof Error ? e.message : String(e)}` };
		}
	},
});

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

/** HTML through Readability to Markdown; text and JSON as served; anything else refused. */
export function pageFrom({ url, status, contentType, bytes, cut }: FetchedBody): WebPage | { error: string } {
	if (status >= 400) return { error: `The page answered ${status}.` };
	const text = new TextDecoder().decode(bytes);
	const note = cut ? "\n\n[The page was too large; only its start was read.]" : "";
	if (contentType === "text/html" || contentType === "application/xhtml+xml" || (!contentType && /^\s*</.test(text))) {
		const { title, markdown } = readable(text, url);
		return { url, ...(title && { title }), ...clipPage(markdown + note) };
	}
	if (contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json") || !contentType)
		return { url, ...clipPage(text + note) };
	return { error: `Can't read ${contentType} files yet: only web pages, text and JSON.` };
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "svg", "form"] as TurndownService.Filter);
// Images cost characters the model can't use. A rule, since turndown's own image rule beats `remove`.
turndown.addRule("noImages", { filter: "img", replacement: () => "" });

/** The page's main text as Markdown (Mozilla Readability), with links made absolute so they can be followed and cited. */
export function readable(html: string, url: string): { title?: string; markdown: string } {
	const { document } = parseHTML(html);
	for (const a of document.querySelectorAll("a[href]")) {
		try {
			a.setAttribute("href", new URL(a.getAttribute("href")!, url).href);
		} catch {
			a.removeAttribute("href");
		}
	}
	const title = document.querySelector("title")?.textContent?.trim() || undefined;
	const article = new Readability(document as unknown as Document).parse();
	const markdown = turndown.turndown(article?.content ?? document.body?.innerHTML ?? "").trim();
	return { title: article?.title?.trim() || title, markdown };
}
