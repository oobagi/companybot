import { Component, useState } from "react";
import { errorMessage } from "./api";
import { navigate } from "./router";

/**
 * A screen. `back` makes it a pushed screen: a link back to the one it came from.
 * `actions` sit on the right of the title. `wide` for tables.
 */
export function Page({
	title,
	subtitle,
	back,
	actions,
	wide,
	children,
}: {
	title: string;
	subtitle?: string;
	back?: { label: string; to: string[] };
	actions?: React.ReactNode;
	wide?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div className="flex-1 overflow-y-auto">
			<div className={`mx-auto flex flex-col gap-6 px-6 py-10 ${wide ? "max-w-5xl" : "max-w-2xl"}`}>
				<header className="flex flex-col gap-3">
					{back && (
						<button
							type="button"
							onClick={() => navigate(...back.to)}
							className="self-start text-sm text-neutral-500 hover:text-neutral-900"
						>
							← {back.label}
						</button>
					)}
					<div className="flex items-start justify-between gap-4">
						<div>
							<h1 className="text-xl font-medium">{title}</h1>
							{subtitle && <p className={descriptionClass}>{subtitle}</p>}
						</div>
						{actions}
					</div>
				</header>
				{children}
			</div>
		</div>
	);
}

export function Tabs<T extends string>({
	tabs,
	value,
	onChange,
}: {
	tabs: readonly { id: T; label: string }[];
	value: T;
	onChange: (tab: T) => void;
}) {
	return (
		<nav className="-mt-2 flex gap-1 border-b border-neutral-200">
			{tabs.map((t) => (
				<button
					type="button"
					key={t.id}
					onClick={() => onChange(t.id)}
					className={`-mb-px border-b-2 px-3 py-2 text-sm ${
						t.id === value ? "border-neutral-900 font-medium" : "border-transparent text-neutral-500 hover:text-neutral-800"
					}`}
				>
					{t.label}
				</button>
			))}
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
export const descriptionClass = "text-sm text-neutral-500";
export const metadataClass = "text-xs text-neutral-400";

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

/** Runs a mutation and keeps its error message for display. */
export function useRun() {
	const [error, setError] = useState<string>();
	const run = (action: Promise<unknown>, then?: () => void) =>
		action.then(
			() => (setError(undefined), then?.()),
			(e) => setError(errorMessage(e)),
		);
	return { error, run };
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
