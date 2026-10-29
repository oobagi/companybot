"use node";

import { sniffImage } from "@companybot/core/images";
import type { FetchedBody } from "@companybot/core/safe-fetch";
import { v } from "convex/values";
import { parseHTML } from "linkedom";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { type BodyFetcher, fetchBody } from "./webFetch";

// Link previews, the network side: reads the first links of a message through safeFetch (webFetch.ts),
// takes the Open Graph / Twitter card / <title> details, and keeps our own copy of the picture, so
// readers' apps never load a page's image from its server (that would show the sender their IP
// addresses and when they read). Saved by linkPreviews.save.

const PAGE_BYTES = 1_000_000;
const IMAGE_BYTES = 1_000_000;
const TIMEOUT_MS = 5_000;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 300;

export type Unfurl = { title?: string; description?: string; siteName?: string; imageUrl?: string };

/** Fetches these links and saves what they look like. A link that can't be read is saved empty, so it isn't asked again at once. */
export const unfurl = internalAction({
	args: { messageId: v.id("chatMessages"), urls: v.array(v.string()) },
	handler: async (ctx, { messageId, urls }) => {
		const results = await Promise.all(
			urls.map(async (url) => {
				const found = await fetchPreview(url);
				const image = found?.image && (await ctx.storage.store(new Blob([new Uint8Array(found.image.bytes)], { type: found.image.type })));
				return { url, ...(found && { title: found.title, description: found.description, siteName: found.siteName }), ...(image && { image }) };
			}),
		);
		await ctx.runMutation(internal.linkPreviews.save, { messageId, results });
	},
});

/** A page's details and picture, or undefined if it has nothing to show or can't be read (private addresses and timeouts included). */
export async function fetchPreview(url: string, get: BodyFetcher = fetchBody) {
	try {
		const page = await get(url, { timeoutMs: TIMEOUT_MS, maxBytes: PAGE_BYTES, accept: "text/html, application/xhtml+xml" });
		const found = previewFrom(page);
		if (!found) return undefined;
		const { imageUrl, ...details } = found;
		return { ...details, image: imageUrl ? await fetchImage(imageUrl, get) : undefined };
	} catch {
		return undefined;
	}
}

/** The page's own picture, if it's a PNG, JPEG, WebP or GIF (by its bytes) under 1 MB. */
async function fetchImage(url: string, get: BodyFetcher) {
	try {
		const { status, bytes, cut } = await get(url, { timeoutMs: TIMEOUT_MS, maxBytes: IMAGE_BYTES, accept: "image/png, image/jpeg, image/webp, image/gif" });
		const type = status < 400 && !cut ? sniffImage(bytes) : undefined;
		return type ? { bytes, type } : undefined;
	} catch {
		return undefined;
	}
}

const clip = (text: string | null | undefined, max: number) => {
	const clean = text?.replace(/\s+/g, " ").trim();
	return clean ? (clean.length > max ? `${clean.slice(0, max - 1)}…` : clean) : undefined;
};

/** What an HTML page says about itself: Open Graph, then Twitter card, then <title> and <meta name="description">. Undefined without a title or description. */
export function previewFrom({ url, status, contentType, bytes }: FetchedBody): Unfurl | undefined {
	if (status >= 400 || (contentType !== "text/html" && contentType !== "application/xhtml+xml")) return undefined;
	const { document } = parseHTML(new TextDecoder().decode(bytes));
	// The first of each wins, like a browser's.
	const meta: Record<string, string> = {};
	for (const tag of document.querySelectorAll("meta")) {
		const key = (tag.getAttribute("property") ?? tag.getAttribute("name"))?.trim().toLowerCase();
		const content = tag.getAttribute("content");
		if (key && content && !(key in meta)) meta[key] = content;
	}
	const title = clip(meta["og:title"] ?? meta["twitter:title"] ?? document.querySelector("title")?.textContent, TITLE_MAX);
	const description = clip(meta["og:description"] ?? meta["twitter:description"] ?? meta["description"], DESCRIPTION_MAX);
	if (!title && !description) return undefined;
	const siteName = clip(meta["og:site_name"], 80) ?? new URL(url).hostname.replace(/^www\./, "");
	return { title, description, siteName, imageUrl: imageUrlOf(meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"], url) };
}

/** The picture's address in full (pages write them relative), if it's a web address. */
function imageUrlOf(raw: string | undefined, page: string) {
	try {
		const url = raw && new URL(raw.trim(), page);
		return url && (url.protocol === "https:" || url.protocol === "http:") ? url.href : undefined;
	} catch {
		return undefined;
	}
}
