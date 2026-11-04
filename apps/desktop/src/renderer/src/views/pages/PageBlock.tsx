import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { pageBlockConfig } from "@companybot/backend/page-blocks";
import { pageHref } from "@companybot/core/page-links";
import { createContext, useContext, useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { ArchiveIcon, MoreIcon, PageIcon } from "../../icons";
import { navigate } from "../../router";
import { MenuItem, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { MovePage } from "./PageTree";
import { RenamePage } from "./PageTitle";

export type PageReference = FunctionReturnType<typeof api.pages.get>;
export const PageReferences = createContext<Map<string, PageReference> | null>(null);

/** A page is an atomic block. Its title comes from the page, never from editable link text. */
export function PageBlockRow({ pageId, title, editable = false }: { pageId: string; title: string; editable?: boolean }) {
	const page = useQuery(api.pages.get, { pageId });
	const references = useContext(PageReferences);
	useEffect(() => { if (page !== undefined) references?.set(pageId, page); }, [pageId, page, references]);
	const archive = useMutation(api.trash.move);
	const { confirm, dialog } = useConfirm();
	const [moving, setMoving] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const name = page?.title ?? title;
	return (
		<div className="page-block group/page flex w-full min-w-0 items-center rounded-md hover:bg-neutral-100/70" contentEditable={false}>
			<a href={pageHref(pageId)} onClick={(e) => { e.preventDefault(); navigate("pages", pageId); }} className="page-block-link flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-inherit focus-visible:outline-2 focus-visible:outline-neutral-400">
				<PageIcon className="shrink-0 text-neutral-400" />
				<span className="truncate font-medium underline decoration-neutral-300 underline-offset-4">{name}</span>
				{page?.archived && <span className="text-xs text-neutral-400">Archived</span>}
				{page === null && <span className="text-xs text-neutral-400">Unavailable</span>}
			</a>
			{editable && page?.canEdit && <Popover trigger={<MoreIcon />} label={`Actions for ${name}`} className="mr-1 rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 group-hover/page:opacity-100 focus:opacity-100 aria-expanded:opacity-100" panelClassName="w-44 p-1">
				{(close) => <>
					<MenuItem onClick={() => { close(); navigate("pages", pageId); }}>Open page</MenuItem>
					<MenuItem onClick={() => { close(); setRenaming(true); }}>Rename</MenuItem>
					<MenuItem onClick={() => { close(); setMoving(true); }}>Move to…</MenuItem>
					<MenuItem onClick={() => { close(); confirm(archiveQuestion(name, () => archive({ kind: "page", id: pageId }), "Its sub-pages will be archived with it.")); }}><ArchiveIcon /> Archive</MenuItem>
				</>}
			</Popover>}
			{dialog}
			{moving && page && <MovePage page={page} onClose={() => setMoving(false)} />}
			{renaming && page && <RenamePage page={page} onClose={() => setRenaming(false)} />}
		</div>
	);
}

const pageBlock = createReactBlockSpec(pageBlockConfig, {
	render: ({ block, editor }) => <PageBlockRow pageId={block.props.pageId} title={block.props.title} editable={editor.isEditable} />,
	toExternalHTML: ({ block }) => <a href={pageHref(block.props.pageId)}>{block.props.title}</a>,
})();

export const pageEditorSchema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, page: pageBlock } });
export type PageBlockEditor = typeof pageEditorSchema.BlockNoteEditor;
