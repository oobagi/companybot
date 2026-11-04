import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from "@blocknote/core";
import { linkedPageId, pageHref } from "@companybot/core/page-links";

/** Shared by sync, history, agent conversion and the React editor. */
export const pageBlockConfig = {
	type: "page",
	propSchema: { pageId: { default: "" }, title: { default: "Untitled" } },
	content: "none",
} as const;

export const pageBlockSpec = createBlockSpec(pageBlockConfig, {
	render: (block) => {
		const dom = document.createElement("a");
		dom.href = pageHref(block.props.pageId);
		dom.textContent = block.props.title;
		return { dom };
	},
	toExternalHTML: (block) => {
		const dom = document.createElement("a");
		dom.href = pageHref(block.props.pageId);
		dom.textContent = block.props.title;
		return { dom };
	},
})();

export const pageBlockSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, page: pageBlockSpec } });

/** Promote old page links without losing text typed alongside them. */
export function promotePageLinks(block: (typeof pageBlockSchema.BlockNoteEditor)["document"][number]): Parameters<(typeof pageBlockSchema.BlockNoteEditor)["replaceBlocks"]>[1] | undefined {
	if (block.type !== "paragraph" || !block.content.some((part) => part.type === "link" && linkedPageId(part.href))) return;
	const blocks: Parameters<(typeof pageBlockSchema.BlockNoteEditor)["replaceBlocks"]>[1] = [];
	let text: typeof block.content = [];
	const flush = () => {
		if (text.length) blocks.push({ type: "paragraph", props: block.props, content: text });
		text = [];
	};
	for (const part of block.content) {
		const pageId = part.type === "link" && linkedPageId(part.href);
		if (pageId && part.type === "link") {
			flush();
			blocks.push({ type: "page", props: { pageId, title: part.content.map((span) => span.text).join("") || "Untitled" } });
		} else text.push(part);
	}
	flush();
	blocks[0]!.id = block.id;
	blocks.at(-1)!.children = block.children;
	return blocks;
}
