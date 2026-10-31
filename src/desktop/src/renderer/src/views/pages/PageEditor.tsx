import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { BlockNoteEditor, docToBlocks, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { BlockNoteView, type Theme, lightDefaultTheme } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { BlockColorsItem, DragHandleMenu, RemoveBlockItem, SideMenu, SideMenuController, SuggestionMenuController, TableColumnHeaderItem, TableRowHeaderItem, getDefaultReactSlashMenuItems, useBlockNoteEditor, useExtensionState } from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { linkedPageId, validPageHref } from "@companybot/core/page-links";
import { type MouseEvent, useEffect, useMemo, useRef } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { PageIcon } from "../../icons";
import { navigate } from "../../router";
import { useUpload } from "../../upload";
import { EmptyState, Loading, Notice, useRun } from "../../ui";
import { useLinkedPages } from "./useLinkedPages";
import { PageLevel } from "./PageTree";
import { PageBlockRow, PageReferences, type PageReference, type PageBlockEditor, pageEditorSchema } from "./PageBlock";
import { promotePageLinks } from "./pageBlockUpgrades";
import { PageBlockRemoval } from "./PageBlockRemoval";

// A page's content: BlockNote, synced live through prosemirror-sync (backend pageSync.ts).
// The sync calls name only the page; the backend finds its workspace. See wiki/pages.md.

/** BlockNote's own light theme, in the app's font. */
const theme: Theme = { ...lightDefaultTheme, fontFamily: "inherit", colors: { ...lightDefaultTheme.colors, editor: { text: "var(--color-neutral-900)", background: "transparent" } } };

/** BlockNote pads the left for its block handles: pull it back so text lines up with the title. */
const viewClass = "page-editor -mx-[54px]";
const links = {
	isValidLink: validPageHref,
	// BlockNote's default opens every link with window.open, page links too; those navigate in openPageLink instead.
	onClick: (event: globalThis.MouseEvent) => {
		const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
		if (anchor && !linkedPageId(anchor.getAttribute("href") ?? "")) window.open(anchor.href, anchor.target);
		return true;
	},
};

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

export function PageEditor({ pageId, editable, standalone = false, focusKey = 0 }: { pageId: Id<"pages">; editable: boolean; standalone?: boolean; focusKey?: number }) {
	const create = useMutation(api.pages.create);
	const { error, fail } = useRun();
	const upload = useUpload();
	const addImage = useMutation(api.pages.addImage);
	const references = useRef(new Map<string, PageReference>());
	// Pasted, dropped or picked pictures (BlockNote's uploadFile). The editor is made once, so it calls the latest through a ref.
	const uploadImage = useRef<(file: File) => Promise<string>>(null);
	uploadImage.current = (file) => upload(file).then((id) => addImage({ pageId, file: id })).catch((e) => { fail(e); throw e; });
	const sync = useBlockNoteSync<PageBlockEditor>(api.pageSync, pageId, { editorOptions: { schema: pageEditorSchema, links, uploadFile: (file) => uploadImage.current!(file) }, onSyncError: fail });
	useEffect(() => {
		if (focusKey && editable && sync.editor) {
			const body = sync.editor.document.find((block) => Array.isArray(block.content)) ?? sync.editor.document.at(-1)!;
			sync.editor.setTextCursorPosition(body, "start");
			sync.editor.focus();
		}
	}, [sync.editor, editable, focusKey]);
	if (sync.isLoading) return <Loading />;
	if (!sync.editor) return <EmptyState icon={<PageIcon />} title="Page unavailable">Try opening this page again.</EmptyState>;
	return (
		<PageReferences.Provider value={references.current}>
			<Notice>{error}</Notice>
			<div onClickCapture={openPageLink} onAuxClickCapture={openPageLink}>
				<BlockNoteView editor={sync.editor} editable={editable} theme={theme} className={viewClass} slashMenu={false} sideMenu={false}>
					<SideMenuController sideMenu={(props) => <SideMenu {...props} dragHandleMenu={PageDragHandleMenu} />} />
					<SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems([
						// Uploads take pictures only, and the app loads no outside media: no video, audio or file blocks.
						...getDefaultReactSlashMenuItems(sync.editor).filter((item) => !(["video", "audio", "file"] as const).some((k) => item.title === sync.editor.dictionary.slash_menu[k].title)),
						...(standalone ? [{ title: "Page", subtext: "Add a page inside", aliases: ["page", "subpage"], group: "Pages", icon: <PageIcon />, onItemClick: async () => {
							try {
								const id = await create({ title: "Untitled", parentId: pageId, insertInParent: false });
								insertOrUpdateBlockForSlashMenu(sync.editor, { type: "page", props: { pageId: id, title: "Untitled" } });
								navigate("pages", id);
							} catch (e) { fail(e); }
						} }] : []),
					], query)} />
				</BlockNoteView>
			</div>
			<UpgradePageLinks editor={sync.editor} editable={editable} />
			<PageBlockRemoval editor={sync.editor} pageId={pageId} editable={editable} />
			{standalone && <ChildPages editor={sync.editor} pageId={pageId} editable={editable} />}
		</PageReferences.Provider>
	);
}

function PageDragHandleMenu() {
	const editor = useBlockNoteEditor(pageEditorSchema);
	const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
	return <DragHandleMenu>
		<RemoveBlockItem>{block?.type === "page" ? "Archive page" : "Delete block"}</RemoveBlockItem>
		{block?.type !== "page" && <BlockColorsItem>Colors</BlockColorsItem>}
		<TableRowHeaderItem>Header row</TableRowHeaderItem>
		<TableColumnHeaderItem>Header column</TableColumnHeaderItem>
	</DragHandleMenu>;
}

let schemaEditor: PageBlockEditor | undefined;

/** An old version's content (ProseMirror JSON), read-only. */
export function VersionPreview({ content }: { content: string }) {
	const editor = useMemo(() => {
		schemaEditor ??= BlockNoteEditor.create({ schema: pageEditorSchema, links });
		const doc = schemaEditor.pmSchema.nodeFromJSON(JSON.parse(content));
		return BlockNoteEditor.create({ schema: pageEditorSchema, links, initialContent: docToBlocks(doc) });
	}, [content]);
	return <div onClickCapture={openPageLink} onAuxClickCapture={openPageLink}><BlockNoteView editor={editor} editable={false} theme={theme} className={viewClass} /></div>;
}

/** Sidebar-created children appear here too; embedded links already have a place in the document. */
function ChildPages({ editor, pageId, editable }: { editor: PageBlockEditor; pageId: Id<"pages">; editable: boolean }) {
	const linked = useLinkedPages(editor);
	const placed = useRef(new Set<string>());
	for (const id of linked) placed.current.add(id);
	return <div className="flex flex-col gap-1"><PageLevel parentId={pageId} render={(p) => !placed.current.has(p._id) && <ChildPage key={p._id} editor={editor} pageId={p._id} title={p.title} editable={editable} />} /></div>;
}

/** Older children without document links become movable blocks on the next editable open. */
function ChildPage({ editor, pageId, title, editable }: { editor: PageBlockEditor; pageId: string; title: string; editable: boolean }) {
	useEffect(() => {
		if (!editable) return;
		let exists = false;
		editor.forEachBlock((block) => { if (block.type === "page" && block.props.pageId === pageId) exists = true; return true; });
		if (exists) return;
		const last = editor.document.at(-1)!;
		editor.insertBlocks([{ type: "page", props: { pageId, title } }], last, last.type === "paragraph" && last.content.length === 0 ? "before" : "after");
	}, [editor, pageId, title, editable]);
	return editable ? null : <PageBlockRow pageId={pageId} title={title} />;
}

/** Existing page links become blocks, including ones with text accidentally typed beside them. */
function UpgradePageLinks({ editor, editable }: { editor: PageBlockEditor; editable: boolean }) {
	useEffect(() => {
		if (!editable) return;
		const upgrade = () => {
			const updates: { id: string; blocks: Parameters<PageBlockEditor["replaceBlocks"]>[1] }[] = [];
			editor.forEachBlock((block) => {
				const blocks = promotePageLinks(block);
				if (blocks) updates.push({ id: block.id, blocks });
				return true;
			});
			for (const block of updates) editor.replaceBlocks([block.id], block.blocks);
		};
		upgrade();
		let timer: ReturnType<typeof setTimeout>;
		const unsubscribe = editor.onChange(() => { clearTimeout(timer); timer = setTimeout(upgrade, 300); });
		return () => { clearTimeout(timer); unsubscribe(); };
	}, [editor, editable]);
	return null;
}
