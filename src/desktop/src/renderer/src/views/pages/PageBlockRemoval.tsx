import { useContext, useEffect, useRef } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { archiveQuestion, useConfirm } from "../chat/common";
import { PageReferences, type PageBlockEditor } from "./PageBlock";

type Doc = Parameters<Parameters<PageBlockEditor["onBeforeChange"]>[0]>[0]["tr"]["doc"];

/** Each block's id, and for page blocks the page it points at. */
function blocks(doc: Doc) {
	const found = new Map<string, { pageId?: string }>();
	doc.descendants((node) => {
		if (typeof node.attrs.id === "string" && node.attrs.id) found.set(node.attrs.id, { pageId: node.firstChild?.type.name === "page" ? node.firstChild.attrs.pageId : undefined });
	});
	return found;
}

/** Keyboard, cut and block-menu removal must ask before archiving a page. */
export function PageBlockRemoval({ editor, pageId, editable }: { editor: PageBlockEditor; pageId: string; editable: boolean }) {
	const archive = useMutation(api.trash.move);
	const references = useContext(PageReferences);
	const { confirm, dialog } = useConfirm();
	const allowed = useRef(false);
	const ask = useRef(confirm);
	ask.current = confirm;
	useEffect(() => {
		if (!editable) return;
		return editor.onBeforeChange(({ tr }) => {
			// Server sync/history changes already carry their authorization.
			if (allowed.current || !tr.docChanged || tr.getMeta("addToHistory") === false || tr.getMeta("rebased") !== undefined) return;
			// This runs before BlockNote gives new blocks their ids (Enter, paste), where its getChanges() throws;
			// a deleted block is one of the old document's, and those all have ids, so compare documents.
			const before = blocks(tr.before);
			const after = blocks(tr.doc);
			const allDeleted = [...before.keys()].filter((id) => !after.has(id));
			const pages = allDeleted.flatMap((id) => { const target = before.get(id)?.pageId; return target ? [target] : []; });
			if (!pages.length) return;
			const children = pages.flatMap((target) => { const page = references?.get(target); return page && !page.archived && page.parentId === pageId ? [page] : []; });
			const remove = async () => {
				for (const id of new Set(children.map((page) => page._id))) await archive({ kind: "page", id });
				allowed.current = true;
				try {
					const remaining = allDeleted.filter((id) => editor.getBlock(id));
					if (remaining.length) editor.removeBlocks(remaining);
				} finally { allowed.current = false; }
			};
			queueMicrotask(() => ask.current(children.length ? archiveQuestion(children.length === 1 ? children[0]!.title : `${children.length} pages`, remove, "Removing a child page block archives the page and its sub-pages.") : { title: "Remove page block?", action: "Remove block", danger: false, body: "This removes the reference from this page. The linked page and its contents are kept.", onConfirm: remove }));
			return false;
		});
	}, [editor, editable, archive, pageId, references]);
	return dialog;
}
