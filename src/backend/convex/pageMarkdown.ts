"use node";

import { BlockNoteEditor, blockToNode, docToBlocks } from "@blocknote/core";
import { Window } from "happy-dom";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// Markdown ↔ page content, for agent tools. BlockNote converts through HTML, which needs a DOM:
// happy-dom gives it one (jsdom reads files at runtime, so it can't be bundled), so this runs
// in Node and does nothing else: pageTools.ts reads and writes the page. See wiki/pages.md.

let editor: BlockNoteEditor | undefined;
function blockNote() {
	if (!editor) {
		globalThis.document ??= new Window().document as unknown as Document;
		editor = BlockNoteEditor.create({ _headless: true });
	}
	return editor;
}

/** A page's content (ProseMirror JSON) as Markdown. Colors and alignment are dropped. */
export const toMarkdown = internalAction({
	args: { doc: v.string() },
	handler: async (_ctx, { doc }) => {
		const bn = blockNote();
		return bn.blocksToMarkdownLossy(docToBlocks(bn.pmSchema.nodeFromJSON(JSON.parse(doc))));
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
