import { BlockNoteViewRaw, type ComponentProps, type Components, elementOverflow, preventFocusOnTap, useAutoFocus, useDictionary, useMergeRefs } from "@blocknote/react";
import { Menu as MantineMenu, Popover as MantinePopover } from "@mantine/core";
import { type Ref, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlignCenterIcon, AlignJustifyIcon, AlignLeftIcon, AlignRightIcon, BoldIcon, CaptionIcon, CaretDownIcon, CaretRightIcon, CheckIcon, CodeIcon, DownloadIcon, EditIcon, IndentIcon, ItalicIcon, LinkIcon, MergeCellsIcon, OpenOutsideIcon, OutdentIcon, ReplaceIcon, ShowIcon, StrikethroughIcon, TrashIcon, UnderlineIcon, UnlinkIcon, UploadIcon } from "../../icons";
import { Tabs, barButton, compactButton, compactControlClass, compactPrimaryButton, iconButton, pillLinkButton, smallIconButton, useTip, versionRowButton } from "../../ui";

/**
 * BlockNote's UI, drawn with the app's own looks (ui.tsx, views/chat/common.tsx): what its controllers
 * render into the boxes they float next to the text. BlockNote places the side menu, toolbars, slash
 * menu, file panel and table handles; these only draw them. Menus and popovers are Mantine's, as the
 * app's `PopoverPanel` is, with Mantine's styles off and ours on. See wiki/pages.md.
 */

type P<G extends keyof ComponentProps, C extends keyof ComponentProps[G]> = ComponentProps[G][C];
type Generic<G extends keyof ComponentProps["Generic"], C extends keyof ComponentProps["Generic"][G]> = ComponentProps["Generic"][G][C];

/** Mantine's styles and motion off: ours are Tailwind classes, and nothing animates. A dropdown is `fixed` (Mantine's own class would place it). */
const plain = { unstyled: true, transitionProps: { duration: 0 }, zIndex: 50, floatingStrategy: "fixed" } as const;
/** The app's popover panel. */
const panel = "no-drag rounded-xl border border-neutral-200 bg-white text-sm text-neutral-900 shadow-lg";
const dropdown = `fixed ${panel} min-w-40 p-1`;
/** `MenuItem`'s look (views/chat/common.tsx), on Mantine's own item so its keyboard navigation and hover submenus work. */
const menuRow = "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left data-hovered:bg-neutral-100 data-disabled:cursor-not-allowed data-disabled:opacity-40";
const menuLabel = "px-2 pt-2 pb-1 text-xs font-medium text-neutral-400";
/** A `Loading` bar (ui.tsx) at menu size. */
const Loader = ({ className = "" }: { className?: string }) => <div className={`mx-2 my-2 h-3 w-24 animate-pulse rounded bg-neutral-100 ${className}`} />;
const cx = (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(" ");

const portal = (element: HTMLElement | null) => ({ withinPortal: !!element, portalProps: element ? { target: element } : undefined });
const middlewares = { flip: true, shift: true, inline: false, size: true };

// ---- Toolbars (formatting, link)

function ToolbarRoot({ className, "aria-label": label, children, onMouseEnter, onMouseLeave }: P<"FormattingToolbar", "Root">) {
	return (
		<div role="toolbar" aria-label={label} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} className={cx(panel, "flex items-center gap-0.5 p-1 empty:hidden", className)}>
			{children}
		</div>
	);
}

/**
 * The app's icon for each of BlockNote's toolbar buttons, which come with fixed ones (react-icons), by the
 * label BlockNote gives them; one not named here keeps its own (the Colors swatch).
 */
type Dictionary = ReturnType<typeof useDictionary>;
const toolbarIcons = new WeakMap<Dictionary, Map<string, typeof CheckIcon>>();
function toolbarIcon(dict: Dictionary, label: string | undefined) {
	let icons = toolbarIcons.get(dict);
	if (!icons) {
		const t = dict.formatting_toolbar;
		const files = (tooltips: Record<string, string>, Icon: typeof CheckIcon) => Object.values(tooltips).map((tooltip): [string, typeof CheckIcon] => [tooltip, Icon]);
		icons = new Map([
			[t.bold.tooltip, BoldIcon], [t.italic.tooltip, ItalicIcon], [t.underline.tooltip, UnderlineIcon], [t.strike.tooltip, StrikethroughIcon], [t.code.tooltip, CodeIcon],
			[t.link.tooltip, LinkIcon], [t.nest.tooltip, IndentIcon], [t.unnest.tooltip, OutdentIcon],
			[t.align_left.tooltip, AlignLeftIcon], [t.align_center.tooltip, AlignCenterIcon], [t.align_right.tooltip, AlignRightIcon], [t.align_justify.tooltip, AlignJustifyIcon],
			[t.file_caption.tooltip, CaptionIcon], [t.file_preview_toggle.tooltip, ShowIcon], [t.table_cell_merge.tooltip, MergeCellsIcon],
			...files(t.file_replace.tooltip, ReplaceIcon), ...files(t.file_rename.tooltip, EditIcon), ...files(t.file_download.tooltip, DownloadIcon), ...files(t.file_delete.tooltip, TrashIcon),
			[dict.link_toolbar.open.tooltip, OpenOutsideIcon], [dict.link_toolbar.delete.tooltip, UnlinkIcon],
		]);
		toolbarIcons.set(dict, icons);
	}
	return label ? icons.get(label) : undefined;
}

/** An icon button (text when BlockNote gives words); its tooltip is the app's `useTip`, portaled out of the toolbar's transform. */
function ToolbarButton({ className, children, icon, label, mainTooltip, secondaryTooltip, isSelected, isDisabled, onClick, variant: _variant, ref, ...rest }: P<"FormattingToolbar", "Button"> & { ref?: Ref<HTMLButtonElement> }) {
	const { tipFor, tip, hideTip } = useTip("below");
	const hover = mainTooltip ? tipFor(mainTooltip, secondaryTooltip) : undefined;
	const Icon = toolbarIcon(useDictionary(), label ?? mainTooltip);
	return (
		<>
			<button
				type="button"
				ref={ref}
				{...rest}
				{...hover}
				onMouseDown={(e) => { hideTip(); preventFocusOnTap(e); }}
				onClick={(e) => { hideTip(); onClick?.(e); }}
				aria-label={label}
				aria-pressed={isSelected}
				disabled={isDisabled}
				className={cx(children ? barButton : `${iconButton} text-base`, "aria-pressed:bg-neutral-200 aria-pressed:text-neutral-900", className)}
			>
				{children ?? (Icon ? <Icon /> : icon)}
			</button>
			{tip && createPortal(tip, document.body)}
		</>
	);
}

/** The block type picker: the current type as the button, the rest in a menu with a tick on it. */
function ToolbarSelect({ className, items, isDisabled, portalElement, preventFocusOnOpen }: P<"FormattingToolbar", "Select">) {
	const selected = items.find((item) => item.isSelected);
	if (!selected) return null;
	return (
		<MantineMenu {...plain} {...portal(portalElement)} disabled={isDisabled} trapFocus={preventFocusOnOpen ? false : undefined} middlewares={middlewares}>
			<MantineMenu.Target>
				<button type="button" onMouseDown={preventFocusOnTap} disabled={isDisabled} className={`${barButton} px-2`}>
					<span className="text-base">{selected.icon}</span>
					{selected.text}
					<CaretDownIcon className="text-neutral-400" />
				</button>
			</MantineMenu.Target>
			<MantineMenu.Dropdown className={cx(dropdown, className)}>
				{items.map((item) => (
					<MenuRow key={item.text} icon={item.icon} checked={item.isSelected} disabled={item.isDisabled} onClick={item.onClick}>{item.text}</MenuRow>
				))}
			</MantineMenu.Dropdown>
		</MantineMenu>
	);
}

// ---- Menus (the drag handle's, table handles', colors)

function MenuRoot({ sub, onOpenChange, position, portalElement, preventFocusOnOpen, children }: Generic<"Menu", "Root">) {
	if (sub) return <MantineMenu.Sub {...plain} middlewares={middlewares} onChange={onOpenChange} position={position}>{children}</MantineMenu.Sub>;
	return (
		<MantineMenu {...plain} {...portal(portalElement)} trapFocus={preventFocusOnOpen ? false : undefined} middlewares={middlewares} onChange={onOpenChange} position={position} returnFocus={false}>
			{children}
		</MantineMenu>
	);
}

function MenuTrigger({ children, sub }: Generic<"Menu", "Trigger">) {
	return sub ? <MantineMenu.Sub.Target>{children}</MantineMenu.Sub.Target> : <MantineMenu.Target>{children}</MantineMenu.Target>;
}

function MenuDropdown({ className, children, sub, ref }: Generic<"Menu", "Dropdown"> & { ref?: Ref<HTMLDivElement> }) {
	const Dropdown = sub ? MantineMenu.Sub.Dropdown : MantineMenu.Dropdown;
	return <Dropdown ref={ref} className={cx(dropdown, className)}>{children}</Dropdown>;
}

/** `checked` shows a tick, or keeps its space when false; `subTrigger` opens a submenu on hover. */
function MenuRow({ className, children, disabled, subTrigger, icon, checked, onClick, ref, ...rest }: Generic<"Menu", "Item"> & { ref?: Ref<HTMLButtonElement> }) {
	const Item = subTrigger ? MantineMenu.Sub.Item : MantineMenu.Item;
	const right = subTrigger ? <CaretRightIcon className="text-neutral-400" /> : checked ? <CheckIcon /> : checked === false ? <span className="size-4" /> : null;
	return (
		<Item ref={ref} {...rest} className={cx(menuRow, className)} classNames={{ itemLabel: "flex-1", itemSection: "flex items-center" }} leftSection={icon} rightSection={right} onClick={onClick} disabled={disabled}>
			{children}
		</Item>
	);
}

function MenuDivider({ className }: Generic<"Menu", "Divider">) {
	return <MantineMenu.Divider className={cx("my-1 border-t border-neutral-100", className)} />;
}

function MenuLabel({ className, children }: Generic<"Menu", "Label">) {
	return <MantineMenu.Label className={cx(menuLabel, className)}>{children}</MantineMenu.Label>;
}

/** A small handle: the side menu's + and ⋮⋮, a table cell's ▾. Dragging when BlockNote says so, or by the pointer (the ⋮⋮, PageEditor.tsx). */
export function HandleButton({ className, children, icon, onClick, onDragStart, onDragEnd, onPointerDown, draggable, label, ref, ...rest }: P<"SideMenu", "Button"> & { ref?: Ref<HTMLButtonElement>; onPointerDown?: (e: React.PointerEvent<HTMLButtonElement>) => void }) {
	return (
		<button type="button" ref={ref} {...rest} aria-label={label} onClick={onClick} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} onPointerDown={onPointerDown} className={cx(smallIconButton, "text-lg", (draggable || onPointerDown) && "cursor-grab", className)}>
			{icon ?? children}
		</button>
	);
}

// ---- Popovers (the link form)

function PopoverRoot({ open, onOpenChange, position, portalElement, children }: Generic<"Popover", "Root">) {
	return (
		<MantinePopover {...plain} {...portal(portalElement)} opened={open} onChange={onOpenChange} position={position} trapFocus={false} hideDetached={false} middlewares={{ size: { padding: 20 } }}>
			{children}
		</MantinePopover>
	);
}

function PopoverTrigger({ children }: Generic<"Popover", "Trigger">) {
	return <MantinePopover.Target>{children}</MantinePopover.Target>;
}

function PopoverContent({ className, children, variant, ref }: Generic<"Popover", "Content"> & { ref?: Ref<HTMLDivElement> }) {
	return <MantinePopover.Dropdown ref={ref} className={cx("fixed", variant === "form-popover" ? `${panel} flex flex-col gap-1.5 p-2` : "no-drag", className)}>{children}</MantinePopover.Dropdown>;
}

// ---- Forms (the link form's fields, the embed tab)

function FormRoot({ children, onSubmit, submitButton }: Generic<"Form", "Root">) {
	return (
		<form className="contents" onSubmit={(e) => { e.preventDefault(); onSubmit?.(); }}>
			{children}
			{submitButton === "none" ? null : submitButton}
		</form>
	);
}

function FormTextInput({ className, name, label, icon, rightSection, autoFocus, placeholder, disabled, value, onKeyDown, onChange, autoComplete, "aria-activedescendant": activeDescendant, ref }: Generic<"Form", "TextInput">) {
	const focus = useAutoFocus<HTMLInputElement>(autoFocus);
	const refs = useMergeRefs([focus, ref]);
	return (
		<label className="flex items-center gap-2">
			{label && <span className="text-sm text-neutral-500">{label}</span>}
			<span className="relative flex flex-1 items-center">
				<span className="pointer-events-none absolute left-2.5 text-neutral-400">{icon}</span>
				<input
					ref={refs}
					type="text"
					name={name}
					className={cx(compactControlClass, "w-72 pl-8", className)}
					placeholder={placeholder}
					disabled={disabled}
					value={value}
					onKeyDown={onKeyDown}
					onChange={onChange}
					autoComplete={autoComplete}
					aria-activedescendant={activeDescendant}
					data-autofocus={autoFocus ? "true" : undefined}
				/>
				{rightSection}
			</span>
		</label>
	);
}

// ---- Side menu

/** The + and ⋮⋮ beside a block, a little off its text: BlockNote puts the menu's right edge at the block's left. */
function SideMenuRoot({ className, children }: P<"SideMenu", "Root">) {
	return <div className={cx("flex items-center pr-2", className)}>{children}</div>;
}

// ---- Slash menu

function SuggestionMenuRoot({ className, children, id }: P<"SuggestionMenu", "Root">) {
	return <div id={id} role="listbox" className={cx(panel, "flex w-80 flex-col overflow-y-auto p-1", className)}>{children}</div>;
}

/** Keeps the keyboard's pick in view; mousedown is swallowed so the editor keeps focus for the pick. */
function useKeepInView(isSelected: boolean) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const menu = ref.current?.closest<HTMLElement>("[role=listbox], [role=grid]");
		if (isSelected && ref.current && menu && elementOverflow(ref.current, menu) !== "none") ref.current.scrollIntoView({ block: "nearest" });
	}, [isSelected]);
	return ref;
}

function SuggestionMenuItem({ className, isSelected, onClick, item, id }: P<"SuggestionMenu", "Item">) {
	const ref = useKeepInView(isSelected);
	const small = item.size === "small";
	return (
		<div ref={ref} id={id} role="option" aria-selected={isSelected || undefined} onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={cx("flex shrink-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 aria-selected:bg-neutral-100 hover:bg-neutral-100", className)}>
			{item.icon && <div className={small ? "flex text-neutral-500" : "flex size-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-lg text-neutral-600"}>{item.icon}</div>}
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium">{item.title}</div>
				{!small && item.subtext && <div className="truncate text-xs text-neutral-500">{item.subtext}</div>}
			</div>
			{item.badge && <span className="rounded-md bg-neutral-100 px-1.5 text-xs text-neutral-500">{item.badge}</span>}
		</div>
	);
}

function SuggestionMenuEmptyItem({ className, children }: P<"SuggestionMenu", "EmptyItem">) {
	return <div className={cx("px-2 py-1.5 text-neutral-500", className)}>{children}</div>;
}

function SuggestionMenuLabel({ className, children }: P<"SuggestionMenu", "Label">) {
	return <div className={cx(menuLabel, className)}>{children}</div>;
}

// ---- Table handles

function TableHandleRoot({ className, children, draggable, onDragStart, onDragEnd, style, label, ref, ...rest }: P<"TableHandle", "Root"> & { ref?: Ref<HTMLButtonElement> }) {
	return (
		<button type="button" ref={ref} {...rest} aria-label={label} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} style={style} className={cx(smallIconButton, "h-6 w-4 border border-neutral-200 bg-white text-base shadow-xs", draggable ? "cursor-grab" : "cursor-pointer", className)}>
			{children}
		</button>
	);
}

/** The + bar along a table's right or bottom edge; BlockNote's class on it says which (styles.css). */
function ExtendButton({ className, children, onClick, onMouseDown }: P<"TableHandle", "ExtendButton">) {
	return (
		<button type="button" onClick={onClick} onMouseDown={onMouseDown} className={cx(smallIconButton, "border border-neutral-200 bg-white shadow-xs", className)}>
			{children}
		</button>
	);
}

// ---- File panel (an image block without a picture yet: Upload / Embed)

function PanelRoot({ className, tabs, openTab, setOpenTab, loading }: P<"FilePanel", "Root">) {
	const open = tabs.find((tab) => tab.name === openTab) ?? tabs[0];
	return (
		<div className={cx(panel, "w-96 p-3", loading && "pointer-events-none opacity-60", className)}>
			<Tabs tabs={tabs.map((tab) => ({ id: tab.name, label: tab.name }))} value={openTab} onChange={setOpenTab} />
			<div className="pt-3">{open?.tabPanel}</div>
		</div>
	);
}

function PanelTab({ className, children }: P<"FilePanel", "TabPanel">) {
	return <div className={cx("flex items-center gap-2", className)}>{children}</div>;
}

function PanelButton({ className, children, type, onClick, label }: P<"FilePanel", "Button">) {
	return <button type={type} onClick={onClick} aria-label={label} className={cx(compactPrimaryButton, "shrink-0", className)}>{children}</button>;
}

function PanelFileInput({ className, accept, placeholder, onChange }: P<"FilePanel", "FileInput">) {
	return (
		<label className={cx(compactButton, "flex-1 cursor-pointer justify-center", className)}>
			<UploadIcon /> {placeholder}
			<input type="file" accept={accept} className="sr-only" onChange={(e) => onChange(e.currentTarget.files?.[0] ?? null)} />
		</label>
	);
}

function PanelTextInput({ className, value, placeholder, onChange, onKeyDown }: P<"FilePanel", "TextInput">) {
	return <input type="text" className={cx(compactControlClass, "min-w-0 flex-1", className)} value={value} placeholder={placeholder} onChange={onChange} onKeyDown={onKeyDown} />;
}

// ---- Not used by the page editor (no comments, versioning or suggestion marks here): the plainest correct boxes.

function Badge({ className, text, icon, isSelected, mainTooltip, onClick, onMouseEnter }: Generic<"Badge", "Root">) {
	return (
		<button type="button" title={mainTooltip} aria-pressed={isSelected} onClick={onClick} onMouseEnter={onMouseEnter} className={cx(pillLinkButton, "inline-flex items-center gap-1 aria-pressed:border-neutral-900", className)}>
			{icon}
			{text}
		</button>
	);
}

function BadgeGroup({ className, children }: Generic<"Badge", "Group">) {
	return <div className={cx("flex flex-wrap gap-1", className)}>{children}</div>;
}

function CommentCard({ className, children, headerText, selected, onFocus, onBlur, tabIndex }: P<"Comments", "Card">) {
	return (
		<div className={cx(panel, "p-3", selected && "ring-2 ring-neutral-300", className)} onFocus={onFocus} onBlur={onBlur} tabIndex={tabIndex}>
			{headerText && <p className="text-xs text-neutral-500 italic">{headerText}</p>}
			{children}
		</div>
	);
}

function CommentCardSection({ className, children }: P<"Comments", "CardSection">) {
	return <div className={cx("py-2", className)}>{children}</div>;
}

function ExpandSectionsPrompt({ className, children }: P<"Comments", "ExpandSectionsPrompt">) {
	return (
		<div className={cx("flex items-center gap-2 text-xs text-neutral-500", className)}>
			<span className="flex-1 border-t border-neutral-100" />
			{children}
			<span className="flex-1 border-t border-neutral-100" />
		</div>
	);
}

function CommentEditor({ className, autoFocus, editable, editor, onFocus, onBlur }: P<"Comments", "Editor">) {
	return <BlockNoteViewRaw editor={editor} editable={editable} autoFocus={autoFocus} className={className} onFocus={onFocus} onBlur={onBlur} sideMenu={false} slashMenu={false} tableHandles={false} filePanel={false} />;
}

function Comment({ className, children, authorInfo, timeString, edited, actions, showActions, emojiPickerOpen }: P<"Comments", "Comment">) {
	const shown = actions && (showActions === "hover" ? "opacity-0 group-hover:opacity-100" : showActions === false && !emojiPickerOpen ? "hidden" : "");
	return (
		<div className={cx("group relative flex flex-col gap-1", className)}>
			{actions && <div className={cx("absolute top-0 right-0", shown || undefined)}>{actions}</div>}
			<div className="flex items-center gap-2 text-sm">
				{authorInfo === "loading" ? <span className="h-4 w-24 animate-pulse rounded bg-neutral-100" /> : <>
					<span className="font-medium">{authorInfo.username}</span>
					<span className="text-xs text-neutral-400">{timeString}{edited && " (edited)"}</span>
				</>}
			</div>
			{children}
		</div>
	);
}

function VersioningSidebar({ className, children, "aria-label": label }: P<"Versioning", "Sidebar">) {
	return <div role="region" aria-label={label} className={cx("flex flex-col", className)}>{children}</div>;
}

function VersioningHeader({ className, title, actions, closeAction }: P<"Versioning", "Header">) {
	return (
		<div className={cx("flex items-center justify-between gap-2", className)}>
			<div className="flex items-center gap-1.5"><span className="text-lg font-medium">{title}</span>{actions}</div>
			{closeAction}
		</div>
	);
}

function VersioningName(props: P<"Versioning", "Name">) {
	if (props.mode === "display") return <span>{props.value}</span>;
	return <input ref={props.inputRef} type="text" className={compactControlClass} value={props.value} placeholder={props.placeholder} aria-label={props["aria-label"]} onChange={props.onChange} onClick={props.onClick} onKeyDown={props.onKeyDown} onBlur={props.onBlur} />;
}

function VersioningSnapshot({ className, id, "aria-label": label, state, tabIndex, "aria-busy": busy, onClick, onKeyDown, onFocus, actions, name, date, restoredFrom, secondaryLabel, comparingLabel, comparingIcon }: P<"Versioning", "Snapshot">) {
	const current = state === "selected" || state === "comparison-source";
	return (
		<div role="listitem" id={id} aria-label={label} aria-current={current || undefined} aria-busy={busy} tabIndex={tabIndex} onClick={onClick} onKeyDown={onKeyDown} onFocus={onFocus} data-active={current || undefined} className={cx(versionRowButton, "relative w-full gap-0.5", className)}>
			{comparingLabel && <span className="flex items-center gap-1 text-xs text-neutral-500">{comparingIcon}{comparingLabel}</span>}
			<span className="flex items-center gap-1.5">{name}</span>
			{date && <span className="text-xs text-neutral-500">{date}</span>}
			{restoredFrom && <span className="text-xs text-neutral-500">{restoredFrom}</span>}
			{secondaryLabel && <span className="text-xs text-neutral-400">{secondaryLabel}</span>}
			{actions && <span className="absolute top-2 right-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{actions}</span>}
		</div>
	);
}

function AttributionTooltip({ className, markClassName, backgroundColor, children }: P<"AttributionTooltip", "Root">) {
	// eslint-disable-next-line shadcn/no-inline-styles -- each author's own color, from BlockNote
	return <span className={cx(className, markClassName)} style={markClassName ? undefined : { backgroundColor }}>{children}</span>;
}

const toolbar = { Root: ToolbarRoot, Button: ToolbarButton, Select: ToolbarSelect };

/** BlockNote's contract has a grid menu too (its own emoji picker); the app's `:` menu is a list (`emojiItems`), so none is drawn. */
export const components = {
	FormattingToolbar: toolbar,
	LinkToolbar: toolbar,
	FilePanel: { Root: PanelRoot, Button: PanelButton, FileInput: PanelFileInput, TabPanel: PanelTab, TextInput: PanelTextInput },
	SideMenu: { Root: SideMenuRoot, Button: HandleButton },
	SuggestionMenu: { Root: SuggestionMenuRoot, Item: SuggestionMenuItem, EmptyItem: SuggestionMenuEmptyItem, Label: SuggestionMenuLabel, Loader },
	TableHandle: { Root: TableHandleRoot, ExtendButton },
	Comments: { Card: CommentCard, CardSection: CommentCardSection, ExpandSectionsPrompt, Editor: CommentEditor, Comment },
	Versioning: { Sidebar: VersioningSidebar, Header: VersioningHeader, Name: VersioningName, Snapshot: VersioningSnapshot, Loader },
	AttributionTooltip: { Root: AttributionTooltip },
	Generic: {
		Badge: { Root: Badge, Group: BadgeGroup },
		Form: { Root: FormRoot, TextInput: FormTextInput },
		Menu: { Root: MenuRoot, Trigger: MenuTrigger, Dropdown: MenuDropdown, Divider: MenuDivider, Label: MenuLabel, Item: MenuRow, Button: HandleButton },
		Popover: { Root: PopoverRoot, Trigger: PopoverTrigger, Content: PopoverContent },
		Toolbar: toolbar,
	},
} satisfies Omit<Components, "GridSuggestionMenu"> as Components;
