import { previewLinks } from "@companybot/core/link-preview";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { deleteFile } from "./images";
import { liveWorkspace } from "./lib";

// Link previews, the data side (the fetching is linkUnfurl.ts). A message's first links get cards:
// one `linkPreviews` row per URL per workspace, shared by every message that posts it and refetched
// once a day. A message points at its rows (`chatMessages.linkPreviews`); the sender can hide one.
// The row's picture is our own copy in file storage, deleted with the row (lifecycle.ts `files`).

/** How long a page that had details is trusted, and how long before a link that had none is tried again. */
const TTL_MS = 24 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;

/** A card as the app gets it. */
export type LinkPreview = { url: string; title: string | null; description: string | null; siteName: string | null; imageUrl: string | null };

export const previewRow = (ctx: QueryCtx, workspaceId: Id<"workspaces">, url: string) =>
	ctx.db.query("linkPreviews").withIndex("by_workspace_url", (q) => q.eq("workspaceId", workspaceId).eq("url", url)).unique();

const hasDetails = (row: Doc<"linkPreviews">) => !!(row.title || row.description);
const isFresh = (row: Doc<"linkPreviews">) => row.fetchedAt > Date.now() - (hasDetails(row) ? TTL_MS : RETRY_MS);

/** The rows saved for a message's links so far, in order, and the links that need fetching. */
async function savedFor(ctx: QueryCtx, message: Doc<"chatMessages">) {
	const rows: Doc<"linkPreviews">[] = [];
	const stale: string[] = [];
	for (const url of previewLinks(message.text)) {
		const row = await previewRow(ctx, message.workspaceId, url);
		if (row) rows.push(row);
		if (!row || !isFresh(row)) stale.push(url);
	}
	return { rows, stale };
}

/** Points a message at these rows (the ones with something to show), keeping what its sender hid. */
async function attach(ctx: MutationCtx, message: Doc<"chatMessages">, rows: Doc<"linkPreviews">[]) {
	const before = message.linkPreviews ?? [];
	const next = rows.filter(hasDetails).map((row) => before.find((p) => p.previewId === row._id) ?? { previewId: row._id });
	if (next.length !== before.length || next.some((p, i) => p !== before[i])) await ctx.db.patch(message._id, { linkPreviews: next.length > 0 ? next : undefined });
}

/**
 * Whenever a person's message text is set (sent or edited): cards for the links
 * already known show at once, and the rest are fetched in the background (`linkUnfurl.unfurl`).
 */
export async function previewMessage(ctx: MutationCtx, message: Doc<"chatMessages">) {
	// Never for agent-written text: fetching a link a model wrote, unclicked, would let injected
	// instructions carry data out in its query string (the exfiltration web.fetch's allowlist stops).
	if (message.authorAgentId) return;
	const { rows, stale } = await savedFor(ctx, message);
	await attach(ctx, message, rows);
	if (stale.length > 0) await ctx.scheduler.runAfter(0, internal.linkUnfurl.unfurl, { messageId: message._id, urls: stale });
}

/** The cards a message shows: not hidden ones, none once it's deleted. */
export async function previewsOf(ctx: QueryCtx, message: Doc<"chatMessages">): Promise<LinkPreview[]> {
	const cards: LinkPreview[] = [];
	for (const { previewId, hidden } of message.deleted || !message.linkPreviews ? [] : message.linkPreviews) {
		const row = hidden ? null : await ctx.db.get(previewId);
		if (!row) continue;
		cards.push({ url: row.url, title: row.title ?? null, description: row.description ?? null, siteName: row.siteName ?? null, imageUrl: row.image ? await ctx.storage.getUrl(row.image) : null });
	}
	return cards;
}

/**
 * What the action found, written after its wait: so the message may be deleted since, or its
 * workspace be going (the late-write rule, architecture.md), and then nothing is kept, pictures included.
 */
export const save = internalMutation({
	args: {
		messageId: v.id("chatMessages"),
		results: v.array(v.object({ url: v.string(), title: v.optional(v.string()), description: v.optional(v.string()), siteName: v.optional(v.string()), image: v.optional(v.id("_storage")) })),
	},
	handler: async (ctx, { messageId, results }) => {
		const message = await ctx.db.get(messageId);
		if (!message || message.deleted || !(await liveWorkspace(ctx, message.workspaceId))) {
			for (const { image } of results) if (image) await deleteFile(ctx, image);
			return;
		}
		for (const { url, ...found } of results) {
			const row = await previewRow(ctx, message.workspaceId, url);
			const fetched = !!(found.title || found.description);
			if (row && hasDetails(row) && !fetched) continue; // A failed refresh keeps what the card said; the next message with the link tries again.
			if (row?.image && row.image !== found.image) await deleteFile(ctx, row.image);
			const fields = { ...found, fetchedAt: Date.now() };
			if (row) await ctx.db.replace(row._id, { workspaceId: row.workspaceId, url, ...fields });
			else await ctx.db.insert("linkPreviews", { workspaceId: message.workspaceId, url, ...fields });
		}
		await attach(ctx, message, (await savedFor(ctx, message)).rows);
	},
});
