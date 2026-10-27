import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CloseIcon } from "../../icons";

const initials = (name: string) =>
	name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join("") || "?";

const sizes = { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-9 text-xs" };

/** People are round; agents are rounded squares. `className` adds to it (a ring, in a stack). */
export function Avatar({ name, agent, size = "md", className = "" }: { name: string; agent?: boolean; size?: keyof typeof sizes; className?: string }) {
	return (
		<span
			title={name}
			className={`flex shrink-0 items-center justify-center font-medium select-none ${sizes[size]} ${
				agent ? "rounded-md bg-neutral-800 text-white" : "rounded-full bg-neutral-200 text-neutral-600"
			} ${className}`}
		>
			{initials(name)}
		</span>
	);
}

export function AvatarStack({ people, size = "sm" }: { people: { name: string; type: string }[]; size?: keyof typeof sizes }) {
	return (
		<span className="flex -space-x-1">
			{/* The ring is on the avatar itself, so it follows its shape: round for people, square for agents. */}
			{people.slice(0, 3).map((p, i) => (
				<Avatar key={i} name={p.name} agent={p.type === "agent"} size={size} className="ring-2 ring-white" />
			))}
		</span>
	);
}

/** Next to an agent's name wherever it's listed with people. */
export function AgentBadge() {
	return <span className="shrink-0 rounded bg-neutral-200/70 px-1 py-px text-[10px] leading-tight font-medium text-neutral-500 uppercase">Bot</span>;
}

/** Calls `onClose` on a click outside `ref` or on Escape. */
export function useDismiss<T extends HTMLElement>(onClose: () => void, active = true) {
	const ref = useRef<T>(null);
	const close = useRef(onClose);
	close.current = onClose;
	useEffect(() => {
		if (!active) return;
		const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close.current();
		const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
		document.addEventListener("mousedown", down);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", down);
			document.removeEventListener("keydown", key);
		};
	}, [active]);
	return ref;
}

const EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"];

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
		</div>
	);
}

/** `wide` for side-by-side content (page history). */
export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
	const ref = useDismiss<HTMLDivElement>(onClose);
	return (
		<div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-6 pt-[12vh]">
			<div ref={ref} className={`flex max-h-[76vh] w-full ${wide ? "max-w-4xl" : "max-w-md"} flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl`}>
				<header className="flex items-center justify-between">
					<h2 className="text-lg font-medium">{title}</h2>
					<IconButton label="Close" onClick={onClose}>
						<CloseIcon />
					</IconButton>
				</header>
				{children}
			</div>
		</div>
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

/**
 * A small panel that opens from the thing you clicked: profile cards, menus, details.
 * It sits below its button, or above when there's no room, and stays inside the window.
 * A click outside or Escape closes it. `children` can take `close`, for menus.
 */
export function Popover({
	trigger,
	label,
	className = "",
	panelClassName = "w-72",
	children,
}: {
	/** What you click. */
	trigger: React.ReactNode;
	/** Tooltip and accessible name for the button, when the trigger is only an icon or avatar. */
	label?: string;
	/** For the button. */
	className?: string;
	/** For the panel: its width, mostly. */
	panelClassName?: string;
	children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
	const [anchor, setAnchor] = useState<DOMRect>();
	const close = () => setAnchor(undefined);
	const ref = useDismiss<HTMLSpanElement>(close, !!anchor);
	const panel = useRef<HTMLDivElement>(null);
	const [at, setAt] = useState<React.CSSProperties>({ visibility: "hidden" });
	// Measure, then place: below if it fits, else above; nudged in from the window's edges.
	useLayoutEffect(() => {
		if (!anchor || !panel.current) return setAt({ visibility: "hidden" });
		const { width, height } = panel.current.getBoundingClientRect();
		const gap = 6;
		const below = anchor.bottom + gap + height <= window.innerHeight - 8;
		setAt({
			left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
			top: below ? anchor.bottom + gap : Math.max(8, anchor.top - gap - height),
		});
	}, [anchor]);
	return (
		<span ref={ref} className="contents">
			<button
				type="button"
				title={label}
				aria-label={label}
				aria-expanded={!!anchor}
				onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget.getBoundingClientRect()))}
				className={className}
			>
				{trigger}
			</button>
			{anchor && (
				<div
					ref={panel}
					style={at}
					className={`no-drag fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-neutral-200 bg-white text-left text-sm font-normal text-neutral-900 shadow-lg ${panelClassName}`}
				>
					{typeof children === "function" ? children(close) : children}
				</div>
			)}
		</span>
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

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function dayLabel(ms: number) {
	const day = new Date(ms).toDateString();
	if (day === new Date().toDateString()) return "Today";
	if (day === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
	return new Date(ms).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
