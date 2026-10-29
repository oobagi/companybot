import { Component, Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "./api";
import { PlusIcon } from "./icons";
import { navigate } from "./router";
import type { DragProps } from "./sortable";
import { Popover } from "./views/chat/common";

/**
 * The name (and shortcut) of whatever's hovered, at once: a title waits a second and can't be
 * styled. Spread `tipFor(label, hint)` on the thing, and render `tip` anywhere. `right` clears
 * the workspace rail's edge; `below` hangs under a title bar button.
 */
export function useTip(side: "right" | "below") {
	const [at, setAt] = useState<{ label: string; hint?: string; left: number; top: number }>();
	const hide = () => setAt(undefined);
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
	return (
		<header className="drag flex h-12 shrink-0 items-center gap-3 px-5">
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
 */
export function Scroll({
	ref,
	header,
	footer,
	className = "",
	onScroll,
	children,
}: {
	ref?: React.RefObject<HTMLDivElement | null>;
	header?: React.ReactNode;
	footer?: React.ReactNode;
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
	return (
		<div ref={scroller} onScroll={(e) => (measure(), onScroll?.(e))} className={`min-h-0 flex-1 overflow-y-auto ${className}`}>
			<div className="flex min-h-full flex-col">
				{header && (
					<div className="scrim-top sticky top-0 z-30" data-under={underTop || undefined}>
						{header}
					</div>
				)}
				<div className="flex flex-1 flex-col">{children}</div>
				{footer && (
					<div className="scrim-bottom sticky bottom-0 z-30" data-under={underBottom || undefined}>
						{footer}
					</div>
				)}
			</div>
		</div>
	);
}

/** The page's top-bar spot for `PageActions`. */
const actionSlot = createContext<HTMLElement | null>(null);

/**
 * A screen: the top bar, then its content. The title lives in the top bar; `heading` is
 * a big title in the content, only for things you write in and rename there (pages, records).
 * `description` sits next to the title in the top bar; `actions` go on its right. `wide` for tables.
 */
export function Page({
	title,
	crumbs,
	heading,
	description,
	actions,
	wide,
	children,
}: {
	title: string;
	crumbs?: Crumb[];
	heading?: React.ReactNode;
	description?: string;
	actions?: React.ReactNode;
	wide?: boolean;
	children: React.ReactNode;
}) {
	// Where `PageActions` from the content land, after `actions`.
	const [slot, setSlot] = useState<HTMLElement | null>(null);
	return (
		<Scroll
			className="@container"
			header={
				<TopBar crumbs={crumbs} title={<span className="truncate">{title}</span>} description={description}>
					{actions}
					<span ref={setSlot} className="contents" />
				</TopBar>
			}
		>
			<actionSlot.Provider value={slot}>
				{/* `--bleed`: from the column's content out to the screen's edge, for `.bleed`. */}
				<div
					className={`mx-auto flex w-full flex-1 flex-col gap-6 px-6 pt-8 pb-10 ${
						wide ? "max-w-5xl [--bleed:max(1.5rem,calc((100cqw-64rem)/2+1.5rem))]" : "max-w-2xl [--bleed:max(1.5rem,calc((100cqw-42rem)/2+1.5rem))]"
					}`}
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
	menu,
	drag,
	children,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (tab: T) => void;
	/** From `useSortable(…, "x")`, for tabs that can be dragged into another order. */
	drag?: (tab: T) => DragProps | undefined;
	/** The open tab's menu, like Notion's view menu: clicking the open tab again opens it. */
	menu?: (close: () => void) => React.ReactNode;
	/** Extra controls after the last tab. */
	children?: React.ReactNode;
}) {
	const tabClass = (open: boolean) =>
		`-mb-px max-w-full truncate border-b-2 px-3 py-2 text-sm ${open ? "border-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-800"}`;
	return (
		<nav className="flex flex-wrap gap-1 border-b border-neutral-200">
			{tabs.map((t) => {
				const d = drag?.(t.id);
				return (
					<span key={t.id} {...d} className={`relative flex max-w-full ${d?.className ?? ""}`}>
						{t.id === value && menu ? (
							<Popover trigger={t.label} className={tabClass(true)} panelClassName="w-60 p-1">
								{menu}
							</Popover>
						) : (
							<button type="button" onClick={() => onChange(t.id)} className={tabClass(t.id === value)}>
								{t.label}
							</button>
						)}
					</span>
				);
			})}
			{children}
		</nav>
	);
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div>
				<h2 className="font-medium">{title}</h2>
				{hint && <p className={descriptionClass}>{hint}</p>}
			</div>
			{children}
		</section>
	);
}

/**
 * Settings, one per row in a card: what it is and a one-line hint on the left, its
 * control on the right. Every settings screen uses it, so labels and controls line up.
 */
export function Settings({ title, hint, children }: { title?: string; hint?: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			{(title || hint) && (
				<div>
					{title && <h2 className="font-medium">{title}</h2>}
					{hint && <p className={descriptionClass}>{hint}</p>}
				</div>
			)}
			<div className={listClass}>{children}</div>
		</section>
	);
}

export function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-6 px-4 py-3">
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{label}</p>
				{hint && <p className="text-xs text-neutral-500">{hint}</p>}
			</div>
			<div className="flex shrink-0 items-center gap-2 text-sm">{children}</div>
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1.5">
			<span className="text-sm font-medium">{label}</span>
			{children}
			{hint && <span className="text-xs text-neutral-500">{hint}</span>}
		</label>
	);
}

export const disabledButtonClass = "disabled:opacity-50";
const controlClass = "border border-neutral-200 focus:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:bg-neutral-50 disabled:text-neutral-500";
export const inputClass = `rounded-xl px-3 py-2 ${controlClass}`;
export const compactControlClass = `rounded-lg px-2.5 py-1 text-sm ${controlClass}`;
/** A toolbar button beside compact controls (Filter, Properties): the same box, no fill. */
export const compactButton = `inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-sm text-neutral-700 hover:bg-neutral-50 ${disabledButtonClass}`;
/** Submits a row of compact controls (Invite, Add, Save): their box, filled. */
export const compactPrimaryButton = `rounded-lg border border-neutral-900 bg-neutral-900 px-2.5 py-1 text-sm text-white hover:bg-neutral-700 ${disabledButtonClass}`;
export const primaryButton = `rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white ${disabledButtonClass}`;
export const dangerButton = `rounded-xl bg-red-600 px-4 py-2 text-sm text-white ${disabledButtonClass}`;
export const secondaryButton = `rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 ${disabledButtonClass}`;
/** Buttons in the top bar: quiet ones, and the create action (`NewButton`). */
export const barButton = `flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 ${disabledButtonClass}`;
export const barDangerButton = `flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-neutral-600 hover:bg-red-50 hover:text-red-700 ${disabledButtonClass}`;
const barPrimaryButton = `flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 ${disabledButtonClass}`;
export const descriptionClass = "text-sm text-neutral-500";
export const metadataClass = "text-xs text-neutral-400";
/** Quiet text in place of content: nothing here yet, loading. */
export const hintClass = "text-sm text-neutral-400";
/** One item as a bordered box: an entry, a rule, a member. */
export const cardClass = "rounded-xl border border-neutral-200 px-4 py-3";
/** Rows in one bordered box, split by lines. */
export const listClass = "flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200";
/**
 * The row of compact controls atop a screen's content: search and filters, or a one-line add
 * form (`Form className`). One class so every screen's row has the same height and spacing.
 */
export const toolbarClass = "flex flex-wrap items-center gap-2 text-sm";
/** A compact control in a screen's toolbar or a settings row: search boxes, pickers. */
export const wideControlClass = `${compactControlClass} w-64`;

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
 * In the middle of the space under the top bar on every screen, however much sits above it:
 * sticky `top-1/2` brings it down to the middle; when the controls above reach past that,
 * it stays just below them.
 */
export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-1 flex-col items-center pt-24">
			<div className="sticky top-1/2 flex -translate-y-1/2 flex-col items-center gap-2 py-8 text-center">
				<span aria-hidden="true" className="mb-2 text-[32px] text-neutral-400">{icon}</span>
				<h2 className="text-base font-medium">{title}</h2>
				<p className={descriptionClass}>{children}</p>
			</div>
		</div>
	);
}

/** A filtered list with nothing left. The filters' own controls undo them. */
export function NoMatches() {
	return <p className="py-8 text-center text-sm text-neutral-500">No matches</p>;
}

/** A screen for one item: loading while `loaded` is false, then an empty state saying it's gone. */
export function NotFound({ crumbs, loaded, icon, title, children = "It may have been deleted. Check Trash." }: { crumbs?: Crumb[]; loaded: boolean; icon: React.ReactNode; title: string; children?: string }) {
	return (
		<Page title={loaded ? "Not found" : ""} crumbs={crumbs}>
			{loaded ? <EmptyState icon={icon} title={title}>{children}</EmptyState> : <Loading />}
		</Page>
	);
}

/** Placeholder shown only on first load; later visits come from the cache. */
export function Loading() {
	return (
		<div className="mx-auto flex w-full max-w-2xl animate-pulse flex-col gap-3 px-6 py-10">
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

/** Shows a query's error in place of what failed, plainly. Remount (new `key`) to try again. */
export class ErrorBoundary extends Component<{ children: React.ReactNode }, { error?: unknown }> {
	state: { error?: unknown } = {};
	static getDerivedStateFromError(error: unknown) {
		return { error };
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
export function ResizeHandle({ side, label, size }: { side: "left" | "right"; label: string; size: ReturnType<typeof useStoredWidth> }) {
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
			className={`no-drag absolute inset-y-0 z-40 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:rounded-full after:bg-neutral-400 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:outline-none focus-visible:after:opacity-100 active:after:opacity-100 ${side === "right" ? "-right-1" : "-left-1"}`}
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
export function useDraft<T>(saved: T, version: number) {
	const [draft, setDraft] = useState<{ value: T; base: number } | null>(null);
	return {
		value: draft?.value ?? saved,
		set: (value: T) => setDraft({ value, base: draft?.base ?? version }),
		dirty: draft !== null,
		stale: draft !== null && draft.base !== version,
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
			<button type="button" onClick={draft.discard} className="font-medium hover:underline">
				Use theirs
			</button>
			<button type="button" onClick={draft.keepMine} className="font-medium hover:underline">
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

/** Discard and Save in the page's top bar; both off until something changed. */
export function SaveBar({ dirty, onSave, onDiscard }: { dirty: boolean; onSave: () => void; onDiscard: () => void }) {
	return (
		<PageActions>
			<button type="button" disabled={!dirty} onClick={onDiscard} className={barButton}>
				Discard
			</button>
			<button type="button" disabled={!dirty} onClick={onSave} className={compactPrimaryButton}>
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
		<button type="button" onClick={onMore} className={`self-center ${metadataClass} hover:text-neutral-700`}>
			Load more
		</button>
	);
}
