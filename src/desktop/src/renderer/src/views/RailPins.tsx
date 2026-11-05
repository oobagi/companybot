import { CountBadge, railButton } from "../ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useQuery, useWorkspace } from "../convex";
import { ChannelIcon, ChatIcon, CustomizeIcon, DatabaseIcon, DriveIcon, PageIcon, PinIcon, PrivateIcon, RecordIcon, UnpinIcon } from "../icons";
import { blurActiveEditable, shortcutLabel, useJump } from "../shortcuts";
import { type PinKey, RECENT_SHOWN, pathOf, setRailVia, splitPin, usePins, useRailVia } from "../pins";
import { navigate } from "../router";
import { type DragProps, moveCommand, useDragList, useDragStatic, useSortable } from "../sortable";
import { useStoredIds } from "../arrangements";
import type { useTip } from "../ui";
import { Avatar, MenuItem, PopoverPanel } from "./chat/common";
import { useTypes } from "./records/data";

type TipFor = ReturnType<typeof useTip>["tipFor"];

/** The rail's tabs: the parts of the app, in the order a new rail shows them. They're pins you can't remove. */
export const appTabs = [
	{ id: "chat", label: "Chat", icon: ChatIcon },
	{ id: "drive", label: "Drive", icon: DriveIcon },
	{ id: "databases", label: "Databases", icon: DatabaseIcon },
	{ id: "customize", label: "Customize", icon: CustomizeIcon },
] as const;
export type AppTab = (typeof appTabs)[number]["id"];

/** What's waiting in a tab: a red count of chats with a mention or DM, else a dot for unread. */
export type TabBadge = { mentions: number; unread: boolean };

/** One thing in the rail's main group: a tab, or a pin. Ids don't collide: a pin's has a colon. */
type Main = { id: string; tab?: (typeof appTabs)[number]; entry?: Entry };
const mainId = (m: Main) => m.id;

/** A pin or recent, as the rail shows it. Gone ones (left, archived, deleted) aren't shown. */
type Entry = { key: PinKey; label: string; icon: React.ReactNode; path: string[]; unread: boolean; mentioned: boolean };

const entryKey = (e: Entry) => e.key;

/** Turns pins into what they are now, so renames show and deleted things drop out. `ready` once all have loaded. */
function useEntries(keys: PinKey[]) {
	const chats = useQuery(api.chats.list);
	const pages = useQuery(api.pages.list);
	const types = useTypes();
	const recordIds = keys.flatMap((k) => (k.startsWith("rec:") ? [splitPin(k)[1]] : []));
	const records = useQuery(api.records.titles, recordIds.length ? { recordIds } : "skip");
	const ready = !!chats && !!pages && !!types && (!recordIds.length || !!records);
	const resolve = (key: PinKey): Entry | undefined => {
		const [kind, id] = splitPin(key);
		const plain = { key, path: pathOf(key), unread: false, mentioned: false };
		if (kind === "rec") {
			const record = records?.find((r) => r._id === id);
			return record && { ...plain, path: pathOf(key, record.typeKey), label: record.title || "Untitled", icon: <RecordIcon size={22} /> };
		}
		if (kind === "page") {
			const page = pages?.find((p) => p._id === id);
			return page && { ...plain, label: page.title || "Untitled", icon: <PageIcon size={22} /> };
		}
		if (kind === "db") {
			const type = types?.find((t) => t.key === id);
			return type && { ...plain, label: type.plural, icon: <DatabaseIcon size={22} /> };
		}
		if (!chats) return undefined;
		const channel = chats.channels.find((c) => c._id === id);
		if (channel) return { ...plain, label: `#${channel.name}`, icon: channel.private ? <PrivateIcon size={22} /> : <ChannelIcon size={22} />, unread: channel.unread, mentioned: channel.mentioned };
		const agent = chats.agents.find((a) => a.dmId === id);
		if (agent) return { ...plain, label: agent.name, icon: <Avatar name={agent.name} image={agent.image} agent size="pair" />, unread: agent.unread, mentioned: agent.mentioned };
		const dm = chats.dms.find((d) => d._id === id);
		if (!dm) return undefined;
		const state = { unread: dm.unread, mentioned: dm.mentioned };
		// A side chat with an agent, under its DM.
		if (dm.parentId) return { ...plain, ...state, label: dm.label ?? "New chat", icon: <ChatIcon size={22} /> };
		const others = dm.members.filter((m) => m.id !== chats.me);
		return { ...plain, ...state, label: dm.title, icon: <Avatar name={dm.title} image={others.length === 1 ? others[0]!.image : undefined} size="pair" /> };
	};
	return { resolve, ready };
}

/** Each workspace's recents in the order the rail last showed them, for this session. */
const shownRecents = new Map<string, PinKey[]>();

/**
 * Recents in a steady order, from the order last shown (`before`): one already on the rail keeps its
 * place when you open it again (the saved list moves it to the front), and one new to the list comes in
 * at the top. Which ones show is still the latest RECENT_SHOWN, so the one you used longest ago is what
 * drops off. Pure: RailPins stores the result only once it's on screen, so a render React throws away
 * can't reorder anything.
 */
export function steadyOrder(before: readonly PinKey[], latest: readonly PinKey[]): PinKey[] {
	const kept = before.filter((k) => latest.includes(k));
	return [...latest.filter((k) => !kept.includes(k)), ...kept];
}

/**
 * The rail's buttons: one group of tabs and pins, mixed in your order (drag any of them anywhere in it),
 * then a divider and what you opened lately that isn't pinned. Drag a recent up into the group to pin it,
 * a pin down to unpin it; tabs can't leave. Pin from a sidebar row's menu, or right-click one here.
 * ⌘1–9 open the group's first nine, in the order shown. `tab` and `open` are what's on screen: one
 * button is lit, the one you came through. A pin or recent you clicked lights at once and stays lit
 * until you leave it or click a sidebar row; anything else (its tab, the sidebar, search) lights the tab.
 */
export function RailPins({
	tab,
	onOpenTab,
	badges = {},
	open,
	tipFor,
	hideTip,
}: {
	tab: AppTab | undefined;
	onOpenTab: (tab: AppTab) => void;
	badges?: Partial<Record<AppTab, TabBadge>>;
	open: PinKey | undefined;
	tipFor: TipFor;
	hideTip: () => void;
}) {
	const { pins, recent, toggle, visit } = usePins();
	// The pin or recent you opened from the rail (`setRailVia`). Arriving somewhere else lets go of it.
	const via = useRailVia();
	const viaNow = useRef(via);
	viaNow.current = via;
	useEffect(() => {
		if (viaNow.current && open !== viaNow.current) setRailVia(undefined);
	}, [open]);
	const throughRail = !!via;
	const openEntry = (e: Entry) => (setRailVia(e.key), navigate(...e.path));
	const openTab = (t: AppTab) => (setRailVia(undefined), onOpenTab(t));
	const workspace = useWorkspace();
	const { resolve, ready } = useEntries([...pins, ...recent]);
	const pinned = pins.map(resolve).filter((e): e is Entry => !!e);
	const [railOrder, changeRail] = useStoredIds("rail");
	const items: Main[] = [...appTabs.map((t) => ({ id: t.id, tab: t })), ...pinned.map((e) => ({ id: e.key, entry: e }))];
	const { sorted, drag, key: mainList } = useSortable("rail", items, mainId, "y", undefined, {
		group: "rail",
		onReceive: (from, index, shown) => {
			const key = from.id as PinKey;
			toggle(key);
			const command = moveCommand(railOrder, [...shown, key], key, index);
			if (command) changeRail(command);
		},
	});
	// Recents reorder among themselves (for this session) and take pins, never tabs. A pin dropped
	// here lands where you let go of it.
	const [, redraw] = useState(0);
	const { item: recentDrag, key: recentList } = useDragList({
		group: "rail",
		enabled: true,
		accepts: (from) => from.id.includes(":"),
		onDrop: (from, index) => {
			const key = from.id as PinKey;
			if (from.list === mainList) {
				toggle(key);
				visit(key);
			} else if (from.list !== recentList) return;
			const ws = workspace?.id ?? "";
			const rest = (shownRecents.get(ws) ?? []).filter((k) => k !== key);
			shownRecents.set(ws, [...rest.slice(0, index), key, ...rest.slice(index)]);
			redraw((n) => n + 1);
		},
	});
	// A drop above it pins (`endOf`), below it unpins. With no recents it stays, unseen, so a pin can still be dragged out.
	const divider = useDragStatic("rail", { endOf: mainList, startOf: recentList });

	useJump("tab", (n) => {
		const to = sorted[n - 1];
		if (!to) return false;
		// Already lit: nothing to do.
		if (to.tab ? to.tab.id === tab && !throughRail : to.entry!.key === via) return false;
		blurActiveEditable();
		// A rail button clicked earlier would show its keyboard focus ring once keys are pressed.
		if (document.activeElement instanceof HTMLElement && document.activeElement.closest("nav[aria-label='App']")) document.activeElement.blur();
		if (to.tab) openTab(to.tab.id);
		else openEntry(to.entry!);
	});

	// Your last RECENT_SHOWN places, less the pinned ones, in the order they came in (`steadyOrder`) or you dragged them. Pinning
	// one doesn't pull in another, so the rail keeps its length. While some are still loading, the rail keeps
	// what it showed: one arriving late would look new and jump to the top.
	const ws = workspace?.id ?? "";
	const latest = recent.map(resolve).filter((e): e is Entry => !!e).slice(0, RECENT_SHOWN).filter((e) => !pins.includes(e.key));
	const before = shownRecents.get(ws) ?? [];
	const order = ready ? steadyOrder(before, latest.map(entryKey)) : before;
	const orderKey = order.join(" ");
	useEffect(() => {
		if (ready) shownRecents.set(ws, orderKey ? (orderKey.split(" ") as PinKey[]) : []);
	}, [ready, ws, orderKey]);
	const lately = order.map(resolve).filter((e): e is Entry => !!e);
	return (
		<>
			{sorted.map((m, i) => {
				const shortcut = i < 9 ? shortcutLabel("tab", i + 1) : undefined;
				if (m.tab) return <TabButton key={m.id} tab={m.tab} active={m.id === tab && !throughRail} badge={badges[m.tab.id]} drag={drag(m.id)} onOpen={openTab} tip={tipFor(m.tab.label, shortcut)} hideTip={hideTip} />;
				const e = m.entry!;
				return <RailItem key={m.id} entry={e} active={e.key === via} pinned drag={drag(m.id)} onOpen={() => openEntry(e)} onToggle={() => toggle(e.key)} tip={tipFor(e.label, shortcut)} hideTip={hideTip} />;
			})}
			<Divider {...divider} className={`${divider.className} ${lately.length || divider.className ? "" : "invisible"}`} />
			{lately.map((e) => (
				<RailItem key={e.key} entry={e} active={e.key === via} pinned={false} drag={recentDrag(e.key)} onOpen={() => openEntry(e)} onToggle={() => toggle(e.key)} tip={tipFor(e.label, "Recent")} hideTip={hideTip} />
			))}
		</>
	);
}

/** A tab: one part of the app. Its badge counts chats with an unread @mention or DM, else a dot for unread. */
function TabButton({ tab: t, active, badge, drag, onOpen, tip, hideTip }: { tab: (typeof appTabs)[number]; active: boolean; badge?: TabBadge; drag: DragProps; onOpen: (tab: AppTab) => void; tip: ReturnType<TipFor>; hideTip: () => void }) {
	return (
		<span {...drag} onPointerDown={drag.onPointerDown && ((e) => (hideTip(), drag.onPointerDown!(e)))} className={`relative flex ${drag.className ?? ""}`}>
			<span className="relative flex" {...tip}>
				<button
					type="button"
					aria-label={badge?.mentions ? `${t.label}, ${badge.mentions} unread ${badge.mentions === 1 ? "mention or DM" : "mentions or DMs"}` : t.label}
					aria-current={active ? "page" : undefined}
					onClick={() => (!active && blurActiveEditable(), hideTip(), onOpen(t.id))}
					className={railButton(active)}
				>
					<t.icon size={22} weight={active ? "fill" : "regular"} />
				</button>
				{badge?.mentions ? (
					<CountBadge count={badge.mentions} ring className="pointer-events-none absolute -top-1 -right-1" />
				) : (
					badge?.unread && <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full border-2 border-neutral-100 bg-sky-500" />
				)}
			</span>
		</span>
	);
}

// Padding, not margin: the drag measures boxes, and a margin would make drops land a few pixels off.
const Divider = ({ className = "", ...props }: { ref?: (el: HTMLElement | null) => void; style?: React.CSSProperties; className?: string }) => (
	<span aria-hidden {...props} className={`flex shrink-0 py-1 ${className}`}>
		<span className="h-px w-6 bg-neutral-300/80" />
	</span>
);

/** One pin or recent: click to open, right-click to pin or unpin. */
function RailItem({
	entry,
	active,
	pinned,
	drag,
	onOpen,
	onToggle,
	tip,
	hideTip,
}: {
	entry: Entry;
	active: boolean;
	pinned: boolean;
	drag?: DragProps;
	onOpen: () => void;
	onToggle: () => void;
	tip: ReturnType<TipFor>;
	hideTip: () => void;
}) {
	const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
	const button = useRef<HTMLButtonElement>(null);
	return (
		<div
			{...drag}
			onContextMenu={(e) => (e.preventDefault(), hideTip(), setMenuAt({ x: e.clientX, y: e.clientY }))}
			className={`relative flex shrink-0 ${drag?.className ?? ""}`}
		>
			<span className="relative flex" {...tip}>
				<button
					ref={button}
					type="button"
					aria-label={entry.mentioned ? `${entry.label}, unread mention` : entry.label}
					aria-current={active ? "page" : undefined}
					onClick={() => (hideTip(), onOpen())}
					className={railButton(active)}
				>
					{entry.icon}
				</button>
				{(entry.mentioned || entry.unread) && (
					<span className={`pointer-events-none absolute top-1 right-1 size-2 rounded-full border-2 border-neutral-100 ${entry.mentioned ? "bg-red-500" : "bg-sky-500"}`} />
				)}
			</span>
			{menuAt && (
				<PopoverPanel opened at={menuAt} returnFocus={button} className="w-44 p-1 text-sm" onClose={() => setMenuAt(undefined)}>
					<MenuItem onClick={() => (setMenuAt(undefined), onToggle())}>
						{pinned ? (
							<>
								<UnpinIcon className="text-neutral-500" /> Unpin
							</>
						) : (
							<>
								<PinIcon className="text-neutral-500" /> Pin
							</>
						)}
					</MenuItem>
				</PopoverPanel>
			)}
		</div>
	);
}
