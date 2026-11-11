import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { BlockNoteEditor, createExtension, docToBlocks, filterSuggestionItems } from "@blocknote/core";
import { type DefaultSuggestionItem, SideMenuExtension, SuggestionMenu as SuggestionMenuExtension, getDefaultSlashMenuItems } from "@blocknote/core/extensions";
import "@blocknote/react/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BlockColorsItem, BlockNoteViewRaw, type BlockTypeSelectItem, ComponentsContext, type DefaultReactSuggestionItem, DragHandleMenu, ExtendButton, type ExtendButtonProps, FilePanelController, FormattingToolbar, FormattingToolbarController, GridSuggestionMenuController, LinkToolbarController, RemoveBlockItem, SideMenu, SideMenuController, SuggestionMenuController, TableCellButton, type TableCellButtonProps, TableColumnHeaderItem, TableHandle, type TableHandleProps, TableHandlesController, TableRowHeaderItem, blockTypeSelectItems, useBlockNoteEditor, useExtension, useExtensionState, usePortalElement } from "@blocknote/react";
import { linkedPageId, linkedRecordId, recordHref, validPageHref } from "@companybot/core/page-links";
import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useFetch, useHeldQuery, useMutation } from "../../convex";
import { openLink } from "../../desktop";
import { BulletListIcon, CaretDownIcon, ChannelIcon, CheckListIcon, CodeIcon, DividerIcon, DragHandleIcon, ImageIcon, NumberedListIcon, PageIcon, ParagraphIcon, PlusIcon, PrivateIcon, QuoteIcon, ReactIcon, RecordIcon, TableIcon, TextHFiveIcon, TextHFourIcon, TextHOneIcon, TextHSixIcon, TextHThreeIcon, TextHTwoIcon, ToggleListIcon } from "../../icons";
import { navigate } from "../../router";
import { type Level, type Worn, pickUp } from "../../sortable";
import { useUpload } from "../../upload";
import { EmptyState, Loading, Notice, recordTagButton, useRun } from "../../ui";
import { PageBlockRow, PageReferences, type PageReference, type PageBlockEditor, pageEditorSchema } from "./PageBlock";
import { Avatar, PopoverPanel } from "../chat/common";
import { type Participant, type TokenNames, useDirectory } from "../chat/data";
import { ProfileCards } from "../chat/Profile";
import { matches } from "../chat/editor";
import { COMPLETED_SHORTCODE, EMOJI_COLUMNS, emojiForShortcode, loadEmoji, loadedEmoji, menuEmoji, rememberEmoji, savedTone, withTone } from "../chat/emoji";
import { splitTokens } from "../chat/tokens";
import { EmojiMenu, type EmojiPick, HandleButton, components } from "./editorComponents";
import { promotePageLinks } from "./pageBlockUpgrades";
import { PageBlockRemoval } from "./PageBlockRemoval";

// A page's content: BlockNote, synced live through prosemirror-sync (backend pageSync.ts).
// The sync calls name only the page; the backend finds its workspace. See wiki/pages.md.
// BlockNote's menus and toolbars are the app's own (editorComponents.tsx); its block CSS is the one import above,
// styled in styles.css (`.page-editor`).

/** BlockNote pads the left for its block handles: pull it back so text lines up with the title. */
const viewClass = "page-editor -mx-[54px]";
/**
 * Where the editor's floating UI stacks: over the sticky top bar (z-30), so a menu opened from it isn't drawn
 * under the bar, and under the app's dialogs and popovers (z-50). The + and ⋮⋮ lowest, so the toolbar over a
 * selection is never under the hovered block's handles; menus and panels on top. BlockNote's table handles take
 * no option for it and keep its own (10): they sit on the table, under everything here.
 */
const layer = { handles: 40, toolbars: 41, menus: 42 };
const floating = (zIndex: number) => ({ elementProps: { style: { zIndex } } });
const links = {
	isValidLink: validPageHref,
	// BlockNote's default opens every link with window.open, page links too; those navigate in openPageLink instead.
	onClick: (event: globalThis.MouseEvent) => {
		const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
		if (anchor && !linkedPageId(anchor.getAttribute("href") ?? "")) openLink(anchor.href);
		return true;
	},
};
/**
 * What the blocks wear while one is dragged (sortable.ts `pickUp`: the lift, the slide, the lifted block's
 * transform), as decorations. Set on a block's element directly, ProseMirror reads the change back and draws
 * the block again, bare; BlockNote's drop cursor marks its block the same way.
 */
/** How far in a block's children start (BlockNote's `.bn-block-group .bn-block-group` margin). */
const INDENT = 24;
const wornKey = new PluginKey<Map<string, Worn>>("blockDrag");
const blockDrag = createExtension({
	key: "blockDrag",
	prosemirrorPlugins: [new Plugin({
		key: wornKey,
		state: { init: () => new Map<string, Worn>(), apply: (tr, prev) => tr.getMeta(wornKey) ?? prev },
		props: {
			decorations(state) {
				const worn = wornKey.getState(state);
				if (!worn?.size) return DecorationSet.empty;
				const decorations: Decoration[] = [];
				state.doc.descendants((node, pos) => {
					const w = worn.get(node.attrs.id);
					if (w) decorations.push(Decoration.node(pos, pos + node.nodeSize, w));
				});
				return DecorationSet.create(state.doc, decorations);
			},
		},
	})],
});
/** The schema, links and drag of every page editor, and `page-editor` on the editor element itself (styles.css). */
/**
 * @people, @agents and #channels in a page, as chips (`.token`, as in chat): plain text, as chat stores them, so
 * an agent reads a page as it reads a message and nothing is kept per mention; a name that matches the directory
 * (`mentionsKey`, set from `useDirectory`) is decorated where it stands (`splitTokens`). A click on a chip does what
 * it does in chat (`onChip`: a person's card, a channel opens). Records are links (`recordHref`), drawn as chat's record chip
 * (`recordTagButton`, the record icon before the name: `.record-chip` in styles.css) and opened like page links (`openLink`).
 */
type Mentions = { tokens: TokenNames; onChip: (kind: string, id: string, chip: HTMLElement) => void };
const mentionsKey = new PluginKey<Mentions>("mentions");
const noMentions: Mentions = { tokens: { people: [], channels: [], skills: [] }, onChip: () => {} };
const mentions = createExtension({
	key: "mentions",
	prosemirrorPlugins: [new Plugin({
		key: mentionsKey,
		state: { init: () => noMentions, apply: (tr, prev) => tr.getMeta(mentionsKey) ?? prev },
		props: {
			decorations(state) {
				const { tokens } = mentionsKey.getState(state) ?? noMentions;
				const found: Decoration[] = [];
				state.doc.descendants((node, pos) => {
					if (!node.isText || !node.text) return;
					if (node.marks.some((m) => m.type.name === "link" && linkedRecordId(m.attrs.href))) {
						found.push(Decoration.inline(pos, pos + node.text.length, { class: `record-chip ${recordTagButton}`, "data-kind": "record" }));
						return;
					}
					let at = pos;
					for (const part of splitTokens(node.text, tokens)) {
						const length = typeof part === "string" ? part.length : part.text.length;
						if (typeof part !== "string") found.push(Decoration.inline(at, at + length, { class: "token", "data-kind": part.kind, "data-id": String(part.ref.id) }));
						at += length;
					}
				});
				return DecorationSet.create(state.doc, found);
			},
			handleClick(view, _pos, event) {
				const chip = event.target instanceof Element ? event.target.closest<HTMLElement>(".token[data-kind]") : null;
				if (!chip?.dataset.kind || !chip.dataset.id) return false;
				(mentionsKey.getState(view.state) ?? noMentions).onChip(chip.dataset.kind, chip.dataset.id, chip);
				return true;
			},
		},
	})],
});

/** A typed `:smile:` becomes 😄, as in chat, once the emoji data is loaded (opening the `:` menu loads it). */
const emojiShortcodes = createExtension({
	key: "emojiShortcodes",
	prosemirrorPlugins: [new Plugin({
		props: {
			handleTextInput(view, from, to, text) {
				if (text !== ":") return false;
				const $from = view.state.doc.resolve(from);
				const match = COMPLETED_SHORTCODE.exec(`${$from.parent.textBetween(0, $from.parentOffset)}:`);
				const index = loadedEmoji();
				const emoji = match && index && emojiForShortcode(index, match[1]!);
				if (!emoji) return false;
				view.dispatch(view.state.tr.insertText(emoji.char, from - match[1]!.length - 1, to));
				return true;
			},
		},
	})],
});

// Tab and Shift+Tab never leave the editor. BlockNote hands them to the browser when it can't nest or un-nest the
// block (the first block, or one as deep as it goes) or when the formatting toolbar is open, so focus jumped to the next button.
// With a menu open, Tab takes the lit item, as Enter does (and as in chat).
const tabStays = createExtension({
	key: "tabStays",
	keyboardShortcuts: {
		Tab: ({ editor }) => {
			if (editor.getExtension(SuggestionMenuExtension)?.shown()) editor.domElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			else editor.nestBlock();
			return true;
		},
		"Shift-Tab": ({ editor }) => {
			editor.unnestBlock();
			return true;
		},
	},
});

const editorOptions = { schema: pageEditorSchema, links, domAttributes: { editor: { class: "page-editor" } }, extensions: [blockDrag, tabStays, mentions, emojiShortcodes] };

/** The editor in the app's chrome. Its floating UI is the children (PageEditor, stacked by `layer`); BlockNote's own is off. */
function View({ editor, editable, children }: { editor: PageBlockEditor; editable: boolean; children?: ReactNode }) {
	const fetch = useFetch();
	// The record icon for record chips (`.record-chip::before`), as CSS: the chip is a decoration on the link's text, not React.
	const icon = useRef<HTMLSpanElement>(null);
	const [recordIcon, setRecordIcon] = useState("");
	useEffect(() => { setRecordIcon(`url("data:image/svg+xml,${encodeURIComponent(icon.current?.innerHTML ?? "")}")`); }, []);
	// A page or record link opens in the app: captured before BlockNote opens a window; also in read-only version previews.
	const openLink = (event: MouseEvent<HTMLDivElement>) => {
		if (event.button !== 0 && event.button !== 1) return;
		const href = (event.target instanceof Element ? event.target.closest("a[href]") : null)?.getAttribute("href") ?? "";
		const page = linkedPageId(href);
		const record = linkedRecordId(href);
		if (!page && !record) return;
		event.preventDefault();
		event.stopPropagation();
		if (page) navigate("pages", page);
		else fetch(api.records.titles, { recordIds: [record as Id<"records">] }).then(([r]) => r && navigate("records", r.typeKey, r._id));
	};
	return (
		<div onClickCapture={openLink} onAuxClickCapture={openLink} style={{ "--record-icon": recordIcon } as CSSProperties}>
			<span ref={icon} hidden><RecordIcon /></span>
			<ComponentsContext.Provider value={components}>
				<BlockNoteViewRaw editor={editor} editable={editable} theme="light" className={viewClass} formattingToolbar={false} linkToolbar={false} slashMenu={false} emojiPicker={false} sideMenu={false} filePanel={false} tableHandles={false}>
					{children}
				</BlockNoteViewRaw>
			</ComponentsContext.Provider>
		</div>
	);
}

/** A page's body, the same for every page, a record's too: sub-pages (`/page`) and all. */
export function PageEditor({ pageId, editable, focusKey = 0 }: { pageId: Id<"pages">; editable: boolean; focusKey?: number }) {
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
	const sync = useBlockNoteSync<PageBlockEditor>(api.pageSync, pageId, { editorOptions: { ...editorOptions, uploadFile: (file) => uploadImage.current!(file) }, onSyncError: syncFailed });
	// Enter in the title puts the cursor on the first line of text; with none (a body of pages, tables or
	// pictures only) it makes a line at the top to type on, rather than selecting a block.
	useEffect(() => {
		const editor = sync.editor;
		if (!focusKey || !editable || !editor) return;
		const text = editor.document.find((block) => Array.isArray(block.content));
		const body = text ?? editor.insertBlocks([{ type: "paragraph" }], editor.document[0]!, "before")[0]!;
		editor.setTextCursorPosition(body, "start");
		editor.focus();
	}, [sync.editor, editable, focusKey]);
	const sideMenuFloating = useSideMenuFloating(sync.editor);
	const directory = useDirectory();
	const fetch = useFetch();
	// The names the chips match, handed to the editor when they change (the directory is rebuilt every render).
	const names = JSON.stringify([directory.tokens.people, directory.tokens.channels]);
	const latest = useRef(directory.tokens);
	latest.current = directory.tokens;
	// A person's chip opens their card under it, as in chat.
	const [card, setCard] = useState<{ who: Participant; at: { x: number; y: number } }>();
	useEffect(() => {
		const onChip: Mentions["onChip"] = (kind, id, chip) => {
			if (kind === "channel") navigate("chat", id);
			const who = latest.current.people.find((p) => String(p.id) === id);
			const box = chip.getBoundingClientRect();
			if (kind === "person" && who) setCard({ who, at: { x: box.left, y: box.bottom } });
		};
		const tokens: TokenNames = { people: latest.current.people, channels: latest.current.channels, skills: [] };
		sync.editor?.transact((tr) => { tr.setMeta(mentionsKey, { tokens, onChip } satisfies Mentions); });
	}, [sync.editor, names]);
	if (sync.isLoading) return <Loading />;
	if (!sync.editor || gone) return <EmptyState icon={<PageIcon />} title="Page unavailable">Try opening this page again.</EmptyState>;
	return (
		<PageReferences.Provider value={references.current}>
			<Notice>{error}</Notice>
			<View editor={sync.editor} editable={editable}>
				<SideMenuController sideMenu={PageSideMenu} floatingUIOptions={sideMenuFloating} />
				<FormattingToolbarController formattingToolbar={PageFormattingToolbar} floatingUIOptions={floating(layer.toolbars)} />
				<LinkToolbarController floatingUIOptions={floating(layer.toolbars)} />
				{/* Blocks don't go in table cells, so no slash menu there (BlockNote's own rule). */}
				<SuggestionMenuController triggerCharacter="/" floatingUIOptions={floating(layer.menus)} shouldOpen={(state) => !state.selection.$from.parent.type.isInGroup("tableContent")} getItems={async (query) => filterSuggestionItems([
					...slashItems(sync.editor),
					{ title: "Page", subtext: "Add a page inside", aliases: ["page", "subpage"], group: "Pages", icon: <PageIcon />, onItemClick: async () => {
						try {
							// The server adds the child's block (at the end, with the page itself, so there's never a child without
							// one); once it's here, it moves to where the cursor was: into its empty block, else after it.
							const at = sync.editor.getTextCursorPosition().block;
							const id = await create({ title: "Untitled", parentId: pageId });
							const block = await pageBlockFor(sync.editor, id);
							const cursor = sync.editor.getBlock(at.id);
							if (block && cursor && cursor.id !== block.id) sync.editor.transact(() => {
								sync.editor.removeBlocks([block.id]);
								if (cursor.type === "paragraph" && Array.isArray(cursor.content) && cursor.content.length === 0) sync.editor.replaceBlocks([cursor.id], [block]);
								else sync.editor.insertBlocks([block], cursor.id, "after");
							});
							navigate("pages", id);
						} catch (e) { fail(e); }
					} },
				], query)} />
				<SuggestionMenuController triggerCharacter="@" shouldOpen={atWordStart} floatingUIOptions={floating(layer.menus)} getItems={(query) => mentionItems(sync.editor, directory, query, fetch)} />
				<SuggestionMenuController triggerCharacter="#" shouldOpen={atWordStart} floatingUIOptions={floating(layer.menus)} getItems={async (query) => channelItems(sync.editor, directory, query)} />
				<GridSuggestionMenuController<typeof emojiQuery> triggerCharacter=":" columns={EMOJI_COLUMNS} minQueryLength={0} shouldOpen={atWordStart} floatingUIOptions={floating(layer.menus)} getItems={emojiQuery} gridSuggestionMenuComponent={EmojiMenu} onItemClick={(item) => pickEmoji(sync.editor, item)} />
				<FilePanelController floatingUIOptions={floating(layer.menus)} />
				<TableHandlesController tableHandle={PageTableHandle} extendButton={PageExtendButton} tableCellHandle={PageTableCellButton} />
			</View>
			{card && (
				<PopoverPanel opened at={card.at} onClose={() => setCard(undefined)}>
					<ProfileCards who={card.who} onClose={() => setCard(undefined)} />
				</PopoverPanel>
			)}
			<UpgradePageLinks editor={sync.editor} editable={editable} />
			<PageBlockRemoval editor={sync.editor} pageId={pageId} editable={editable} />
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

/**
 * BlockNote's toolbar; its block type picker gets the app's icons here, its buttons theirs in editorComponents.tsx.
 * Both come with fixed ones (react-icons).
 */
function PageFormattingToolbar() {
	const editor = useBlockNoteEditor(pageEditorSchema);
	const items = useMemo(() => blockTypeSelectItems(editor).map((item) => ({ ...item, icon: typeIcon(item) })), [editor]);
	return <FormattingToolbar blockTypeSelectItems={items} />;
}
/** The `:` menu is the emoji panel (EmojiMenu), driven by the typed query: its items are the panel's tiles (`menuEmoji`); a click, or Enter on the lit one, is the emoji in the text. */
async function emojiQuery(query: string): Promise<EmojiPick[]> {
	const index = await loadEmoji();
	const tone = savedTone(localStorage);
	return menuEmoji(index, query, localStorage).map((e) => ({ query, char: withTone(e, tone) }));
}
function pickEmoji(editor: PageBlockEditor, { char }: EmojiPick) {
	rememberEmoji(localStorage, char);
	editor.insertInlineContent(`${char} `);
}

/** A menu's trigger counts at the start of a word only: "ada@x.co" and "10:30" open nothing. */
const atWordStart = (state: { selection: { $from: { parent: { textBetween: (from: number, to: number) => string }; parentOffset: number } } }) => {
	const { $from } = state.selection;
	return /(^|\s)$/.test($from.parent.textBetween(0, $from.parentOffset));
};

type Directory = ReturnType<typeof useDirectory>;
/** The `@` menu: people and agents by name, then records found by title (a search, so two letters first). */
async function mentionItems(editor: PageBlockEditor, directory: Directory, query: string, fetch: ReturnType<typeof useFetch>): Promise<DefaultReactSuggestionItem[]> {
	const who = [...directory.people, ...directory.agents].filter((p) => matches(p.name, query)).slice(0, 8).map((p): DefaultReactSuggestionItem => ({
		title: p.name, group: p.type === "agent" ? "Agents" : "People", size: "small", icon: <Avatar name={p.name} image={p.image} agent={p.type === "agent"} size="sm" />, onItemClick: () => editor.insertInlineContent(`@${p.name} `),
	}));
	const records = query.trim().length >= 2 ? await fetch(api.records.search, { query }) : [];
	return [...who, ...records.slice(0, 8).map((r): DefaultReactSuggestionItem => ({
		title: r.title || "Untitled", group: "Records", size: "small", icon: <RecordIcon />, onItemClick: () => editor.insertInlineContent([{ type: "link", href: recordHref(r._id), content: r.title || "Untitled" }, " "]),
	}))];
}
/** The `#` menu: channels by name, joined or not. */
const channelItems = (editor: PageBlockEditor, directory: Directory, query: string): DefaultReactSuggestionItem[] =>
	directory.channels.filter((c) => matches(c.name, query)).slice(0, 8).map((c) => ({
		title: `#${c.name}`, subtext: c.topic ?? undefined, group: "Channels", size: "small", icon: c.private ? <PrivateIcon /> : <ChannelIcon />, onItemClick: () => editor.insertInlineContent(`#${c.name} `),
	}));

const typeIcons: Record<string, typeof PageIcon> = { paragraph: ParagraphIcon, quote: QuoteIcon, bulletListItem: BulletListIcon, numberedListItem: NumberedListIcon, checkListItem: CheckListIcon, toggleListItem: ToggleListIcon, codeBlock: CodeIcon };
const headingIcons = [TextHOneIcon, TextHTwoIcon, TextHThreeIcon, TextHFourIcon, TextHFiveIcon, TextHSixIcon];
function typeIcon(item: BlockTypeSelectItem): BlockTypeSelectItem["icon"] {
	const Icon = (item.type === "heading" ? headingIcons[Number(item.props?.level ?? 1) - 1] : typeIcons[item.type]) ?? ParagraphIcon;
	return (props) => <Icon {...props} />;
}

/**
 * The + and ⋮⋮ on the hovered block's first line, whatever the block: the line box of its first text (a
 * heading's, a wrapped list item's, a table's first cell's, a page block's title), else a line's worth at its
 * top (an image, a divider). BlockNote's own offsets assume its heading sizes (3em, 2em…), not the app's.
 */
function useSideMenuFloating(editor: PageBlockEditor | null) {
	return useMemo(() => ({
		...floating(layer.handles),
		useFloatingOptions: {
			middleware: [{
				name: "first-line",
				fn: ({ x, y, rects, elements }: { x: number; y: number; rects: { floating: { height: number } }; elements: { reference: { getBoundingClientRect: () => { top: number } } } }) => {
					const id = editor?.getExtension(SideMenuExtension)?.store?.state?.block?.id;
					const content = id ? editor?.domElement?.querySelector<HTMLElement>(`[data-id="${id}"] .bn-block-content`) : undefined;
					if (!content) return { x, y };
					const line = firstLine(content);
					return { x, y: y + line.top - elements.reference.getBoundingClientRect().top + line.height / 2 - rects.floating.height / 2 };
				},
			}],
		},
	}), [editor]);
}

/**
 * A block's first line: the box of its first text or line break, else a line's height under its top padding. A
 * file's caption sits under the file, so it isn't the block's first line; the menu goes at the top of the picture.
 */
function firstLine(content: HTMLElement) {
	const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			if (node instanceof Element && node.classList.contains("bn-file-caption")) return NodeFilter.FILTER_REJECT;
			return (node instanceof Text ? node.data.trim() !== "" : node instanceof HTMLBRElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});
	const first = walker.nextNode();
	if (first) {
		const range = document.createRange();
		if (first instanceof Text) {
			range.setStart(first, 0);
			range.setEnd(first, 1);
		} else range.selectNode(first);
		const rect = range.getClientRects()[0];
		if (rect?.height) return rect;
	}
	const top = content.getBoundingClientRect().top + parseFloat(getComputedStyle(content).paddingTop);
	return { top, height: parseFloat(getComputedStyle(content.firstElementChild ?? content).lineHeight) || 0 };
}

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

/**
 * Drags the block with the app's drag (sortable.ts `pickUp`), as a sidebar row: it follows the pointer up and down
 * while the others slide out of its way, steps right to go in under the block above it and left to come out (as in
 * Notion), and glides into its gap when let go; then the block moves there (one step, so one undo). Not the browser's
 * drag-and-drop, which BlockNote uses: that drags a picture of the block glued to the pointer and drops only on an
 * exact line. A click opens its menu, which holds the side menu in place while open.
 */
function DragHandle() {
	const editor = useBlockNoteEditor(pageEditorSchema);
	const sideMenu = useExtension(SideMenuExtension);
	const block = useExtensionState(SideMenuExtension, { editor, selector: (state) => state?.block });
	const portalElement = usePortalElement();
	if (!block) return null;
	const pick = (e: React.PointerEvent) => {
		const root = editor.domElement;
		if (!root) return;
		// Every visible level: the top, and each block's children (none yet for most); a closed toggle keeps its hidden ones.
		const levels: Level[] = [];
		const outers = [...root.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")].filter((el) => el.getClientRects().length);
		const rowsOf = (group: Element | null | undefined) => new Map([...(group?.children ?? [])].flatMap((el) => (el instanceof HTMLElement && el.dataset.id && el.getClientRects().length ? [[el.dataset.id, el] as const] : [])));
		levels.push({ rows: rowsOf(root.querySelector(":scope > .bn-block-group")) });
		for (const outer of outers) {
			if (outer.querySelector(".bn-toggle-button[aria-expanded='false']")?.closest(".bn-block-outer") === outer) continue;
			const group = [...outer.querySelectorAll(".bn-block-group")].find((g) => g.parentElement?.closest(".bn-block-outer") === outer);
			levels.push({ parent: outer.dataset.id, rows: rowsOf(group) });
		}
		const paint = (worn: Map<string, Worn>) => editor.transact((tr) => { tr.setMeta(wornKey, worn); });
		pickUp(e, block.id, levels, (parent, index) => {
			const level = levels.find((l) => l.parent === parent);
			const moved = editor.getBlock(block.id);
			if (!level || !moved) return;
			const ids = [...level.rows.keys()];
			const rest = ids.filter((id) => id !== block.id);
			if (ids.indexOf(block.id) === index) return;
			editor.transact(() => {
				editor.removeBlocks([block.id]);
				if (index < rest.length) editor.insertBlocks([moved], rest[index]!, "before");
				else if (rest.length) editor.insertBlocks([moved], rest[rest.length - 1]!, "after");
				else if (parent) editor.updateBlock(parent, { children: [moved] });
			});
		}, paint, INDENT);
	};
	return (
		<MenuRoot onOpenChange={(open) => (open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu())} position="left" portalElement={portalElement}>
			<MenuTrigger>
				<HandleButton label={editor.dictionary.side_menu.drag_handle_label} icon={<DragHandleIcon weight="bold" />} onPointerDown={pick} />
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
const PageTableHandle = (props: TableHandleProps) => <TableHandle {...props}><DragHandleIcon weight="bold" /></TableHandle>;
const PageExtendButton = (props: ExtendButtonProps) => <ExtendButton {...props}><PlusIcon /></ExtendButton>;
const PageTableCellButton = (props: TableCellButtonProps) => <TableCellButton {...props}><CaretDownIcon /></TableCellButton>;

let schemaEditor: PageBlockEditor | undefined;

/** An old version's content (ProseMirror JSON), read-only. */
export function VersionPreview({ content }: { content: string }) {
	const editor = useMemo(() => {
		schemaEditor ??= BlockNoteEditor.create(editorOptions);
		const doc = schemaEditor.pmSchema.nodeFromJSON(JSON.parse(content));
		return BlockNoteEditor.create({ ...editorOptions, initialContent: docToBlocks(doc) });
	}, [content]);
	return <View editor={editor} editable={false} />;
}

/** The block for a child page once the server's insert of it has synced here (a few seconds at most), else nothing. */
function pageBlockFor(editor: PageBlockEditor, pageId: string) {
	const find = () => {
		let found: ReturnType<PageBlockEditor["getBlock"]>;
		editor.forEachBlock((block) => { if (block.type === "page" && block.props.pageId === pageId) found = block; return !found; });
		return found;
	};
	return new Promise<ReturnType<typeof find>>((resolve) => {
		const now = find();
		if (now) return resolve(now);
		const done = (block: ReturnType<typeof find>) => { clearTimeout(timer); unsubscribe(); resolve(block); };
		const unsubscribe = editor.onChange(() => { const block = find(); if (block) done(block); });
		const timer = setTimeout(() => done(undefined), 4000);
	});
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

/**
 * Plain instructions (an agent's) edited in the page editor: Markdown in, Markdown out. Not synced like a
 * page: it loads `markdown` once and reports each change, and the caller saves it. No pictures or sub-pages.
 */
export function MarkdownEditor({ markdown, editable, onChange, label }: { markdown: string; editable: boolean; onChange: (markdown: string) => void; label: string }) {
	const editor = useMemo(() => BlockNoteEditor.create(editorOptions) as PageBlockEditor, []);
	const latest = useRef(onChange);
	latest.current = onChange;
	const [ready, setReady] = useState(false);
	useEffect(() => {
		// Loaded once: later saves come from here, so reloading would move the cursor under the typist.
		const blocks = editor.tryParseMarkdownToBlocks(markdown);
		editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: "paragraph" }]);
		setReady(true);
		// Subscribed after loading, so the load itself isn't reported as an edit.
		return editor.onChange(() => latest.current(editor.blocksToMarkdownLossy(editor.document).trim()));
	}, [editor]);
	const sideMenuFloating = useSideMenuFloating(editor);
	if (!ready) return <Loading />;
	return (
		<div aria-label={label} className="pl-6">
			<View editor={editor} editable={editable}>
				<SideMenuController sideMenu={PageSideMenu} floatingUIOptions={sideMenuFloating} />
				<FormattingToolbarController formattingToolbar={PageFormattingToolbar} floatingUIOptions={floating(layer.toolbars)} />
				<LinkToolbarController floatingUIOptions={floating(layer.toolbars)} />
				<SuggestionMenuController triggerCharacter="/" floatingUIOptions={floating(layer.menus)} getItems={async (query) => filterSuggestionItems(slashItems(editor).filter((item) => item.title !== "Image" && item.title !== "Table"), query)} />
			</View>
		</div>
	);
}
