import { railButton } from "../ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useQuery, useWorkspace } from "../convex";
import { ChannelIcon, ChatIcon, DatabaseIcon, PageIcon, PinIcon, PrivateIcon, RecordIcon, UnpinIcon } from "../icons";
import { type PinKey, RECENT_SHOWN, pathOf, splitPin, usePins } from "../pins";
import { navigate } from "../router";
import { type DragProps, moveCommand, useDragList, useDragStatic, useSortable } from "../sortable";
import { useStoredIds } from "../arrangements";
import type { useTip } from "../ui";
import { Avatar, MenuItem, PopoverPanel } from "./chat/common";
import { useTypes } from "./records/data";

type TipFor = ReturnType<typeof useTip>["tipFor"];

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
const railOrder = new Map<string, PinKey[]>();

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
 * Under the rail's tabs: your pins (any chat, DM, page, database or record; drag to reorder), then what
 * you opened lately that isn't pinned. Pin from a sidebar row's menu, or right-click one here.
 * `open` is what's on screen, lit like a tab.
 */
export function RailPins({ open, tipFor, hideTip }: { open: PinKey | undefined; tipFor: TipFor; hideTip: () => void }) {
	const { pins, recent, toggle, visit } = usePins();
	const workspace = useWorkspace();
	const { resolve, ready } = useEntries([...pins, ...recent]);
	const pinned = pins.map(resolve).filter((e): e is Entry => !!e);
	const [pinOrder, changePinOrder] = useStoredIds("pinsOrder");
	// Pins and recents are one group: drag a recent up among the pins to pin it there, a pin down to unpin it.
	const { sorted, drag, key: pinList } = useSortable("pinsOrder", pinned, entryKey, "y", undefined, {
		group: "rail",
		onReceive: (from, index, shown) => {
			const key = from.id as PinKey;
			toggle(key);
			const command = moveCommand(pinOrder, [...shown, key], key, index);
			if (command) changePinOrder(command);
		},
	});
	const { item: recentDrag, key: recentList } = useDragList({ group: "rail", enabled: true, onDrop: (from) => { if (from.list === pinList) { toggle(from.id as PinKey); visit(from.id as PinKey); } } });
	// Both dividers stay while either list has rows, so an empty one still takes a drop; it shows only while dragging.
	const pinDivider = useDragStatic("rail", { startOf: pinList });
	const recentDivider = useDragStatic("rail", { endOf: pinList, startOf: recentList });
	// The RECENT_SHOWN you opened last, in the order they came in (`steadyOrder`). While some are
	// still loading, the rail keeps what it showed: one arriving late would look new and jump to the top.
	const ws = workspace?.id ?? "";
	const latest = recent.filter((k) => !pins.includes(k)).map(resolve).filter((e): e is Entry => !!e).slice(0, RECENT_SHOWN);
	const before = railOrder.get(ws) ?? [];
	const order = ready ? steadyOrder(before, latest.map(entryKey)) : before;
	const orderKey = order.join(" ");
	useEffect(() => {
		if (ready) railOrder.set(ws, orderKey ? (orderKey.split(" ") as PinKey[]) : []);
	}, [ready, ws, orderKey]);
	const lately = order.map(resolve).filter((e): e is Entry => !!e);
	const any = sorted.length > 0 || lately.length > 0;
	const row = (e: Entry, isPinned: boolean, d?: DragProps) => (
		<RailItem
			key={e.key}
			entry={e}
			active={e.key === open}
			pinned={isPinned}
			drag={d}
			onToggle={() => toggle(e.key)}
			tip={tipFor(e.label, isPinned ? undefined : "Recent")}
			hideTip={hideTip}
		/>
	);
	return (
		<>
			{any && <Divider {...pinDivider} className={`${pinDivider.className} ${sorted.length || pinDivider.className ? "" : "invisible"}`} />}
			{sorted.map((e) => row(e, true, drag(e.key)))}
			{any && <Divider {...recentDivider} className={`${recentDivider.className} ${lately.length || recentDivider.className ? "" : "invisible"}`} />}
			{lately.map((e) => row(e, false, recentDrag(e.key)))}
		</>
	);
}

const Divider = ({ className = "", ...props }: { ref?: (el: HTMLElement | null) => void; style?: React.CSSProperties; className?: string }) => <span aria-hidden {...props} className={`my-1 h-px w-6 shrink-0 bg-neutral-300/80 ${className}`} />;

/** One pin or recent: click to open, right-click to pin or unpin. */
function RailItem({
	entry,
	active,
	pinned,
	drag,
	onToggle,
	tip,
	hideTip,
}: {
	entry: Entry;
	active: boolean;
	pinned: boolean;
	drag?: DragProps;
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
					onClick={() => (hideTip(), navigate(...entry.path))}
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
