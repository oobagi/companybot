import { Modal as MantineModal, Popover as MantinePopover } from "@mantine/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloseIcon, MoreIcon, PlusIcon } from "../../icons";
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

type Open = { close: () => void; node: () => HTMLElement | null; returnTo: () => HTMLElement | null; fallback?: () => HTMLElement | null };

/**
 * Open popovers and dialogs, in the order they opened. Escape or a click outside closes only the
 * last: a menu before the dialog it's in, a Confirm before the dialog under it, the newer of two
 * side by side.
 */
const layers: Open[] = [];
/** Whether a popover or dialog is open: app-wide shortcuts (`shortcuts.ts`) wait till it closes. */
export const anyLayerOpen = () => layers.length > 0;
const escape = (e: KeyboardEvent) => e.key === "Escape" && !e.isComposing && layers.at(-1)?.close();
/** Who hears when `layers` changes: each layer, to know whether it's still on top. */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));

/**
 * Puts a popover or dialog on `layers` while `opened`. `onTop` is whether it's the newest, for its
 * focus trap: only the top one holds Tab. `isTop` asks at the moment, for a click. As it closes,
 * focus goes back to `returnTo` (else what had it as it opened), unless you put it somewhere else.
 * Opened from inside another layer (a dialog from a menu item), it falls back to that one's.
 */
function useLayer(opened: boolean, onClose: () => void, node: () => HTMLElement | null, returnTo?: () => HTMLElement | null) {
	const latest = useRef({ onClose, node, returnTo });
	latest.current = { onClose, node, returnTo };
	const [layer] = useState<Open>(() => ({ close: () => latest.current.onClose(), node: () => latest.current.node(), returnTo: () => null }));
	if (opened && !layers.includes(layer)) {
		const from = document.activeElement as HTMLElement | null;
		const holder = layers.find((l) => from && l.node()?.contains(from));
		Object.assign(layer, { returnTo: () => latest.current.returnTo?.() ?? from, fallback: holder?.returnTo });
	}
	useLayoutEffect(() => {
		if (!opened) return;
		layers.push(layer);
		if (layers.length === 1) document.addEventListener("keydown", escape);
		changed();
		return () => {
			const focused = document.activeElement;
			const lost = !focused || focused === document.body || layers.slice(layers.indexOf(layer)).some((l) => l.node()?.contains(focused));
			layers.splice(layers.indexOf(layer), 1);
			if (!layers.length) document.removeEventListener("keydown", escape);
			if (lost) [layer.returnTo(), layer.fallback?.()].find((el) => el?.isConnected)?.focus({ preventScroll: true });
			changed();
		};
	}, [opened, layer]);
	const isTop = useCallback(() => layers.at(-1) === layer, [layer]);
	// Rendered to a string (no page), nothing is open: an empty stack.
	const onTop = useSyncExternalStore(subscribe, isTop, () => false);
	// Back on top, Mantine's trap turns on again and focuses the layer's first field (or a marked
	// one). Keep the focus the layer that closed just gave back: marked, if it's in this one; else put back.
	const covered = useRef(false);
	useEffect(() => {
		if (!opened) return void (covered.current = false);
		if (!isTop()) return void (covered.current = true);
		if (!covered.current) return;
		covered.current = false;
		const focused = document.activeElement as HTMLElement | null;
		const box = latest.current.node();
		if (focused && box?.contains(focused)) {
			for (const el of box.querySelectorAll("[data-autofocus]")) el.removeAttribute("data-autofocus");
			return void focused.setAttribute("data-autofocus", "");
		}
		const timer = setTimeout(() => focused?.isConnected && focused !== document.body && focused.focus({ preventScroll: true }));
		return () => clearTimeout(timer);
	}, [opened, onTop, isTop]);
	return { onTop, isTop };
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
	const content = useRef<HTMLElement>(null);
	const { onTop, isTop } = useLayer(true, onClose, () => content.current);
	const ref = useCallback((el: HTMLElement | null) => ((content.current = el), keepAutoFocus(el)), []);
	return (
		<MantineModal.Root
			opened
			onClose={onClose}
			{...plain}
			trapFocus={onTop} closeOnEscape={false} closeOnClickOutside={false} lockScroll={false} returnFocus={false} scrollAreaComponent={Unwrapped}
			classNames={{ overlay: `no-drag fixed inset-0 z-50 ${overlayClassName}`, inner: "no-drag pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6", content: `pointer-events-auto ${className}` }}
		>
			<MantineModal.Overlay onMouseDown={() => isTop() && onClose()} />
			<MantineModal.Content ref={ref}>{children}</MantineModal.Content>
		</MantineModal.Root>
	);
}

/**
 * A dialog. Its fields are `Settings`/`Setting` rows in a card, exactly as on a settings screen (never
 * stacked fields); a form (create, rename, invite) ends with `DialogButtons` (Cancel, then the action) at
 * the bottom right. Leave, Archive and the like go in `menu`, the ⋯ beside Close. `size="md"` for a yes/no
 * question with no rows; `size="xl"` for side-by-side content (page history).
 */
export function Modal({ title, size = "lg", menu, onClose, children }: { title: string; size?: "md" | "lg" | "xl"; menu?: (close: () => void) => React.ReactNode; onClose: () => void; children: React.ReactNode }) {
	return (
		<Layer
			onClose={onClose}
			overlayClassName="bg-neutral-900/20"
			className={`dialog flex max-h-[85vh] w-full ${widths[size]} flex-col gap-5 overflow-y-auto rounded-2xl bg-white p-6 text-[15px] text-neutral-900 shadow-xl`}
		>
			<header className="flex items-center gap-1">
				<MantineModal.Title className="min-w-0 flex-1 truncate text-lg font-medium">{title}</MantineModal.Title>
				{menu && <MoreMenu label="More">{menu}</MoreMenu>}
				<IconButton label="Close" onClick={onClose}>
					<CloseIcon />
				</IconButton>
			</header>
			{children}
		</Layer>
	);
}
const widths = { md: "max-w-md", lg: "max-w-xl", xl: "max-w-4xl" };

/** A dialog's buttons: bottom right, Cancel first, the action last. */
export function DialogButtons({ children }: { children: React.ReactNode }) {
	return <div className="flex justify-end gap-2">{children}</div>;
}

/** ⋯ opening a menu of `MenuItem`s: a row's or a dialog's other actions. */
export function MoreMenu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
	return (
		<Popover label={label} trigger={<MoreIcon />} className="no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 aria-expanded:bg-neutral-100" panelClassName="w-56 p-1">
			{children}
		</Popover>
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
 * there's no room, inside the window, and follows its target as the page scrolls; scrolled out of
 * sight, it closes. It takes focus (unless `trapFocus` is off, for one that opens on hover) and
 * gives it back as it closes: to `target`, or `returnFocus` (the row you right-clicked).
 */
export function PopoverPanel({
	opened,
	onClose,
	target,
	at,
	returnFocus,
	matchWidth,
	trapFocus = true,
	className = "w-72",
	children,
}: {
	opened: boolean;
	onClose: () => void;
	target?: React.ReactElement;
	at?: { x: number; y: number };
	returnFocus?: React.RefObject<HTMLElement | null>;
	matchWidth?: boolean;
	trapFocus?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	const anchor = useRef<HTMLElement>(null);
	const panel = useRef<HTMLElement>(null);
	const ref = useCallback((el: HTMLElement | null) => ((panel.current = el), keepAutoFocus(el)), []);
	const { onTop, isTop } = useLayer(opened, onClose, () => panel.current, () => (returnFocus ?? anchor).current);
	// Its target was in sight since it opened; once it scrolls away, the panel goes too.
	const seen = useRef(false);
	const close = useRef(onClose);
	close.current = onClose;
	if (!opened) seen.current = false;
	const spot = useCallback((el: HTMLElement | null) => {
		const box = el?.offsetParent?.getBoundingClientRect();
		if (el && box && at) Object.assign(el.style, { left: `${at.x - box.left}px`, top: `${at.y - box.top}px` });
	}, [at?.x, at?.y]);
	return (
		<MantinePopover
			opened={opened}
			{...plain}
			position="bottom-start" offset={6} width="" zIndex={50} floatingStrategy="fixed" trapFocus={trapFocus && onTop} closeOnEscape={false}
			onDismiss={() => isTop() && onClose()}
			middlewares={{
				flip: true,
				shift: { padding: 8 },
				// Shortened to the room on its side (it scrolls); at least as wide as its button for a picker.
				size: {
					padding: 8,
					apply: ({ rects, availableHeight, elements, middlewareData }) => {
						Object.assign(elements.floating.style, { maxHeight: `${Math.min(availableHeight, window.innerHeight * 0.7)}px`, minWidth: matchWidth ? `${rects.reference.width}px` : "" });
						if (!middlewareData.hide?.referenceHidden) seen.current = true;
						else if (seen.current) close.current();
					},
				},
			}}
		>
			<MantinePopover.Target ref={anchor}>{target ?? <span ref={spot} className="pointer-events-none absolute size-0" />}</MantinePopover.Target>
			<MantinePopover.Dropdown
				ref={ref}
				className={`no-drag fixed overflow-y-auto rounded-xl border border-neutral-200 bg-white text-left text-sm font-normal text-neutral-900 shadow-lg ${className}`}
			>
				{children}
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
		<Modal title={props.title} size="md" onClose={props.onClose}>
			<div className="flex flex-col gap-4 text-sm">
				{props.children && <p className="text-neutral-600">{props.children}</p>}
				<Notice>{props.error}</Notice>
				<DialogButtons>
					<button autoFocus type="button" disabled={props.busy} onClick={props.onClose} className={secondaryButton}>Cancel</button>
					<button type="button" disabled={props.busy} onClick={props.onConfirm} className={props.danger ? dangerButton : primaryButton}>{props.action}</button>
				</DialogButtons>
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
