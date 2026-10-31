import type { PageBlockEditor } from "./PageBlock";
import { linkedPageId } from "@companybot/core/page-links";
import { useEffect, useState } from "react";

/** One initial scan, then one after a pause; typing never walks the document synchronously. */
export function useLinkedPages(editor: Pick<PageBlockEditor, "forEachBlock" | "onChange">) {
	const linkedIds = () => {
		const ids = new Set<string>();
		editor.forEachBlock((block) => {
			if (block.type === "page" && block.props.pageId) ids.add(block.props.pageId);
			if (Array.isArray(block.content)) for (const inline of block.content) {
				if (inline.type === "link" && linkedPageId(inline.href)) ids.add(linkedPageId(inline.href)!);
			}
			return true;
		});
		return ids;
	};
	const [linked, setLinked] = useState(linkedIds);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		const unsubscribe = editor.onChange(() => {
			clearTimeout(timer);
			timer = setTimeout(() => setLinked(linkedIds()), 300);
		});
		return () => { clearTimeout(timer); unsubscribe(); };
	}, [editor]);
	return linked;
}
