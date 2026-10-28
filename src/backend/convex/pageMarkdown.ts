"use node";

import { type Block, BlockNoteEditor, blockToNode, docToBlocks } from "@blocknote/core";
import { validPageHref } from "@companybot/core/page-links";
import { Window } from "happy-dom";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// BlockNote's Markdown conversion needs a DOM. happy-dom bundles in Node; jsdom reads runtime files.

let editor: BlockNoteEditor | undefined;
function blockNote() {
	if (!editor) {
		const window = new Window();
		// BlockNote reads both: document to parse, window.document to serialize.
		globalThis.window ??= window as unknown as typeof globalThis.window;
		globalThis.document ??= window.document as unknown as Document;
		editor = BlockNoteEditor.create({ links: { isValidLink: validPageHref } });
	}
	return editor;
}

/** A page's content (ProseMirror JSON) as Markdown. Colors and alignment are dropped. */
export const toMarkdown = internalAction({
	args: { doc: v.string() },
	handler: async (_ctx, { doc }) => {
		const bn = blockNote();
		return bn.blocksToMarkdownLossy(docToBlocks(bn.pmSchema.nodeFromJSON(JSON.parse(doc))) as Block[]);
	},
});

/** Markdown as blocks (ProseMirror JSON), for pageOps.writeBlocks. */
export const fromMarkdown = internalAction({
	args: { markdown: v.string() },
	handler: async (_ctx, { markdown }) => {
		const bn = blockNote();
		return JSON.stringify(bn.tryParseMarkdownToBlocks(markdown).map((b) => blockToNode(b, bn.pmSchema).toJSON()));
	},
});
