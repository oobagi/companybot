import { Modal as MantineModal, Popover as MantinePopover } from "@mantine/core";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
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

const sizes = { line: "size-4 text-[8px]", xs: "size-5 text-[10px]", row: "size-[22px] text-[10px]", sm: "size-6 text-[11px]", pair: "size-7 text-[11px]", md: "size-9 text-sm", lg: "size-14 text-lg" };

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

/**
 * An agent acting for a person ("Companybot, for Jaden"): the agent's picture, with the
 * person's tucked over its lower right corner. The size of one `md` avatar.
 */
export function PairAvatar({ agent, person }: { agent: { name: string; image?: string | null }; person: { name: string; image?: string | null } }) {
	return (
		<span className="relative block size-9 shrink-0">
			<Avatar name={agent.name} image={agent.image} agent size="pair" className="absolute top-0 left-0" />
			<Avatar name={person.name} image={person.image} size="xs" className="absolute right-0 bottom-0 ring-2 ring-white" />
		</span>
	);
}

/** Next to an agent's name wherever it's listed with people. */
export function AgentBadge() {
	return <span className="shrink-0 rounded bg-neutral-200/70 px-1 py-px text-[10px] leading-tight font-medium text-neutral-500 uppercase">Bot</span>;
}

const EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"];

/** The quick row of reactions, and "more" for the full picker. Lives in a popover; `onPick` closes it. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
	return (
		<div className="flex gap-0.5">
			{EMOJI.map((e) => (
				<button type="button" key={e} onClick={() => onPick(e)} className="flex size-8 items-center justify-center rounded-lg text-lg hover:bg-neutral-100">
					{e}
				</button>
			))}
			<Popover trigger={<PlusIcon />} label="More emoji" className="flex size-8 items-center justify-center rounded-lg text-base text-neutral-500 hover:bg-neutral-100" panelClassName="w-auto">
				{(close) => <EmojiPanel onPick={(e) => (close(), onPick(e))} />}
			</Popover>
		</div>
	);
}

/** How an open popover or dialog hears that one opened from inside it opened (1) or closed (-1). */
const Inner = createContext<(change: 1 | -1) => void>(() => {});

/**
 * An open popover or dialog is the newest while none opened from inside it is open. Only the newest
 * closes on Escape (`onEscape`) or a click outside, so Escape in a Confirm over a dialog closes just
 * the Confirm. `nest` goes around what's inside it.
 */
function useNewest(opened: boolean, onEscape: () => void) {
	const parent = useContext(Inner);
	const [inner, setInner] = useState(0);
	const report = useCallback((change: 1 | -1) => setInner((n) => n + change), []);
	const escape = useRef(onEscape);
	escape.current = onEscape;
	const newest = opened && inner === 0;
	useEffect(() => {
		if (!opened) return;
		parent(1);
		return () => parent(-1);
	}, [opened, parent]);
	useEffect(() => {
		if (!newest) return;
		const key = (e: KeyboardEvent) => e.key === "Escape" && !e.isComposing && escape.current();
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [newest]);
	return { newest, nest: (children: React.ReactNode) => <Inner value={report}>{children}</Inner> };
}

/** Mantine's focus trap takes the first field unless one is marked: keep the one `autoFocus` picked. */
function keepAutoFocus(layer: HTMLElement | null) {
	const focused = document.activeElement;
	if (layer && focused && focused !== layer && layer.contains(focused)) focused.setAttribute("data-autofocus", "");
}

/** Mantine's styles and motion off: ours are Tailwind classes, and nothing animates. */
const plain = { unstyled: true, transitionProps: { duration: 0 } };

/** Its children as they are: a dialog lays out its own content. */
const Unwrapped = ({ children }: { children?: React.ReactNode }) => children;

/**
 * Something over the whole window (Mantine's Modal): it takes focus and gives it back, and Escape
 * or a click outside closes it when it's the newest. At the end of the page, so it opens from
 * anywhere (a menu, another dialog) and still takes the mouse from Electron's window-drag areas.
 * `className` is the box; `overlayClassName` the dimmed rest.
 */
export function Layer({ onClose, className, overlayClassName, children }: { onClose: () => void; className: string; overlayClassName: string; children: React.ReactNode }) {
	const { newest, nest } = useNewest(true, onClose);
	// Ours, not Mantine's: dialogs unmount as they close, which Mantine's return of focus misses.
	useLayoutEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
	}, []);
	return (
		<MantineModal.Root
			opened
			onClose={onClose}
			{...plain}
			closeOnEscape={false} closeOnClickOutside={false} lockScroll={false} returnFocus={false} scrollAreaComponent={Unwrapped}
			classNames={{ overlay: `no-drag fixed inset-0 z-50 ${overlayClassName}`, inner: "no-drag pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6", content: `pointer-events-auto ${className}` }}
		>
			<MantineModal.Overlay onMouseDown={() => newest && onClose()} />
			<MantineModal.Content ref={keepAutoFocus}>{nest(children)}</MantineModal.Content>
		</MantineModal.Root>
	);
}

/** `wide` for side-by-side content (page history). */
export function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
	return (
		<Layer
			onClose={onClose}
			overlayClassName="bg-neutral-900/20"
			className={`flex max-h-[85vh] w-full ${wide ? "max-w-4xl" : "max-w-md"} flex-col gap-4 overflow-y-auto rounded-2xl bg-white p-6 text-[15px] text-neutral-900 shadow-xl`}
		>
			<header className="flex items-center justify-between">
				<MantineModal.Title className="text-lg font-medium">{title}</MantineModal.Title>
				<IconButton label="Close" onClick={onClose}>
					<CloseIcon />
				</IconButton>
			</header>
			{children}
		</Layer>
	);
}

export const iconButton = "no-drag flex size-7 items-center justify-center rounded-md text-base text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900";

/** A square button holding only an icon; `label` is its tooltip and accessible name. */
export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button type="button" title={label} aria-label={label} onClick={onClick} className={iconButton}>
			{children}
		</button>
	);
}

/**
 * A small panel that opens from the thing you clicked: profile cards, menus, details.
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
	const [opened, setOpened] = useState(false);
	const close = () => setOpened(false);
	return (
		<PopoverPanel
			opened={opened}
			onClose={close}
			matchWidth={matchWidth}
			className={panelClassName}
			target={
				<button type="button" title={label} aria-label={label} disabled={disabled} onClick={() => setOpened(!opened)} className={className}>
					{trigger}
				</button>
			}
		>
			{typeof children === "function" ? children(close) : children}
		</PopoverPanel>
	);
}

/**
 * A Popover's panel on its own (Mantine's Popover), opened by you: from `target`, an element, or
 * `at` a point (a right-click) inside the nearest positioned box. It sits below, or above when
 * there's no room, inside the window, and follows its target as the page scrolls. It takes focus
 * (unless `trapFocus` is off, for one that opens on hover) and gives it back to the target as it
 * closes, unless you clicked into something else.
 */
export function PopoverPanel({
	opened,
	onClose,
	target,
	at,
	matchWidth,
	trapFocus = true,
	className = "w-72",
	children,
}: {
	opened: boolean;
	onClose: () => void;
	target?: React.ReactElement;
	at?: { x: number; y: number };
	matchWidth?: boolean;
	trapFocus?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	const anchor = useRef<HTMLElement>(null);
	const { newest, nest } = useNewest(opened, onClose);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (opened) return void (wasOpen.current = true);
		if (!wasOpen.current) return;
		wasOpen.current = false;
		// Focus was in the panel, now gone.
		if (document.activeElement === document.body) anchor.current?.focus({ preventScroll: true });
	}, [opened]);
	const spot = useCallback((el: HTMLElement | null) => {
		const box = el?.offsetParent?.getBoundingClientRect();
		if (el && box && at) Object.assign(el.style, { left: `${at.x - box.left}px`, top: `${at.y - box.top}px` });
	}, [at?.x, at?.y]);
	return (
		<MantinePopover
			opened={opened}
			onDismiss={onClose}
			{...plain}
			position="bottom-start" offset={6} width="" zIndex={50} floatingStrategy="fixed" trapFocus={trapFocus} closeOnEscape={false} closeOnClickOutside={newest}
			middlewares={{
				flip: true,
				shift: { padding: 8 },
				// Shortened to the room on its side (it scrolls); at least as wide as its button for a picker.
				size: {
					padding: 8,
					apply: ({ rects, availableHeight, elements }) => {
						Object.assign(elements.floating.style, { maxHeight: `${Math.min(availableHeight, window.innerHeight * 0.7)}px`, minWidth: matchWidth ? `${rects.reference.width}px` : "" });
					},
				},
			}}
		>
			<MantinePopover.Target ref={anchor}>{target ?? <span ref={spot} className="pointer-events-none absolute size-0" />}</MantinePopover.Target>
			<MantinePopover.Dropdown
				ref={keepAutoFocus}
				className={`no-drag fixed overflow-y-auto rounded-xl border border-neutral-200 bg-white text-left text-sm font-normal text-neutral-900 shadow-lg ${className}`}
			>
				{nest(children)}
			</MantinePopover.Dropdown>
		</MantinePopover>
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
