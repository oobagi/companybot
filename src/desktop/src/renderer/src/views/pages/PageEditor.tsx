import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { BlockNoteEditor, docToBlocks, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { type DefaultSuggestionItem, SideMenuExtension, SuggestionMenu as SuggestionMenuExtension, getDefaultSlashMenuItems } from "@blocknote/core/extensions";
import "@blocknote/react/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { BlockColorsItem, BlockNoteViewRaw, ComponentsContext, type DefaultReactSuggestionItem, DragHandleMenu, ExtendButton, type ExtendButtonProps, RemoveBlockItem, SideMenu, SideMenuController, SuggestionMenuController, TableCellButton, type TableCellButtonProps, TableColumnHeaderItem, TableHandle, type TableHandleProps, TableHandlesController, TableRowHeaderItem, useBlockNoteEditor, useExtension, useExtensionState, usePortalElement } from "@blocknote/react";
import { linkedPageId, validPageHref } from "@companybot/core/page-links";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useHeldQuery, useMutation } from "../../convex";
import { BulletListIcon, CaretDownIcon, CheckListIcon, CodeIcon, DividerIcon, DragHandleIcon, ImageIcon, NumberedListIcon, PageIcon, ParagraphIcon, PlusIcon, QuoteIcon, ReactIcon, TableIcon, TextHFiveIcon, TextHFourIcon, TextHOneIcon, TextHSixIcon, TextHThreeIcon, TextHTwoIcon, ToggleListIcon } from "../../icons";
import { navigate } from "../../router";
import { useUpload } from "../../upload";
import { EmptyState, Loading, Notice, useRun } from "../../ui";
import { useLinkedPages } from "./useLinkedPages";
import { PageLevel } from "./PageTree";
import { PageBlockRow, PageReferences, type PageReference, type PageBlockEditor, pageEditorSchema } from "./PageBlock";
import { components } from "./editorComponents";
import { promotePageLinks } from "./pageBlockUpgrades";
import { PageBlockRemoval } from "./PageBlockRemoval";

// A page's content: BlockNote, synced live through prosemirror-sync (backend pageSync.ts).
// The sync calls name only the page; the backend finds its workspace. See wiki/pages.md.
// BlockNote's menus and toolbars are the app's own (editorComponents.tsx); its block CSS is the one import above.

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

/** The editor in the app's chrome. The side menu, slash menu and table handles are the children; BlockNote's own are off. */
function View({ editor, editable, children }: { editor: PageBlockEditor; editable: boolean; children?: ReactNode }) {
	return (
		<div onClickCapture={openPageLink} onAuxClickCapture={openPageLink}>
			<ComponentsContext.Provider value={components}>
				<BlockNoteViewRaw editor={editor} editable={editable} theme="light" className={viewClass} slashMenu={false} sideMenu={false} tableHandles={false}>
					{children}
				</BlockNoteViewRaw>
			</ComponentsContext.Provider>
		</div>
	);
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
	// Deleted, or access taken away while open: the server's latest version reads null, and sync says the
	// page doesn't exist. Say it's unavailable instead of showing that as an error.
	const [gone, setGone] = useState(false);
	const syncFailed = (e: Error) => (/doesn't exist server-side/.test(e.message) ? setGone(true) : fail(e));
	// The body loads through prosemirror-sync's own query hook, outside the app's query cache (convex.ts). Held here
	// too, the snapshot stays live a minute after leaving (main.tsx), so coming back to a page doesn't load again.
	useHeldQuery(api.pageSync.getSnapshot, { id: pageId });
	const sync = useBlockNoteSync<PageBlockEditor>(api.pageSync, pageId, { editorOptions: { schema: pageEditorSchema, links, uploadFile: (file) => uploadImage.current!(file) }, onSyncError: syncFailed });
	useEffect(() => {
		if (focusKey && editable && sync.editor) {
			const body = sync.editor.document.find((block) => Array.isArray(block.content)) ?? sync.editor.document.at(-1)!;
			sync.editor.setTextCursorPosition(body, "start");
			sync.editor.focus();
		}
	}, [sync.editor, editable, focusKey]);
	if (sync.isLoading) return <Loading />;
	if (!sync.editor || gone) return <EmptyState icon={<PageIcon />} title="Page unavailable">Try opening this page again.</EmptyState>;
	return (
		<PageReferences.Provider value={references.current}>
			<Notice>{error}</Notice>
			<View editor={sync.editor} editable={editable}>
				{/* Over the sticky top bar (z-30), so the drag handle's menu isn't drawn under it; BlockNote puts its toolbar there too. */}
				<SideMenuController sideMenu={PageSideMenu} floatingUIOptions={sideMenuFloating} />
				<SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems([
					...slashItems(sync.editor),
					...(standalone ? [{ title: "Page", subtext: "Add a page inside", aliases: ["page", "subpage"], group: "Pages", icon: <PageIcon />, onItemClick: async () => {
						try {
							const id = await create({ title: "Untitled", parentId: pageId, insertInParent: false });
							insertOrUpdateBlockForSlashMenu(sync.editor, { type: "page", props: { pageId: id } });
							navigate("pages", id);
						} catch (e) { fail(e); }
					} }] : []),
				], query)} />
				<TableHandlesController tableHandle={PageTableHandle} extendButton={PageExtendButton} tableCellHandle={PageTableCellButton} />
			</View>
			<UpgradePageLinks editor={sync.editor} editable={editable} />
			<PageBlockRemoval editor={sync.editor} pageId={pageId} editable={editable} />
			{standalone && <ChildPages editor={sync.editor} pageId={pageId} />}
		</PageReferences.Provider>
	);
}

/** BlockNote's slash menu items with the app's icons. Uploads take pictures only, and the app loads no outside media: no video, audio or file blocks. */
const slashIcons: Partial<Record<DefaultSuggestionItem["key"], typeof PageIcon>> = {
	heading: TextHOneIcon, heading_2: TextHTwoIcon, heading_3: TextHThreeIcon, heading_4: TextHFourIcon, heading_5: TextHFiveIcon, heading_6: TextHSixIcon,
	toggle_heading: TextHOneIcon, toggle_heading_2: TextHTwoIcon, toggle_heading_3: TextHThreeIcon,
	paragraph: ParagraphIcon, quote: QuoteIcon, bullet_list: BulletListIcon, numbered_list: NumberedListIcon, check_list: CheckListIcon, toggle_list: ToggleListIcon,
	table: TableIcon, image: ImageIcon, code_block: CodeIcon, divider: DividerIcon, emoji: ReactIcon,
};
const hiddenBlocks = new Set<DefaultSuggestionItem["key"]>(["video", "audio", "file"]);
function slashItems(editor: PageBlockEditor): DefaultReactSuggestionItem[] {
	return getDefaultSlashMenuItems(editor).filter((item) => !hiddenBlocks.has(item.key)).map((item) => {
		const Icon = slashIcons[item.key];
		return { ...item, icon: Icon ? <Icon /> : undefined };
	});
}

const sideMenuFloating = { elementProps: { style: { zIndex: 40 } } };

/** The + and ⋮⋮ beside the hovered block, with the app's icons (BlockNote's own buttons carry fixed ones). */
function PageSideMenu() {
	return <SideMenu><AddBlock /><DragHandle /></SideMenu>;
}

const SideButton = components.SideMenu.Button;
const { Root: MenuRoot, Trigger: MenuTrigger } = components.Generic.Menu;

/** Opens the slash menu in the block, or in a new one after it when it has text. */
function AddBlock() {
	const editor = useBlockNoteEditor(pageEditorSchema);
	const suggestionMenu = useExtension(SuggestionMenuExtension);
	const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
	if (!block) return null;
	const onClick = () => {
		const empty = Array.isArray(block.content) && block.content.length === 0;
		editor.setTextCursorPosition(empty ? block : editor.insertBlocks([{ type: "paragraph" }], block, "after")[0]!);
		suggestionMenu.openSuggestionMenu("/");
	};
	return <SideButton label={editor.dictionary.side_menu.add_block_label} icon={<PlusIcon />} onClick={onClick} />;
}

/** Drags the block; a click opens its menu, which holds the side menu in place while open. */
function DragHandle() {
	const editor = useBlockNoteEditor(pageEditorSchema);
	const sideMenu = useExtension(SideMenuExtension);
	const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
	const portalElement = usePortalElement();
	if (!block) return null;
	return (
		<MenuRoot onOpenChange={(open) => (open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu())} position="left" portalElement={portalElement}>
			<MenuTrigger>
				<SideButton label={editor.dictionary.side_menu.drag_handle_label} icon={<DragHandleIcon />} draggable onDragStart={(e) => sideMenu.blockDragStart(e, block)} onDragEnd={sideMenu.blockDragEnd} />
			</MenuTrigger>
			<PageDragHandleMenu />
		</MenuRoot>
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

/** BlockNote's table handles, with the app's icons. */
const PageTableHandle = (props: TableHandleProps) => <TableHandle {...props}><DragHandleIcon /></TableHandle>;
const PageExtendButton = (props: ExtendButtonProps) => <ExtendButton {...props}><PlusIcon /></ExtendButton>;
const PageTableCellButton = (props: TableCellButtonProps) => <TableCellButton {...props}><CaretDownIcon /></TableCellButton>;

let schemaEditor: PageBlockEditor | undefined;

/** An old version's content (ProseMirror JSON), read-only. */
export function VersionPreview({ content }: { content: string }) {
	const editor = useMemo(() => {
		schemaEditor ??= BlockNoteEditor.create({ schema: pageEditorSchema, links });
		const doc = schemaEditor.pmSchema.nodeFromJSON(JSON.parse(content));
		return BlockNoteEditor.create({ schema: pageEditorSchema, links, initialContent: docToBlocks(doc) });
	}, [content]);
	return <View editor={editor} editable={false} />;
}

/**
 * Children without a block in this document (one the server is adding right now) show as rows. The server is
 * the only one that adds sub-page blocks (pageOps `appendPageBlock`): two writers raced and doubled them.
 */
function ChildPages({ editor, pageId }: { editor: PageBlockEditor; pageId: Id<"pages"> }) {
	const linked = useLinkedPages(editor);
	const placed = useRef(new Set<string>());
	for (const id of linked) placed.current.add(id);
	return <div className="flex flex-col gap-1"><PageLevel parentId={pageId} render={(p) => !placed.current.has(p._id) && <PageBlockRow key={p._id} pageId={p._id} />} /></div>;
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
