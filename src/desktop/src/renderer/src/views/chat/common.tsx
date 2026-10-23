import { useEffect, useRef } from "react";

export const initials = (name: string) =>
	name
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join("") || "?";

const sizes = { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-9 text-xs" };

/** People are round; agents are rounded squares. */
export function Avatar({ name, agent, size = "md" }: { name: string; agent?: boolean; size?: keyof typeof sizes }) {
	return (
		<span
			title={name}
			className={`flex shrink-0 items-center justify-center font-medium select-none ${sizes[size]} ${
				agent ? "rounded-md bg-neutral-800 text-white" : "rounded-full bg-neutral-200 text-neutral-600"
			}`}
		>
			{initials(name)}
		</span>
	);
}

export function AvatarStack({ people, size = "sm" }: { people: { name: string; type: string }[]; size?: keyof typeof sizes }) {
	return (
		<span className="flex -space-x-1.5">
			{people.slice(0, 3).map((p, i) => (
				<span key={i} className="rounded-full ring-2 ring-white">
					<Avatar name={p.name} agent={p.type === "agent"} size={size} />
				</span>
			))}
		</span>
	);
}

export function AgentBadge() {
	return <span className="rounded bg-neutral-100 px-1 py-px text-[10px] font-medium text-neutral-500 uppercase">Agent</span>;
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

export const EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"];

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

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
	const ref = useDismiss<HTMLDivElement>(onClose);
	return (
		<div className="no-drag fixed inset-0 z-50 flex items-start justify-center bg-neutral-900/20 px-6 pt-[12vh]">
			<div ref={ref} className="flex max-h-[76vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
				<header className="flex items-center justify-between">
					<h2 className="text-lg font-medium">{title}</h2>
					<button type="button" onClick={onClose} className="text-xl leading-none text-neutral-400 hover:text-neutral-700" aria-label="Close">
						×
					</button>
				</header>
				{children}
			</div>
		</div>
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
