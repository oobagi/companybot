"use node";

import { fileText, textPage } from "@companybot/core/file-text";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// PDF.js (through unpdf) is big and wants Node, so files are read here, for chat.read_file.

/** Text of the last few files read, by storage id, so paging through one doesn't unpack it again.
 * Stored files never change, so it can't go stale. Convex may or may not reuse this process
 * between calls; a miss just reads the file again. */
const recent = new Map<string, string>();
const RECENT_MAX = 8;

/** One page of a stored file's text. The caller checked who may read it (files.readFor). */
export const page = internalAction({
	args: { storageId: v.id("_storage"), type: v.string(), page: v.optional(v.number()) },
	handler: async (ctx, { storageId, type, page }) => {
		let text = recent.get(storageId);
		if (text === undefined) {
			const blob = await ctx.storage.get(storageId);
			if (!blob) return null;
			text = await fileText(new Uint8Array(await blob.arrayBuffer()), type);
		}
		recent.delete(storageId);
		recent.set(storageId, text);
		if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
		return textPage(text, page);
	},
});
