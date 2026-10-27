import { BlockNoteSchema, addDefaultPropsExternalHTML, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { PageIcon } from "../../icons";
import { navigate } from "../../router";

const paragraph = defaultBlockSpecs.paragraph;
// COMPAT(0.1.0-alpha.8): store ordinary linked paragraphs, so alpha.7 can read/write every document.
// Once alpha.7 retires this can become a dedicated node type, after migrating stored documents.
const PageParagraph = createReactBlockSpec(paragraph.config, {
	meta: paragraph.implementation.meta,
	parse: paragraph.implementation.parse,
	runsBefore: paragraph.implementation.runsBefore,
	render: ({ block, contentRef }) => {
		const link = block.content.length === 1 && block.content[0]?.type === "link" ? block.content[0] : null;
		const id = link && "href" in link && typeof link.href === "string" ? link.href.match(/^#\/pages\/([a-z0-9]+)$/)?.[1] : undefined;
		if (!id) return <p ref={contentRef} />;
		return <div className="flex w-full items-center gap-2 rounded-lg px-2 py-1 hover:bg-neutral-50"><span ref={contentRef} className="hidden" /><PageLink pageId={id as Id<"pages">} /></div>;
	},
	toExternalHTML: ({ block, contentRef }) => <p ref={(element) => { if (element) addDefaultPropsExternalHTML(block.props, element); contentRef?.(element); }} />,
}, paragraph.extensions);

function PageLink({ pageId }: { pageId: Id<"pages"> }) {
	const page = useQuery(api.pages.get, { pageId });
	return <button type="button" contentEditable={false} onClick={() => page && navigate("pages", pageId)} className="flex w-full items-center gap-2 text-left" disabled={page === null}>
		<PageIcon className="shrink-0 text-neutral-400" /><span className="underline decoration-neutral-300 underline-offset-4">{page?.title ?? (page === null ? "Deleted page" : "Page")}{page?.archived ? " (deleted)" : ""}</span>
	</button>;
}

export const editorSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, paragraph: PageParagraph() } });
