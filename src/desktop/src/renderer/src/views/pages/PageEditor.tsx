import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { BlockNoteEditor, docToBlocks, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { BlockNoteView, type Theme, lightDefaultTheme } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { SuggestionMenuController, getDefaultReactSlashMenuItems } from "@blocknote/react";
import { linkedPageId, pageHref, validPageHref } from "@companybot/core/page-links";
import { type MouseEvent, useMemo, useState } from "react";
import { api, errorMessage } from "../../api";
import { useMutation } from "../../convex";
import { PageIcon } from "../../icons";
import { navigate } from "../../router";
import { Loading, Notice } from "../../ui";
import { useLinkedPages } from "./useLinkedPages";
import { PageLevel } from "./PageTree";

// A page's content: BlockNote, synced live through prosemirror-sync (backend pageSync.ts).
// The sync calls name only the page; the backend finds its workspace. See wiki/pages.md.

/** BlockNote's own light theme, in the app's font. */
const theme: Theme = { ...lightDefaultTheme, fontFamily: "inherit", colors: { ...lightDefaultTheme.colors, editor: { text: "var(--color-neutral-900)", background: "transparent" } } };

/** BlockNote pads the left for its block handles: pull it back so text lines up with the title. */
const viewClass = "page-editor -mx-[54px]";
const links = { isValidLink: validPageHref };

/** Capture before BlockNote opens a window; also works in read-only version previews. */
function openPageLink(event: MouseEvent<HTMLDivElement>) {
	if (event.button !== 0 && event.button !== 1) return;
	const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
	const id = anchor && linkedPageId(anchor.getAttribute("href") ?? "");
	if (!id) return;
	event.preventDefault();
	event.stopPropagation();
	navigate("pages", id);
}

export function PageEditor({ pageId, editable, standalone = false }: { pageId: Id<"pages">; editable: boolean; standalone?: boolean }) {
	const create = useMutation(api.pages.create);
	const [error, setError] = useState<string>();
	const sync = useBlockNoteSync<BlockNoteEditor>(api.pageSync, pageId, { editorOptions: { links }, onSyncError: (e) => setError(errorMessage(e)) });
	if (sync.isLoading) return <Loading />;
	if (!sync.editor) return <Notice>This page isn't available.</Notice>;
	return (
		<>
			{error && <Notice>{error}</Notice>}
			<div onClickCapture={openPageLink} onAuxClickCapture={openPageLink}>
				<BlockNoteView editor={sync.editor} editable={editable} theme={theme} className={viewClass} slashMenu={false}>
					<SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems([
						...getDefaultReactSlashMenuItems(sync.editor),
						...(standalone ? [{ title: "Page", subtext: "Add a page inside", aliases: ["page", "subpage"], group: "Pages", icon: <PageIcon />, onItemClick: async () => {
							try {
								const id = await create({ title: "Untitled", parentId: pageId });
								insertOrUpdateBlockForSlashMenu(sync.editor, { type: "paragraph", content: [{ type: "link", href: pageHref(id), content: "Untitled" }] });
							} catch (e) { setError(errorMessage(e)); }
						} }] : []),
					], query)} />
				</BlockNoteView>
			</div>
			{standalone && <ChildPages editor={sync.editor} pageId={pageId} />}
		</>
	);
}

let schemaEditor: BlockNoteEditor | undefined;

/** An old version's content (ProseMirror JSON), read-only. */
export function VersionPreview({ content }: { content: string }) {
	const editor = useMemo(() => {
		schemaEditor ??= BlockNoteEditor.create({ links });
		const doc = schemaEditor.pmSchema.nodeFromJSON(JSON.parse(content));
		return BlockNoteEditor.create({ links, initialContent: docToBlocks(doc) });
	}, [content]);
	return <div onClickCapture={openPageLink} onAuxClickCapture={openPageLink}><BlockNoteView editor={editor} editable={false} theme={theme} className={viewClass} /></div>;
}

/** Sidebar-created children appear here too; embedded links already have a place in the document. */
function ChildPages({ editor, pageId }: { editor: BlockNoteEditor; pageId: Id<"pages"> }) {
	const linked = useLinkedPages(editor);
	return <div className="flex flex-col gap-1"><PageLevel parentId={pageId} render={(p) => !linked.has(p._id) && <button key={p._id} type="button" onClick={() => navigate("pages", p._id)} className="flex items-center gap-2 rounded-lg p-2 text-left text-sm hover:bg-neutral-50"><PageIcon /><span className="underline decoration-neutral-300 underline-offset-4">{p.title}</span></button>} /></div>;
}
