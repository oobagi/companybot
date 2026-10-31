import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, PlusIcon } from "../../icons";
import { Notice, dangerButton, primaryButton, secondaryButton, useRun } from "../../ui";
import { EmojiPanel } from "./EmojiPanel";

const initials = (name: string) =>
	name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join("") || "?";

const sizes = { xs: "size-5 text-[10px]", row: "size-[22px] text-[10px]", sm: "size-6 text-[11px]", md: "size-9 text-sm", lg: "size-14 text-lg" };

/**
 * A person's photo, an agent's picture or a workspace's logo, cropped to fit; initials until
 * there is one (or if it won't load). People are round; agents and workspaces are rounded
 * squares. `className` adds to it (a ring, in a stack).
 */
export function Avatar({
	name,
	image,
	agent,
	size = "md",
	className = "",
}: {
	name: string;
	image?: string | null;
	agent?: boolean;
	size?: keyof typeof sizes;
	className?: string;
}) {
	const [broken, setBroken] = useState<string>();
	const shape = `shrink-0 ${sizes[size]} ${agent ? "rounded-md" : "rounded-full"} ${className}`;
	if (image && broken !== image) return <img src={image} alt={name} title={name} onError={() => setBroken(image)} className={`object-cover ${shape}`} />;
	return (
		<span
			title={name}
			className={`flex items-center justify-center font-medium select-none ${shape} ${agent ? "bg-neutral-800 text-white" : "bg-neutral-200 text-neutral-600"}`}
		>
			{initials(name)}
		</span>
	);
}

export function AvatarStack({ people, size = "sm" }: { people: { name: string; type: string; image?: string | null }[]; size?: keyof typeof sizes }) {
	return (
		<span className="flex -space-x-1">
			{/* The ring is on the avatar itself, so it follows its shape: round for people, square for agents. */}
			{people.slice(0, 3).map((p, i) => (
				<Avatar key={i} name={p.name} image={p.image} agent={p.type === "agent"} size={size} className="ring-2 ring-white" />
			))}
		</span>
	);
}

/** Next to an agent's name wherever it's listed with people. */
export function AgentBadge() {
	return <span className="shrink-0 rounded bg-neutral-200/70 px-1 py-px text-[10px] leading-tight font-medium text-neutral-500 uppercase">Bot</span>;
}

/** What's open that a click outside or Escape closes, oldest first. Only the newest one closes. */
const layers: object[] = [];

/**
 * Calls `onClose` on a click outside `ref` or on Escape, when it's the newest open popover or
 * modal: Escape in a Confirm over a dialog closes just the Confirm. A popover's panel lives at
 * the end of the page, outside whatever opened it, so a click in one counts as inside.
 */
export function useDismiss<T extends HTMLElement>(onClose: () => void, active = true, ignore?: React.RefObject<HTMLElement | null>) {
	const ref = useRef<T>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (!active) return;
		const layer = {};
		layers.push(layer);
		const newest = () => layers.at(-1) === layer;
		const down = (e: MouseEvent) => {
			const target = e.target as Element;
			if (newest() && ref.current && !ref.current.contains(target) && !ignore?.current?.contains(target) && !target.closest?.("[data-popover]")) close.current();
		};
		const key = (e: KeyboardEvent) => e.key === "Escape" && newest() && close.current();
		document.addEventListener("mousedown", down);
		document.addEventListener("keydown", key);
		return () => {
			layers.splice(layers.indexOf(layer), 1);
			document.removeEventListener("mousedown", down);
			document.removeEventListener("keydown", key);
		};
	}, [active, ignore]);
	return ref;
}

const EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"];

/** The quick row of reactions, and "more" for the full picker. */
export function EmojiPicker({ onPick, onClose, className = "" }: { onPick: (emoji: string) => void; onClose: () => void; className?: string }) {
	return (
		<div className={`z-20 flex gap-0.5 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg ${className}`}>
			{EMOJI.map((e) => (
				<button
					type="button"
					key={e}
					onClick={() => (onPick(e), onClose())}
					className="flex size-8 items-center justify-center rounded-lg text-lg hover:bg-neutral-100"
				>
					{e}
				</button>
			))}
			<Popover trigger={<PlusIcon />} label="More emoji" className="flex size-8 items-center justify-center rounded-lg text-base text-neutral-500 hover:bg-neutral-100" panelClassName="w-auto">
				{(close) => <EmojiPanel onPick={(e) => (onPick(e), close(), onClose())} />}
			</Popover>
		</div>
	);
}

/**
 * `wide` for side-by-side content (page history). At the end of the page, like a popover's
 * panel, so it can open from anywhere (a menu, another dialog) and still take the mouse.
 */
export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
	const ref = useDismiss<HTMLDivElement>(onClose);
	const titleId = useId();
	useLayoutEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const panel = ref.current;
		if (panel && !panel.contains(document.activeElement)) (panel.querySelector<HTMLElement>("input, textarea, button") ?? panel).focus();
		return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
	}, []);
	return createPortal(
		<div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/20 p-6 text-[15px] text-neutral-900">
			<div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(event) => {
				if (event.key !== "Tab") return;
				const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')];
				const next = event.shiftKey ? targets.at(-1) : targets[0];
				if (document.activeElement === (event.shiftKey ? targets[0] : targets.at(-1))) { event.preventDefault(); next?.focus(); }
			}} className={`flex max-h-[85vh] w-full ${wide ? "max-w-4xl" : "max-w-md"} flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl`}>
				<header className="flex items-center justify-between">
					<h2 id={titleId} className="text-lg font-medium">{title}</h2>
					<IconButton label="Close" onClick={onClose}>
						<CloseIcon />
					</IconButton>
				</header>
				{children}
			</div>
		</div>,
		document.body,
	);
}

/** A square button holding only an icon; `label` is its tooltip and accessible name. */
export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			className="no-drag flex size-7 items-center justify-center rounded-md text-base text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
		>
			{children}
		</button>
	);
}

/** Invisible while it measures, but focusable, so a field in it can take focus as it opens. */
const measuring: React.CSSProperties = { opacity: 0, pointerEvents: "none" };

/**
 * A small panel that opens from the thing you clicked: profile cards, menus, details.
 * It sits below its button, or above when there's no room, and stays inside the window.
 * A click outside or Escape closes it. `children` can take `close`, for menus.
 */
export function Popover({
	trigger,
	label,
	disabled,
	matchWidth,
	className = "",
	panelClassName,
	children,
}: {
	/** What you click. */
	trigger: React.ReactNode;
	/** Tooltip and accessible name for the button, when the trigger is only an icon or avatar. */
	label?: string;
	disabled?: boolean;
	/** The panel is at least as wide as the button, as for a picker. */
	matchWidth?: boolean;
	/** For the button. */
	className?: string;
	/** For the panel: its width, mostly. */
	panelClassName?: string;
	children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
	const [anchor, setAnchor] = useState<DOMRect>();
	const close = () => setAnchor(undefined);
	const button = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button
				ref={button}
				type="button"
				title={label}
				aria-label={label}
				aria-expanded={!!anchor}
				disabled={disabled}
				onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget.getBoundingClientRect()))}
				className={className}
			>
				{trigger}
			</button>
			{anchor && (
				<PopoverPanel anchor={anchor} ignore={button} matchWidth={matchWidth} className={panelClassName} onClose={close}>
					{typeof children === "function" ? children(close) : children}
				</PopoverPanel>
			)}
		</>
	);
}

/**
 * A Popover's panel on its own, placed by `anchor`: a button's box, or a point (a right-click).
 * A click outside or Escape closes it; a click on `ignore` (the button that toggles it) is left to that button.
 */
export function PopoverPanel({
	anchor,
	ignore,
	matchWidth,
	className = "w-72",
	onClose,
	children,
}: {
	anchor: DOMRect;
	ignore?: React.RefObject<HTMLElement | null>;
	matchWidth?: boolean;
	className?: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const panel = useDismiss<HTMLDivElement>(onClose, true, ignore);
	const [at, setAt] = useState<React.CSSProperties>(measuring);
	// Measure, then place: below if it fits, else above if it fits there, else on the roomier
	// side, shortened to fit (it scrolls). Never over its button; nudged in from the window's edges.
	useLayoutEffect(() => {
		const el = panel.current;
		if (!el) return;
		const place = () => {
			const { width } = el.getBoundingClientRect();
			// Use the full content height: the current height may already be capped on the wrong side.
			const height = Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, window.innerHeight * 0.7);
			const gap = 6;
			const roomBelow = window.innerHeight - 8 - anchor.bottom - gap;
			const roomAbove = anchor.top - gap - 8;
			const below = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
			const room = Math.max(0, below ? roomBelow : roomAbove);
			setAt({
				left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
				top: below ? anchor.bottom + gap : anchor.top - gap - Math.min(height, room),
				maxHeight: Math.min(room, window.innerHeight * 0.7),
				minWidth: matchWidth ? anchor.width : undefined,
			});
		};
		place();
		// Tool details load after opening. Reposition when that content replaces the loading line.
		const observer = new ResizeObserver(place);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		window.addEventListener("resize", place);
		return () => { observer.disconnect(); window.removeEventListener("resize", place); };
	}, [anchor, matchWidth, panel]);
	// At the end of the page: Electron lets a later window-drag area (a top bar) take the mouse
	// from anything drawn over it, so the panel has to come after them all.
	return createPortal(
		<div
			ref={panel}
			data-popover
			style={at}
			className={`no-drag fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-neutral-200 bg-white text-left text-sm font-normal text-neutral-900 shadow-lg ${className}`}
		>
			{children}
		</div>,
		document.body,
	);
}

/** A row in a popover menu. */
export function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${danger ? "text-red-600 hover:bg-red-50" : "hover:bg-neutral-100"}`}
		>
			{children}
		</button>
	);
}

/** A yes/no question: Cancel, or `action` (red when `danger`). */
export function Confirm(props: { title: string; action: string; danger?: boolean; busy?: boolean; error?: string; onConfirm: () => void; onClose: () => void; children?: React.ReactNode }) {
	return (
		<Modal title={props.title} onClose={props.onClose}>
			<div className="flex flex-col gap-4 text-sm">
				{props.children && <p className="text-neutral-600">{props.children}</p>}
				<Notice>{props.error}</Notice>
				<div className="flex justify-end gap-2">
					<button autoFocus type="button" disabled={props.busy} onClick={props.onClose} className={secondaryButton}>Cancel</button>
					<button type="button" disabled={props.busy} onClick={props.onConfirm} className={props.danger ? dangerButton : primaryButton}>{props.action}</button>
				</div>
			</div>
		</Modal>
	);
}

type Question = { title: string; action: string; danger?: boolean; body?: React.ReactNode; onConfirm: () => Promise<unknown> | void };

/** Archive keeps content until someone explicitly deletes it forever. */
export function archiveQuestion(name: string, onConfirm: Question["onConfirm"], effect?: string): Question {
	return { title: `Archive “${name}”?`, action: "Archive", danger: false, body: `${effect ? `${effect} ` : ""}This keeps its content in Archive. You can restore it at any time. Nothing is permanently deleted.`, onConfirm };
}

/**
 * The app's own confirm(), for destructive actions: `confirm({ title, action, onConfirm })` opens a
 * red Confirm that runs `onConfirm`, shows its error, and closes once it's done. Render `dialog`
 * anywhere; it shows at the end of the page, so it outlives the menu that asked.
 */
export function useConfirm() {
	const [open, setOpen] = useState<Question>();
	const pending = useRef(false);
	const { error, busy, run, fail } = useRun();
	const close = () => (fail(), setOpen(undefined));
	const dialog = open && (
		<Confirm
			title={open.title}
			action={open.action}
			danger={open.danger ?? true}
			busy={busy}
			error={error}
			onConfirm={() => {
				if (pending.current) return;
				pending.current = true;
				void run(Promise.resolve().then(open.onConfirm), () => setOpen(undefined)).finally(() => { pending.current = false; });
			}}
			onClose={() => { if (!pending.current) close(); }}
		>
			{open.body}
		</Confirm>
	);
	return { confirm: setOpen, dialog };
}

export const clock = (ms: number, timeZone?: string) => new Date(ms).toLocaleTimeString([], { timeZone, hour: "numeric", minute: "2-digit" });
/** "America/Los_Angeles" → "America/Los Angeles". */
export const zoneLabel = (zone: string) => zone.replaceAll("_", " ");
/** This computer's time zone, read fresh: it changes when you travel. */
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function dayLabel(ms: number) {
	const day = new Date(ms).toDateString();
	if (day === new Date().toDateString()) return "Today";
	if (day === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
	return new Date(ms).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
