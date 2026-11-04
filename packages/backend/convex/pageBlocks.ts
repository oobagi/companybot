import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from "@blocknote/core";
import { linkedPageId, pageHref } from "@companybot/core/page-links";
import { pageBlockConfig } from "@companybot/core/page-block-config";

/** Shared config contains only ids: titles are resolved through each reader's current access. */
export { pageBlockConfig };

const pageLink = (pageId: string) => {
	const dom = document.createElement("a");
	dom.href = pageHref(pageId);
	dom.textContent = "Page";
	return { dom };
};

export const pageBlockSpec = createBlockSpec(pageBlockConfig, {
	render: (block) => pageLink(block.props.pageId),
	toExternalHTML: (block) => pageLink(block.props.pageId),
})();

/**
 * Content (a document, a snapshot or a step, as JSON) without page titles: ones stored before page blocks
 * dropped them. Everything sync, history and restore hand out goes through this.
 */
export function withoutPageTitles(json: string) {
	if (!json.includes('"title"')) return json;
	const walk = (x: unknown): void => {
		if (Array.isArray(x)) return x.forEach(walk);
		if (!x || typeof x !== "object") return;
		const o = x as Record<string, unknown>;
		if (o.type === "page" && o.attrs && typeof o.attrs === "object") delete (o.attrs as Record<string, unknown>).title;
		// A step setting a page block's title (AttrStep): kept, so step counts match, but empty.
		if (o.stepType === "attr" && o.attr === "title") o.value = null;
		Object.values(o).forEach(walk);
	};
	const parsed: unknown = JSON.parse(json);
	walk(parsed);
	return JSON.stringify(parsed);
}

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
			blocks.push({ type: "page", props: { pageId } });
		} else text.push(part);
	}
	flush();
	blocks[0]!.id = block.id;
	blocks.at(-1)!.children = block.children;
	return blocks;
}
