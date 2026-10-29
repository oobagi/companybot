"use node";

import { fileText, textPage } from "@companybot/core/file-text";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// PDF.js (through unpdf) is big and wants Node, so files are read here, for chat.read_file.

/** One page of a stored file's text. The caller checked who may read it (files.readFor). */
export const page = internalAction({
	args: { storageId: v.id("_storage"), type: v.string(), page: v.optional(v.number()) },
	handler: async (ctx, { storageId, type, page }) => {
		const blob = await ctx.storage.get(storageId);
		if (!blob) return null;
		return textPage(await fileText(new Uint8Array(await blob.arrayBuffer()), type), page);
	},
});
