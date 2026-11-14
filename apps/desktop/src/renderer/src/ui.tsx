import { api } from "./api";
import { useQuery, useWorkspace } from "./convex";
import { Component, Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import { errorMessage } from "./api";
import { CaretDownIcon, PlusIcon, SearchIcon } from "./icons";
import { navigate } from "./router";
import type { DragProps } from "./sortable";
import { Popover } from "./views/chat/common";

/**
 * The name (and shortcut) of whatever's hovered, at once: a title waits a second and can't be
 * styled. Spread `tipFor(label, hint)` on the thing, and render `tip` anywhere. `right` clears
 * the workspace rail's edge; `below` hangs under a title bar button or a reaction.
 */
export function useTip(side: "right" | "below") {
	const [at, setAt] = useState<{ label: string; hint?: string; left: number; top: number }>();
	const hide = () => setAt(undefined);
	// It's placed once, on entering: a scroll would leave it behind (and the pointer may not leave).
	const shown = !!at;
	useEffect(() => {
		if (!shown) return;
		document.addEventListener("scroll", hide, true);
		return () => document.removeEventListener("scroll", hide, true);
	}, [shown]);
	const tipFor = (label: string, hint?: string) => ({
		onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
			// A popover's open panel counts as inside its button to React, though it's elsewhere on the page.
			if (!e.currentTarget.contains(e.target as Node)) return;
			const box = e.currentTarget.getBoundingClientRect();
			setAt(side === "right" ? { label, hint, left: box.right + 16, top: box.top + box.height / 2 } : { label, hint, left: box.left + box.width / 2, top: box.bottom + 6 });
		},
		onMouseLeave: hide,
		onMouseDown: hide,
	});
	const tip = at && (
		<div
			style={{ left: at.left, top: at.top }}
			className={`pointer-events-none fixed z-50 flex gap-2 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg ${side === "right" ? "-translate-y-1/2" : "-translate-x-1/2"}`}
		>
			{at.label}
			{at.hint && <span className="text-neutral-400">{at.hint}</span>}
		</div>
	);
	return { tipFor, tip, hideTip: hide };
}

/**
 * Text cut short anywhere (`truncate`, `line-clamp-*`) shows in full under it on hover, in the
 * same tip, after a moment so sweeping across a list doesn't flash them. Mounted once, in App.
 */
export function TruncatedTips() {
	const [at, setAt] = useState<{ text: string; left: number; top: number }>();
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let over: Element | null = null;
		const hide = () => (clearTimeout(timer), (over = null), setAt(undefined));
		const enter = (e: MouseEvent) => {
			const el = cutUnder(e);
			if (el === over) return;
			hide();
			const text = el?.textContent?.trim();
			// Only when it's actually cut, and not where a title already says it in full.
			if (!el || !text || !isCut(el) || saidByTitle(el, text)) return;
			over = el;
			timer = setTimeout(() => {
				const box = el.getBoundingClientRect();
				setAt({ text, left: Math.max(8, Math.min(box.left, window.innerWidth - 8 - 384)), top: box.bottom + 6 });
			}, 400);
		};
		// mousemove, not mouseover: inside a row's overlay the target never changes as you move onto the text.
		document.addEventListener("mousemove", enter);
		document.addEventListener("mousedown", hide);
		document.addEventListener("scroll", hide, true);
		return () => {
			hide();
			document.removeEventListener("mousemove", enter);
			document.removeEventListener("mousedown", hide);
			document.removeEventListener("scroll", hide, true);
		};
	}, []);
	return (
		at && (
			<div
				style={{ left: at.left, top: at.top }}
				className="pointer-events-none fixed z-50 max-w-sm rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium break-words text-white shadow-lg"
			>
				{at.text}
			</div>
		)
	);
}

const CUTTABLE = '.truncate, [class*="line-clamp-"]';

/**
 * The cuttable text under the pointer. A row's click area (an `after:` overlay, as in sidebar
 * rows) makes the row's button the target wherever you point, so look inside the button too.
 */
function cutUnder(e: MouseEvent) {
	const target = e.target as Element;
	const own = target.closest?.(CUTTABLE);
	if (own) return own;
	const control = target.closest?.("button, a");
	for (const el of control?.querySelectorAll(CUTTABLE) ?? []) {
		const box = el.getBoundingClientRect();
		if (e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom) return el;
	}
	return null;
}

/**
 * Cut short, counting text over by less than a pixel: the scroll sizes are whole pixels, so
 * they can match the box while an ellipsis shows. The text's own width settles it.
 */
function isCut(el: Element) {
	if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) return true;
	const range = document.createRange();
	range.selectNodeContents(el);
	return range.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.5;
}

/** A title on it or around it that already holds the whole text. Unrelated titles (a "Setting" label, an agent's description) don't count. */
function saidByTitle(el: Element, text: string) {
	for (let at: Element | null = el.closest("[title]"); at; at = at.parentElement?.closest("[title]") ?? null) {
		if (at.getAttribute("title")?.includes(text)) return true;
	}
	return false;
}

/** A screen above this one, in the top bar's trail. */
export type Crumb = { label: string; to: string[] };

/**
 * The bar across the top of every screen, chat included: where you are on the left
 * (each screen above it is a link back), what you can do here on the right. It's also
 * where you drag the window.
 */
export function TopBar({ crumbs = [], title, description, children }: { crumbs?: Crumb[]; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode }) {
	// Its text starts 20px in (16 here, 4 on the title or crumb), like the sidebar's workspace name.
	return (
		<header className="drag flex h-12 shrink-0 items-center gap-3 px-4 select-none">
			<nav className="flex min-w-0 items-center overflow-x-auto text-sm">
				{crumbs.map((c) => (
					<Fragment key={c.to.join("/")}>
						<button type="button" onClick={() => navigate(...c.to)} className="no-drag shrink-0 rounded-md px-1 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">
							{c.label}
						</button>
						<span className="shrink-0 px-1 text-neutral-300">/</span>
					</Fragment>
				))}
				<div className="flex min-w-0 items-center gap-2 px-1 font-semibold">
					{title}
					{/* Gives way before the title does: it only gets the room left over. */}
					{description && <p className="min-w-0 flex-1 truncate font-normal text-neutral-500">{description}</p>}
				</div>
			</nav>
			{children && <div className="no-drag ml-auto flex shrink-0 items-center gap-1">{children}</div>}
		</header>
	);
}

/**
 * A scrolling area whose header and footer stay put, taking their own room, so content
 * starts below the header and ends above the footer. Content scrolled under either fades
 * out on its scrim (styles.css), which shows only while something is under it.
 * `overlayScrollbar` keeps chat panes flush even when the OS uses classic scrollbars.
 */
/** Whether content is scrolled under the bottom edge of the `Scroll` around you: a sticky footer inside it (a dialog's buttons) fades in its scrim. */
export const ScrollUnder = createContext(false);

export function Scroll({
	ref,
	header,
	footer,
	overlayScrollbar = false,
	fill = false,
	className = "",
	onScroll,
	children,
}: {
	ref?: React.RefObject<HTMLDivElement | null>;
	header?: React.ReactNode;
	footer?: React.ReactNode;
	overlayScrollbar?: boolean;
	/** The content is exactly the screen's height and scrolls itself (`Page`'s `fill`). */
	fill?: boolean;
	className?: string;
	onScroll?: React.UIEventHandler<HTMLDivElement>;
	children: React.ReactNode;
}) {
	const own = useRef<HTMLDivElement>(null);
	const scroller = ref ?? own;
	const [underTop, setUnderTop] = useState(false);
	const [underBottom, setUnderBottom] = useState(false);
	const measure = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		setUnderTop(el.scrollTop > 0);
		setUnderBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
	}, [scroller]);
	// Content can grow or shrink without a scroll: new messages, a longer draft, a resize.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => observer.disconnect();
	}, [scroller, measure]);
	const content = (
		<div className={`flex flex-1 flex-col ${fill ? "h-full" : "min-h-full"}`}>
			{header && (
				<div className="scrim-top sticky top-0 z-30" data-under={underTop || undefined}>
					{header}
				</div>
			)}
			<div className={`flex flex-1 flex-col ${fill ? "min-h-0" : ""}`}>
				<ScrollUnder.Provider value={underBottom}>{children}</ScrollUnder.Provider>
			</div>
			{footer && (
				<div className="scrim-bottom sticky bottom-0 z-30" data-under={underBottom || undefined}>
					{footer}
				</div>
			)}
		</div>
	);
	const scroll = (e: React.UIEvent<HTMLDivElement>) => (measure(), onScroll?.(e));
	if (!overlayScrollbar) return <div ref={scroller} onScroll={scroll} className={`min-h-0 flex-1 overflow-y-auto ${className}`}>{content}</div>;
	return (
		<ScrollArea.Root type="hover" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
			<ScrollArea.Viewport ref={scroller} onScroll={scroll} tabIndex={0} disableImplicitContentElement className={`h-full w-full outline-none ${className}`}>
				<ScrollArea.Content asChild style={{ display: "flex" }}>{content}</ScrollArea.Content>
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar orientation="vertical" className="no-drag z-40 flex w-2 touch-none p-0.5 select-none">
				<ScrollArea.Thumb className="relative flex-1 rounded-full bg-neutral-400/70 hover:bg-neutral-500" />
			</ScrollArea.Scrollbar>
		</ScrollArea.Root>
	);
}

/** The page's top-bar spot for `PageActions`. */
const actionSlot = createContext<HTMLElement | null>(null);

/**
 * A screen: the top bar, then its content. The title lives in the top bar; `heading` is
 * a big title in the content, only for things you write in and rename there (pages, records).
 * `description` sits next to the title in the top bar: a few words, like a channel's topic (it
 * truncates; the details belong in help). `actions` go on the top bar's right. `wide` for tables.
 */
export function Page({
	title,
	menu,
	badge,
	crumbs,
	heading,
	description,
	actions,
	wide,
	gutter,
	fill,
	children,
}: {
	title: string;
	/** Actions for what's on screen (History, Move to…, Archive): the title opens them, with a caret to say so. */
	menu?: (close: () => void) => React.ReactNode;
	/** After the title in the bar: its access lock (`AccessLock`), as the sidebar shows it on the row. */
	badge?: React.ReactNode;
	crumbs?: Crumb[];
	heading?: React.ReactNode;
	description?: string;
	actions?: React.ReactNode;
	wide?: boolean;
	/** Room beside the column, title included, for the page editor's + and ⋮⋮ (54px): they never hang over the sidebar. */
	gutter?: boolean;
	/** The content fills the screen down to its bottom edge, and a child with `flex-1 min-h-0` scrolls itself (a table, so its header sticks and its sideways scrollbar sits at the bottom). */
	fill?: boolean;
	children: React.ReactNode;
}) {
	// Where `PageActions` from the content land, after `actions`.
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	return (
		<Scroll
			className="@container"
			fill={fill}
			header={
				<TopBar
					crumbs={crumbs}
					title={
						<>
							{menu ? (
								<Popover trigger={<><span className="truncate">{title}</span><CaretDownIcon className="shrink-0 text-neutral-400" /></>} className="no-drag -mx-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-neutral-100 aria-expanded:bg-neutral-100" panelClassName="w-56 p-1">
									{menu}
								</Popover>
							) : (
								<span className="truncate">{title}</span>
							)}
							{badge}
						</>
					}
					description={description}
				>
					{actions}
					<span ref={setSlot} className="contents" />
				</TopBar>
			}
		>
			<actionSlot.Provider value={slot}>
				{/* The column's text is `--text` wide, padded `--pad`. `--bleed`: from the text out to the screen's edge, for `.bleed`. */}
				<div
					style={{ "--text": wide ? "61rem" : "39rem", "--pad": gutter ? "4rem" : "1.5rem" } as React.CSSProperties}
					className={`mx-auto flex w-full max-w-[calc(var(--text)+2*var(--pad))] flex-1 flex-col gap-6 px-(--pad) pt-page-top [--bleed:max(var(--pad),calc((100cqw-var(--text))/2))] ${fill ? "min-h-0" : "pb-10"}`}
				>
					{heading && <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>}
					{children}
				</div>
			</actionSlot.Provider>
		</Scroll>
	);
}

export function Tabs<T extends string>({
	tabs,
	value,
	onChange,
	drag,
	onRename,
	children,
	end,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (tab: T) => void;
	/** From `useSortable(…, "x")`, for tabs that can be dragged into another order. */
	drag?: (tab: T) => DragProps | undefined;
	/** For tabs that rename in place, on a double-click or F2, like the sidebar's rows. */
	onRename?: (tab: T, name: string) => Promise<unknown>;
	/** Extra controls after the last tab. */
	children?: React.ReactNode;
	/** Controls at the row's far end, like a view's search and filters. They keep their place; the tabs scroll. */
	end?: React.ReactNode;
}) {
	const tabClass = (open: boolean) =>
		`max-w-full truncate border-b-2 px-3 py-2 text-sm ${open ? "border-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-800"}`;
	const [renaming, setRenaming] = useState<T>();
	return (
		<nav className="flex items-end gap-2 border-b border-neutral-200">
			{/* -mb-px: the open tab's underline sits on the row's line. The tabs stay inside the box, which
			    scrolls only sideways (overflow-x alone would let it scroll up and down by anything poking out). */}
			<div className="-mb-px flex min-w-0 flex-1 items-end gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
			{tabs.map((t) => {
				const d = drag?.(t.id);
				return (
					<span key={t.id} {...(renaming !== t.id && d)} className={`relative flex max-w-full ${d?.className ?? ""}`}>
						{renaming === t.id && onRename ? (
							// Looks like the tab it renames (size, weight, padding, underline), so nothing shifts; only a light border, with room around the text like the sidebar's, marks it.
							<span className={tabClass(t.id === value)}>
								<RenameInput value={t.label} onSave={(name) => onRename(t.id, name)} onDone={() => setRenaming(undefined)} className="-mx-2 -my-1 min-w-[4ch] px-2 py-1 [field-sizing:content]" />
							</span>
						) : (
							<button
								type="button"
								onClick={() => onChange(t.id)}
								onDoubleClick={onRename && (() => setRenaming(t.id))}
								onKeyDown={onRename && ((e) => e.key === "F2" && (e.preventDefault(), setRenaming(t.id)))}
								className={tabClass(t.id === value)}
							>
								{t.label}
							</button>
						)}
					</span>
				);
			})}
			{children}
			</div>
			{end && <div className="flex shrink-0 items-center gap-1.5 self-center pb-1 text-sm">{end}</div>}
		</nav>
	);
}

/**
 * A titled part of a screen, usually a stack of cards. Its heading is inset to line up with the
 * text inside them; `flush` keeps it at the edge, for plain content (a form) that sits there too.
 * Headings are a title only: what a setting does is its own hint. `note`, for the rare section
 * that needs one, is a small footnote under its content, as in macOS settings.
 */
export function Section({ title, note, flush, action, children }: { title: string; note?: string; flush?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<Heading title={title} flush={flush} action={action} />
			{children}
			<Note text={note} flush={flush} />
		</section>
	);
}

/** Section and Settings headings: a title, and on the right a button for the section (Add). */
function Heading({ title, flush, action }: { title?: string; flush?: boolean; action?: React.ReactNode }) {
	if (!title) return null;
	return (
		<div className={`flex min-h-7 items-center gap-3 ${flush ? "" : insetClass}`}>
			<h2 className="min-w-0 flex-1 font-medium">{title}</h2>
			{action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
		</div>
	);
}

function Note({ text, flush }: { text?: string; flush?: boolean }) {
	return text ? <p className={`text-xs text-neutral-500 ${flush ? "" : insetClass}`}>{text}</p> : null;
}

/**
 * Settings, one per row in a card: what it is and a one-line hint on the left, its
 * control on the right. Every form uses it, on a settings screen and in a dialog alike, so they
 * look the same everywhere.
 */
export function Settings({ title, note, action, children }: { title?: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<Heading title={title} action={action} />
			<div className={listClass}>{children}</div>
			<Note text={note} />
		</section>
	);
}

/**
 * One setting in a `Settings` card. Every form uses these rows, on a screen or in a dialog.
 * `wide` is for long text and lists (a textarea, instructions, options): the label and hint on
 * top, the control across the card under them (give it `compactControlClass w-full`).
 */
export function Setting({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
	return (
		<div className={`flex px-4 py-2.5 ${wide ? "flex-col gap-2" : "items-center gap-6"}`}>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<p className="text-sm font-medium">{label}</p>
				{hint && <p className="text-xs text-neutral-500">{hint}</p>}
			</div>
			<div className={`flex items-center gap-2 text-sm ${wide ? "" : "shrink-0"}`}>{children}</div>
		</div>
	);
}

/**
 * A question on sign-in or onboarding: its label (and hint) over a full-width control, no card.
 * Those screens ask one thing at a time; settings, on a screen or in a dialog, are `Settings` rows.
 */
export function Question({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex min-w-0 flex-col gap-0.5">
				<p className="text-sm font-medium">{label}</p>
				{hint && <p className="text-xs text-neutral-500">{hint}</p>}
			</div>
			{children}
		</div>
	);
}

/** A form that stays put on submit; `onSubmit` gets the form, for `FormData`. Fields stack unless `className` says otherwise. */
export function Form({ className = "flex flex-col gap-4", onSubmit, children }: { className?: string; onSubmit: (form: HTMLFormElement) => void; children: React.ReactNode }) {
	return (
		<form className={className} onSubmit={(e) => (e.preventDefault(), onSubmit(e.currentTarget))}>
			{children}
		</form>
	);
}

/** The old stacked form field: `ui/no-stacked-form` reports every use. Forms are `Setting` rows; delete this once none are left. */
/**
 * A count in a pill: unread @mentions and DMs on the rail and in the switcher (red), an @ on a
 * sidebar row (`dark`). `ring` cuts it out from what it sits on (the rail's background).
 */
export function CountBadge({ count, dark, ring, className = "" }: { count: number | string; dark?: boolean; ring?: boolean; className?: string }) {
	return (
		<span
			className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-[5px] text-[11px] leading-none font-bold text-white tabular-nums ${dark ? "bg-neutral-900" : "bg-red-500"} ${ring ? "ring-2 ring-neutral-100" : ""} ${className}`}
		>
			{typeof count === "number" && count > 9 ? "9+" : count}
		</span>
	);
}

export const disabledButtonClass = "disabled:opacity-50";
const controlClass = "border border-neutral-200 focus:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:bg-neutral-50 disabled:text-neutral-500";
/** An input, select or textarea: the same box as `buttonBox`, so a row of fields and buttons lines up. */
export const compactControlClass = `rounded-lg px-3 py-1.25 text-sm ${controlClass}`;
/**
 * Every text button's box: one height, padding and corner. The looks below only add color, so
 * buttons can't drift apart. Their names say where they go (the lint rules check that).
 */
const buttonBox = `inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-1 text-sm ${disabledButtonClass}`;
const outlined = `${buttonBox} border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50`;
const filled = `${buttonBox} border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700`;
const quiet = `${buttonBox} border-transparent text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900`;
/** On a screen, beside fields (Filter, Columns, Discard). */
export const compactButton = outlined;
/** `compactButton` for a destructive action (Leave channel). */
export const compactDangerButton = `${buttonBox} border-neutral-200 bg-white text-red-600 hover:bg-red-50`;
/** Submits a row of fields on a screen (Invite, Add, Save). */
export const compactPrimaryButton = filled;
/** A dialog's buttons, in `DialogButtons`. */
export const primaryButton = filled;
export const dangerButton = `${buttonBox} border-red-600 bg-red-600 text-white hover:bg-red-700`;
export const secondaryButton = outlined;
/** The top bar: quiet actions (Edit, History), and the create action (`NewButton`). */
export const barButton = quiet;
export const barDangerButton = `${buttonBox} border-transparent text-neutral-600 hover:bg-red-50 hover:text-red-700`;
export const barPrimaryButton = filled;
/** Where a card, popover or settings row acts on its own (Deny, Upload, Check for updates). */
export const actionButton = outlined;
export const actionPrimaryButton = filled;
/** `compactButton` inside a line of small text (a message's notes, a paused-agents line): smaller. */
export const smallButton = `inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 ${disabledButtonClass}`;
/** A database's view toolbar (Search, Filter, Columns, Layout): quiet like Notion's, gray until hovered or open. */
export const toolButton = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 aria-expanded:bg-neutral-100 aria-expanded:text-neutral-900 ${disabledButtonClass}`;
/** A database filter, as a chip under the toolbar (`data-active` once it filters something). */
export const filterChip = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-neutral-300 px-2.5 text-sm text-neutral-500 hover:bg-neutral-50 data-active:border-solid data-active:border-neutral-200 data-active:bg-neutral-100 data-active:text-neutral-900 data-active:hover:bg-neutral-200/70";
/** A field in `toolButton`'s row (the search box): its height. */
export const toolControlClass = `h-7 rounded-md px-2 text-sm ${controlClass}`;
/** An action at the end of a list of field labels, in their look and size (Add field). */
export const labelButton = `-mx-1.5 flex w-fit items-center gap-2 rounded-md px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 ${disabledButtonClass}`;
/** A row's trailing action as an icon (Remove, Delete): visible at rest; give it an aria-label and a title. */
/** A square button holding only an icon, everywhere (dialog headers, rows, toolbars): big enough to see at a glance. */
export const iconButton = `no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-lg text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 aria-expanded:bg-neutral-100 ${disabledButtonClass}`;
export const iconDangerButton = `inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-lg text-neutral-600 hover:bg-red-50 hover:text-red-600 ${disabledButtonClass}`;
/** A row's or section header's trailing control: same size and right edge everywhere; a pill on hover and while its menu is open. */
export const trailingAction =
	"flex size-5 shrink-0 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-200/80 hover:text-neutral-900 aria-expanded:bg-neutral-200/80 aria-expanded:text-neutral-900";
/** The composer's round tools beside the text: attach, emoji, dictation. */
export const composerButton = "flex size-8 shrink-0 items-center justify-center rounded-full text-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50";
/** The composer's Send: a round dark button with an arrow, grey until there's something to send. */
export const sendButton = "flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white disabled:bg-neutral-200";
/** The landing screen's one big dark button (Get started). */
export const heroButton = "rounded-xl bg-neutral-900 px-6 py-2.5 text-base text-white hover:bg-neutral-800";
/** The sidebar footer's "Update ready · Restart": small dark text block. */
export const updateButton = "rounded-lg bg-neutral-900 px-3 py-2 text-left text-xs text-white";
/** The title bar's 24px icons (sidebar, back, forward, help): greyed out while disabled. */
export const titleBarButton =
	"no-drag flex size-7 items-center justify-center rounded-md text-lg text-neutral-600 hover:bg-neutral-200/70 hover:text-neutral-900 disabled:text-neutral-300 disabled:hover:bg-transparent";
/** A small round × in a card's corner (a pending file, a link preview). */
export const cornerCloseButton = "flex size-5 items-center justify-center rounded-full text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900";
/** A 24px icon beside a title (a DM's New chat). */
export const smallIconButton = "flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900";
/** An icon with no box of its own (remove a filter, remove a chip): grey, darker on hover. */
export const bareIconButton = "text-neutral-400 hover:text-neutral-700";
/** A row's fold chevron, shown in its icon slot on hover. */
export const chevronButton = "size-5 items-center justify-center text-neutral-400 hover:text-neutral-800";
/** The × on an email chip (Onboarding's invite box): a tiny round hover. */
export const chipRemoveButton = "rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700";
/** The × beside a time in the schedule editor. */
export const timeRemoveButton = "rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700";
/** The × on a side chat tab, over the tab's pill. */
export const tabCloseButton = "flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-900";
/** The + after a list's view tabs: the same button as the toolbar's at the row's other end, level with the tab names. */
export const tabAddButton = `${toolButton} mb-1.5`;
/** A suggested first message in an empty agent chat. */
export const suggestionButton =
	"rounded-xl border border-neutral-200 px-3 py-2 text-left text-sm text-neutral-600 transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400";
/** A channel's members (avatars and a count) in its top bar. */
export const membersButton = "flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100";
/** A message's "3 replies · Last reply …" line under it. */
export const repliesButton = "-ml-1 flex w-fit items-center gap-2 rounded-lg px-1 py-0.5 text-xs hover:bg-white";
/** A small bordered pill that goes somewhere (a tool call's "opened a thread →"). */
export const pillLinkButton = "rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 hover:border-neutral-300 hover:text-neutral-900";
/** The typing line's Stop: quiet text with a hover fill. */
export const stopButton = "rounded px-1.5 font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-60 disabled:hover:bg-transparent";
/** An on/off pill (Install, Turn on for me); pass its colors for each state. */
export const pillButton = `shrink-0 rounded-full px-3 py-1 text-sm ${disabledButtonClass}`;
/** A round day of the week in the schedule editor; pass its colors for on and off. */
export const dayButton = "size-8 rounded-full text-sm";
/** An emoji picker's category tab. */
export const emojiTabButton = "flex size-7 items-center justify-center rounded-lg text-base hover:bg-neutral-100";
/** An emoji picker's skin tone: filled while picked (`aria-pressed`). */
export const skinToneButton = "flex size-6 items-center justify-center rounded-md text-sm hover:bg-neutral-100 aria-pressed:bg-neutral-200";
/** A card on a board lane. */
export const boardCardButton = "flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm shadow-xs hover:bg-neutral-50";
/** A board column's last row, or the board's last column: adds one there ("+ New client", "+ New column"). Card-shaped but faint, solid white on hover. */
export const laneAddButton = `flex w-full items-center gap-1.5 rounded-lg border border-neutral-200 bg-white/60 px-3 py-2 text-left text-sm text-neutral-500 hover:bg-white hover:text-neutral-900 ${disabledButtonClass}`;
/** One version in a page's history: lit while shown (`data-active`). */
export const versionRowButton = "flex flex-col rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-50 data-active:bg-neutral-100";
/** A rail button (a tab or a pin): a 40px square, filled while it's the open one. */
export const railButton = (active: boolean) =>
	`no-drag flex size-10 items-center justify-center rounded-lg transition-colors ${active ? "bg-neutral-200/90 text-neutral-900" : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900"}`;
/** Text that opens what it names (a record, a channel, an archived item): underlined on hover. */
export const linkButton = "text-left hover:underline";
// Inline, not flex: a flex chip sits on its icon's bottom edge, so its name rides above the line's text.
const inlineIcon = "box-decoration-clone [&>svg]:mr-1 [&>svg]:inline [&>svg]:align-[-0.125em]";
/** A record tagged in a message (`@Summit Homes`): an inline chip in the app's grays that opens the record. */
export const recordTagButton = `rounded-sm bg-neutral-100 px-1 text-left font-medium text-neutral-800 hover:bg-neutral-200 ${inlineIcon}`;
/** A tagged record with nothing to open: in Archive, deleted, or in a database you can't see. */
export const recordTagMutedClass = `rounded-sm bg-neutral-50 px-1 font-medium text-neutral-400 ${inlineIcon}`;
/** A title you click: folds its section, sorts its column, opens its field's settings. Darkens on hover. */
export const titleButton = "min-w-0 text-left hover:text-neutral-900";
/** One row in a list you pick from (a menu, versions, workspaces): lit on hover and while picked (`data-active`). */
export const rowButton = `flex w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 data-active:bg-neutral-100 ${disabledButtonClass}`;
/** A row inside a `listClass` card that opens what it shows. */
export const listRowButton = "flex w-full gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-50";
/** A square in a grid of choices (an emoji). */
export const tileButton = "flex size-8 items-center justify-center rounded-lg hover:bg-neutral-100";
/** `tileButton` that shows which one is picked (`aria-pressed`): a field's icon. */
export const pickedTileButton = `${tileButton} text-lg text-neutral-600 hover:text-neutral-900 aria-pressed:bg-neutral-200 aria-pressed:text-neutral-900`;
/** A square beside an input that opens a picker for it: a field's icon beside its name, an option's color. */
export const swatchButton = "inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-neutral-300 bg-white text-lg text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 aria-expanded:bg-neutral-50";
/** A picture that opens full size. */
export const imageButton = "overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-300";
/** An on/off pill with a count (a reaction): filled while on (`aria-pressed`). */
export const chipButton =
	"flex h-7 items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 text-sm text-neutral-600 tabular-nums hover:border-neutral-300 aria-pressed:border-neutral-400 aria-pressed:bg-neutral-100 aria-pressed:text-neutral-900";
/** A button whose look is what it sits in (a sidebar row, a tab's pill): none of its own. */
export const surfaceButton = "min-w-0 text-left";
export const descriptionClass = "text-sm text-neutral-500";
export const metadataClass = "text-xs text-neutral-400";
/** Quiet text in place of content: nothing here yet, loading. */
export const hintClass = "text-sm text-neutral-400";
/** A quiet panel of facts in a form, like what a change will do before it's confirmed. */
export const notePanelClass = "flex flex-col gap-1.5 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-700";
/** One item as a bordered box: an entry, a rule, a member. */
export const cardClass = "rounded-xl border border-neutral-200 px-4 py-3";
/** A card you click to open what it shows (a role, an agent, a message): the card, lit on hover. */
export const cardButton = `${cardClass} flex text-left hover:bg-neutral-50 ${disabledButtonClass}`;
/** Lines text outside a card (a heading, an empty note) up with the text inside it: its padding plus its 1px border. */
export const insetClass = "px-[17px]";
/** Rows in one bordered box, split by lines. In a dialog the dialog is the box: no border, rows flush (styles.css). */
export const listClass = "card-list flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200";
/**
 * The row of compact controls atop a screen's content: search and filters, or a one-line add
 * form (`Form className`). One class so every screen's row has the same height and spacing.
 */
export const toolbarClass = "flex flex-wrap items-center gap-2 text-sm";
/** A compact control in a screen's toolbar or a settings row: search boxes, pickers. */
export const wideControlClass = `${compactControlClass} w-64`;
/** A control on its own, across its space: a `Question`'s, or a dialog's that asks one thing. */
export const fullControlClass = `${compactControlClass} w-full`;

/** A line between groups in a menu. */
export function MenuDivider() {
	return <div className="my-1 border-t border-neutral-100" />;
}

/** A screen's create action, always in the top bar: the same look on every screen. */
export function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
	return <button type="button" className={barPrimaryButton} onClick={onClick}><PlusIcon /> {label}</button>;
}

/**
 * A screen with nothing in it yet: no button, since the top bar's create action is how you start.
 * In the middle of the space under the top bar on every screen: sticky `top-1/2` holds it at the
 * middle of the scrolling area. `min-h-[60vh]` makes its box reach past the middle even when what
 * wraps it doesn't fill the screen (that left it high on some screens). When controls above reach
 * past the middle, it sits just below them.
 */
export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
	return (
		<div className="flex min-h-[60vh] flex-1 flex-col items-center pt-24">
			<div className="sticky top-1/2 flex max-w-xs -translate-y-1/2 flex-col items-center gap-2 py-8 text-center text-balance">
				<span aria-hidden="true" className="mb-2 text-[32px] text-neutral-400">{icon}</span>
				<h2 className="text-base font-medium">{title}</h2>
				<p className={descriptionClass}>{children}</p>
			</div>
		</div>
	);
}

/** A filtered or searched list with nothing left: the same empty state as an empty screen. The filters' own controls undo them. */
export function NoMatches() {
	return (
		<EmptyState icon={<SearchIcon />} title="No matches">
			Nothing fits this search or filter. Change or clear it to see more.
		</EmptyState>
	);
}

/** A screen for one item: loading while `loaded` is false, then an empty state saying it's gone. */
export function NotFound({ crumbs, loaded, icon, title, children = "It may have been archived. Check Archive." }: { crumbs?: Crumb[]; loaded: boolean; icon: React.ReactNode; title: string; children?: string }) {
	return (
		<Page title={loaded ? "Not found" : ""} crumbs={crumbs}>
			{loaded ? <EmptyState icon={icon} title={title}>{children}</EmptyState> : <Loading />}
		</Page>
	);
}

/** Placeholder shown only on first load; later visits come from the cache. */
export function Loading() {
	return (
		<div className="mx-auto flex w-full max-w-2xl animate-pulse flex-col gap-3 px-6 pt-page-top pb-10">
			<div className="h-4 w-1/3 rounded bg-neutral-100" />
			<div className="h-4 w-2/3 rounded bg-neutral-100" />
			<div className="h-4 w-1/2 rounded bg-neutral-100" />
		</div>
	);
}

/** An error in red. Renders nothing without one, so pass it straight in. */
export function Notice({ children }: { children: React.ReactNode }) {
	if (!children) return null;
	return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p>;
}

/**
 * A name edited in place, where it's shown (a sidebar row, a tab), as in Finder or Figma: it opens
 * with the text selected; Enter, clicking away, a navigation shortcut or a rail click saves; Escape puts it back. A blank or unchanged
 * name saves nothing. While a save runs it shows the new name as plain text, and `onDone` closes it
 * once the save settles: Convex resolves a mutation after the screen's queries include it, so the
 * new name never flashes back to the old one. `className` sizes and pads it so its text sits where
 * the name did.
 */
export function RenameInput({ value, onSave, onDone, className = "" }: { value: string; onSave: (name: string) => Promise<unknown>; onDone: () => void; className?: string }) {
	const [draft, setDraft] = useState(value);
	const [saving, setSaving] = useState(false);
	// Enter closes it, and closing blurs it: only the first finish counts.
	const finished = useRef(false);
	const finish = (save: boolean) => {
		if (finished.current) return;
		finished.current = true;
		const name = draft.trim();
		if (!save || !name || name === value) return onDone();
		setDraft(name);
		setSaving(true);
		void onSave(name).finally(onDone);
	};
	return (
		<input
			autoFocus
			readOnly={saving}
			value={draft}
			maxLength={120}
			aria-label="Name"
			onChange={(e) => setDraft(e.target.value)}
			onFocus={(e) => e.currentTarget.select()}
			onBlur={() => finish(true)}
			onKeyDown={(e) => {
				if (e.key === "Enter") finish(true);
				else if (e.key === "Escape") (e.stopPropagation(), finish(false));
			}}
			className={`min-w-0 rounded-md outline-1 -outline-offset-1 ${saving ? "outline-transparent" : "bg-white outline-neutral-300 focus:outline-neutral-400"} ${className}`}
		/>
	);
}

/** Shows a query's error in place of what failed, plainly. Remount (new `key`) to try again. */
/** Shows a render error as a notice. A new `resetKey` (the query that failed changed) tries again, without remounting. */
export class ErrorBoundary extends Component<{ children: React.ReactNode; resetKey?: string }, { error?: unknown }> {
	state: { error?: unknown } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	componentDidUpdate(before: { resetKey?: string }) {
		if (before.resetKey !== this.props.resetKey && this.state.error !== undefined) this.setState({ error: undefined });
	}
	render() {
		return this.state.error !== undefined ? <Notice>{errorMessage(this.state.error)}</Notice> : this.props.children;
	}
}

/**
 * Runs a mutation and keeps its error message for display. `busy` while it runs.
 * `fail` shows an error from anywhere else (no argument clears it); `message` words errors.
 */
export function useRun(message: (e: unknown) => string = errorMessage) {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const fail = (e?: unknown) => setError(e === undefined ? undefined : message(e));
	const run = (action: Promise<unknown>, then?: () => void) => {
		setBusy(true);
		return action
			.then(() => (setError(undefined), then?.()), fail)
			.finally(() => setBusy(false));
	};
	return { error, busy, run, fail };
}

/** Local state over a live value: starts as `value` and starts over whenever `value` changes. */
export function useSynced<T>(value: T) {
	const [state, setState] = useState(value);
	const [synced, setSynced] = useState(value);
	if (!Object.is(synced, value)) (setSynced(value), setState(value));
	return [state, setState] as const;
}

/** A panel's width, kept per computer under `key` (localStorage) within `min`…`max`, with `fallback` until you set one. */
export function useStoredWidth(key: string, fallback: number, min: number, max: number) {
	const clamp = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
	const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem(key)) || fallback));
	const save = useCallback(
		(w: number) => {
			const next = clamp(w);
			setWidth(next);
			try {
				localStorage.setItem(key, String(next));
			} catch {
				// Storage may be unavailable; it still holds until reload.
			}
		},
		[key, clamp],
	);
	return { width, min, max, fallback, preview: useCallback((w: number) => setWidth(clamp(w)), [clamp]), save };
}

/**
 * A panel's resizable edge (`side`: which edge of the panel it is). Drag it; double-click for
 * the default; arrow keys when focused. Only the release is saved. The panel needs `relative`.
 */
export function ResizeHandle({ side, label, size, guide }: {
	side: "left" | "right";
	label: string;
	size: ReturnType<typeof useStoredWidth>;
	/** Its line runs on down past the handle, clipped by whatever clips it: a table column's edge, all rows long. */
	guide?: boolean;
}) {
	const start = useRef<{ x: number; width: number } | null>(null);
	const sign = side === "right" ? 1 : -1;
	const at = (e: React.PointerEvent) => start.current!.width + sign * (e.clientX - start.current!.x);
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={size.width}
			aria-valuemin={size.min}
			aria-valuemax={size.max}
			tabIndex={0}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				start.current = { x: e.clientX, width: size.width };
			}}
			onPointerMove={(e) => start.current && size.preview(at(e))}
			onPointerUp={(e) => {
				if (!start.current) return;
				size.save(at(e));
				start.current = null;
			}}
			// The OS or a gesture can cancel a drag without a pointerup; keep what was previewed and stop following the mouse.
			onPointerCancel={() => start.current && ((start.current = null), size.save(size.width))}
			onDoubleClick={() => size.save(size.fallback)}
			onKeyDown={(e) => {
				if (e.key === "ArrowLeft" || e.key === "ArrowRight") (e.preventDefault(), size.save(size.width + sign * (e.key === "ArrowLeft" ? -16 : 16)));
			}}
			className={`no-drag absolute inset-y-0 z-40 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:rounded-full after:bg-neutral-400 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:outline-none focus-visible:after:opacity-100 active:after:opacity-100 ${guide ? "after:pointer-events-none after:h-screen" : ""} ${side === "right" ? "-right-1" : "-left-1"}`}
		/>
	);
}

/**
 * The time, rounded down to 5 minutes and updated as it passes: an argument for a query that depends
 * on the clock (a Convex query re-runs when its arguments change, never on the clock alone).
 */
export function useClock(stepMs = 5 * 60_000) {
	const now = () => Math.floor(Date.now() / stepMs) * stepMs;
	const [time, setTime] = useState(now);
	useEffect(() => {
		const timer = setInterval(() => setTime(now()), 15_000);
		return () => clearInterval(timer);
	}, [stepMs]);
	return time;
}

/** `value`, once it has stopped changing for `ms`: for searches that query as you type. */
export function useDebounced<T>(value: T, ms = 250) {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/**
 * An edit form over shared, live data. You edit a private draft; the saved value keeps
 * updating underneath. If someone else saves while you're editing, `stale` turns true so
 * the form can ask whose change wins. Saves send `base`, and the server refuses stale ones.
 */
const formDrafts = new Map<string, { value: unknown; base: number }>();
const draftListeners = new Set<() => void>();
let draftPerson: string | null = null;
/** Called at the app boundary, including when no form is open. */
export function setFormDraftPerson(person: string | null) {
	if (person === draftPerson) return;
	draftPerson = person;
	formDrafts.clear();
	draftListeners.forEach((listener) => listener());
}
const subscribeDrafts = (listener: () => void) => {
	draftListeners.add(listener);
	return () => { draftListeners.delete(listener); };
};
/** A version for `useDraft` from a value with none of its own (a role, your preferences): changes when it does. */
export const versionOf = (value: unknown) => [...JSON.stringify(value)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);

export function useDraft<T>(key: string, saved: T, version: number) {
	const me = useQuery(api.workspace.me);
	const workspace = useWorkspace();
	const scoped = me ? JSON.stringify([me.userId, workspace?.id, key]) : null;
	const draft = useSyncExternalStore(subscribeDrafts, () => scoped ? formDrafts.get(scoped) : undefined) as { value: T; base: number } | undefined;
	const setDraft = (next: { value: T; base: number } | null) => {
		if (!scoped) return;
		if (next) formDrafts.set(scoped, next); else formDrafts.delete(scoped);
		draftListeners.forEach((listener) => listener());
	};
	return {
		value: draft ? draft.value : saved,
		set: (value: T) => setDraft({ value, base: draft?.base ?? version }),
		dirty: draft !== undefined,
		stale: draft !== undefined && draft.base !== version,
		base: draft?.base ?? version,
		discard: () => setDraft(null),
		/** Overwrite their change on the next save. */
		keepMine: () => draft && setDraft({ ...draft, base: version }),
	};
}

/** Shows only while `draft` is stale: asks whose change wins. */
export function ConflictNotice({ draft, who }: { draft: { stale: boolean; discard: () => void; keepMine: () => void }; who?: string }) {
	if (!draft.stale) return null;
	return (
		<div className="flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<p className="flex-1">{who || "Someone"} saved a change while you were editing.</p>
			<button type="button" onClick={draft.discard} className={compactButton}>
				Use theirs
			</button>
			<button type="button" onClick={draft.keepMine} className={compactButton}>
				Keep mine
			</button>
		</div>
	);
}

/** Buttons for the page's top bar, from anywhere in its content (a tab inside Settings, say). */
export function PageActions({ children }: { children: React.ReactNode }) {
	const slot = useContext(actionSlot);
	return slot ? createPortal(children, slot) : null;
}

/** Discard and Save in the page's top bar; both off until something changed. `canSave` false holds Save (an unresolved conflict). */
export function SaveBar({ dirty, canSave = true, onSave, onDiscard }: { dirty: boolean; canSave?: boolean; onSave: () => void; onDiscard: () => void }) {
	return (
		<PageActions>
			<button type="button" disabled={!dirty} onClick={onDiscard} className={compactButton}>
				Discard
			</button>
			<button type="button" disabled={!dirty || !canSave} onClick={onSave} className={compactPrimaryButton}>
				Save
			</button>
		</PageActions>
	);
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(ms: number) {
	const seconds = (ms - Date.now()) / 1000;
	for (const [unit, size] of [
		["day", 86400],
		["hour", 3600],
		["minute", 60],
	] as const) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

export function LoadMore({ status, onMore }: { status: string; onMore: () => void }) {
	if (status === "LoadingMore") return <p className={`text-center ${metadataClass}`}>Loading…</p>;
	if (status !== "CanLoadMore") return null;
	return (
		<button type="button" onClick={onMore} className={`self-center ${compactButton}`}>
			<CaretDownIcon /> Load more
		</button>
	);
}
