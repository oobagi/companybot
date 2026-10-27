import { Component, Fragment, useCallback, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import { CaretRightIcon } from "./icons";
import { navigate } from "./router";

/** A screen above this one, in the top bar's trail. */
export type Crumb = { label: string; to: string[] };

/**
 * The bar across the top of every screen, chat included: where you are on the left
 * (each screen above it is a link back), what you can do here on the right. It's also
 * where you drag the window.
 */
export function TopBar({ crumbs = [], title, children }: { crumbs?: Crumb[]; title: React.ReactNode; children?: React.ReactNode }) {
	return (
		<header className="drag flex h-12 shrink-0 items-center gap-3 px-5">
			<nav className="flex min-w-0 items-center gap-1 text-sm">
				{crumbs.map((c) => (
					<Fragment key={c.label}>
						<button type="button" onClick={() => navigate(...c.to)} className="no-drag shrink-0 rounded-md px-1 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">
							{c.label}
						</button>
						<CaretRightIcon className="shrink-0 text-neutral-300" />
					</Fragment>
				))}
				<div className="flex min-w-0 items-baseline gap-2 px-1 font-semibold">{title}</div>
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

/**
 * A screen: the top bar, then its content. The title lives in the top bar; `heading` is
 * a big title in the content, only for things you write in and rename there (pages, records).
 * `actions` go on the right of the top bar. `wide` for tables.
 */
export function Page({
	title,
	crumbs,
	heading,
	subtitle,
	actions,
	wide,
	children,
}: {
	title: string;
	crumbs?: Crumb[];
	heading?: React.ReactNode;
	subtitle?: string;
	actions?: React.ReactNode;
	wide?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Scroll
			className="@container"
			header={
				<TopBar crumbs={crumbs} title={<span className="truncate">{title}</span>}>
					{actions}
				</TopBar>
			}
		>
			{/* `--bleed`: from the column's content out to the screen's edge, for `.bleed`. */}
			<div
				className={`mx-auto flex w-full flex-col gap-6 px-6 pt-8 pb-10 ${
					wide ? "max-w-5xl [--bleed:max(1.5rem,calc((100cqw-64rem)/2+1.5rem))]" : "max-w-2xl [--bleed:max(1.5rem,calc((100cqw-42rem)/2+1.5rem))]"
				}`}
			>
				{(heading || subtitle) && (
					<header className="flex flex-col gap-1">
						{heading && <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>}
						{subtitle && <p className={descriptionClass}>{subtitle}</p>}
					</header>
				)}
				{children}
			</div>
		</Scroll>
	);
}

export function Tabs<T extends string>({
	tabs,
	value,
	onChange,
	children,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (tab: T) => void;
	/** Extra controls after the last tab. */
	children?: React.ReactNode;
}) {
	return (
		<nav className="flex flex-wrap gap-1 border-b border-neutral-200">
			{tabs.map((t) => (
				<button
					type="button"
					key={t.id}
					onClick={() => onChange(t.id)}
					className={`-mb-px max-w-full truncate border-b-2 px-3 py-2 text-sm ${
						t.id === value ? "border-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-800"
					}`}
				>
					{t.label}
				</button>
			))}
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
			<div className="flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200">{children}</div>
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1.5">
			<span className="text-sm font-medium">{label}</span>
			{children}
			{hint && <span className="text-xs text-neutral-500">{hint}</span>}
		</label>
	);
}

const controlClass = "border border-neutral-200 focus:border-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:bg-neutral-50 disabled:text-neutral-500";
export const inputClass = `rounded-xl px-3 py-2 ${controlClass}`;
export const compactControlClass = `rounded-lg px-2 py-1 text-sm ${controlClass}`;
export const disabledButtonClass = "disabled:opacity-50";
export const primaryButton = `rounded-xl bg-neutral-900 px-4 py-2 text-sm text-white ${disabledButtonClass}`;
export const dangerButton = `rounded-xl bg-red-600 px-4 py-2 text-sm text-white ${disabledButtonClass}`;
export const secondaryButton = `rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 ${disabledButtonClass}`;
/** Buttons in the top bar: quiet ones, and the one main action. */
export const barButton = `flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 ${disabledButtonClass}`;
export const barDangerButton = `flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-neutral-600 hover:bg-red-50 hover:text-red-700 ${disabledButtonClass}`;
export const barPrimaryButton = `flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 ${disabledButtonClass}`;
export const descriptionClass = "text-sm text-neutral-500";
export const metadataClass = "text-xs text-neutral-400";

/** A screen for one item: loading while `loaded` is false, then `children` says why it's gone. */
export function NotFound({ crumbs, loaded, children }: { crumbs?: Crumb[]; loaded: boolean; children?: React.ReactNode }) {
	return (
		<Page title={loaded ? "Not found" : ""} crumbs={crumbs}>
			{loaded ? <p className={descriptionClass}>{children}</p> : <Loading />}
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

export function Notice({ children }: { children: React.ReactNode }) {
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

/** Runs a mutation and keeps its error message for display. `busy` while it runs. */
export function useRun() {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = (action: Promise<unknown>, then?: () => void) => {
		setBusy(true);
		return action
			.then(
				() => (setError(undefined), then?.()),
				(e) => setError(errorMessage(e)),
			)
			.finally(() => setBusy(false));
	};
	return { error, busy, run };
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

export function ConflictNotice({ who, onDiscard, onKeep }: { who?: string; onDiscard: () => void; onKeep: () => void }) {
	return (
		<div className="flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
			<p className="flex-1">{who || "Someone"} saved a change while you were editing.</p>
			<button type="button" onClick={onDiscard} className="font-medium hover:underline">
				Use theirs
			</button>
			<button type="button" onClick={onKeep} className="font-medium hover:underline">
				Keep mine
			</button>
		</div>
	);
}

export function SaveBar({ onSave, onDiscard }: { onSave: () => void; onDiscard: () => void }) {
	return (
		<div className="sticky bottom-4 flex justify-end gap-2 rounded-2xl border border-neutral-200 bg-white/90 p-2 shadow-sm backdrop-blur">
			<button type="button" onClick={onDiscard} className={secondaryButton}>
				Discard
			</button>
			<button type="button" onClick={onSave} className={primaryButton}>
				Save
			</button>
		</div>
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
