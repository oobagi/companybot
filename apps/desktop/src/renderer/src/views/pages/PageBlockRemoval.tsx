import { useContext, useEffect, useRef } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { archiveQuestion, useConfirm } from "../chat/common";
import { PageReferences, type PageBlockEditor } from "./PageBlock";

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
		return editor.onBeforeChange(({ getChanges, tr }) => {
			// Server sync/history changes already carry their authorization.
			if (allowed.current || tr.getMeta("addToHistory") === false || tr.getMeta("rebased") !== undefined) return;
			const deleted = getChanges().filter((change) => change.type === "delete" && change.block.type === "page");
			if (!deleted.length) return;
			const pages = deleted.map(({ block }) => { if (block.type !== "page") throw new Error("Expected a page block"); return block; });
			const children = pages.flatMap((block) => { const page = references?.get(block.props.pageId); return page && !page.archived && page.parentId === pageId ? [page] : []; });
			const allDeleted = getChanges().filter((change) => change.type === "delete").map(({ block }) => block.id);
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
