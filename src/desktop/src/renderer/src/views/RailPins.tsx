import { useState } from "react";
import { api } from "../api";
import { useQuery } from "../convex";
import { ChannelIcon, ChatIcon, DatabaseIcon, PageIcon, PinIcon, PrivateIcon, RecordIcon, UnpinIcon } from "../icons";
import { type PinKey, RECENT_SHOWN, pathOf, splitPin, usePins } from "../pins";
import { navigate } from "../router";
import { type DragProps, useSortable } from "../sortable";
import type { useTip } from "../ui";
import { Avatar, MenuItem, PopoverPanel } from "./chat/common";
import { useTypes } from "./records/data";

type TipFor = ReturnType<typeof useTip>["tipFor"];

/** A pin or recent, as the rail shows it. Gone ones (left, archived, deleted) aren't shown. */
type Entry = { key: PinKey; label: string; icon: React.ReactNode; path: string[]; unread: boolean; mentioned: boolean };

const entryKey = (e: Entry) => e.key;

/** Turns pins into what they are now, so renames show and deleted things drop out. */
function useEntries(keys: PinKey[]) {
	const chats = useQuery(api.chats.list);
	const pages = useQuery(api.pages.list);
	const types = useTypes();
	const recordIds = keys.flatMap((k) => (k.startsWith("rec:") ? [splitPin(k)[1]] : []));
	const records = useQuery(api.records.titles, recordIds.length ? { recordIds } : "skip");
	return (key: PinKey): Entry | undefined => {
		const [kind, id] = splitPin(key);
		const plain = { key, path: pathOf(key), unread: false, mentioned: false };
		if (kind === "rec") {
			const record = records?.find((r) => r._id === id);
			return record && { ...plain, path: pathOf(key, record.typeKey), label: record.title || "Untitled", icon: <RecordIcon size={20} /> };
		}
		if (kind === "page") {
			const page = pages?.find((p) => p._id === id);
			return page && { ...plain, label: page.title || "Untitled", icon: <PageIcon size={20} /> };
		}
		if (kind === "db") {
			const type = types?.find((t) => t.key === id);
			return type && { ...plain, label: type.plural, icon: <DatabaseIcon size={20} /> };
		}
		if (!chats) return undefined;
		const channel = chats.channels.find((c) => c._id === id);
		if (channel) return { ...plain, label: `#${channel.name}`, icon: channel.private ? <PrivateIcon size={20} /> : <ChannelIcon size={20} />, unread: channel.unread, mentioned: channel.mentioned };
		const agent = chats.agents.find((a) => a.dmId === id);
		if (agent) return { ...plain, label: agent.name, icon: <Avatar name={agent.name} image={agent.image} agent size="sm" />, unread: agent.unread, mentioned: agent.mentioned };
		const dm = chats.dms.find((d) => d._id === id);
		if (!dm) return undefined;
		const state = { unread: dm.unread, mentioned: dm.mentioned };
		// A side chat with an agent, under its DM.
		if (dm.parentId) return { ...plain, ...state, label: dm.label ?? "New chat", icon: <ChatIcon size={20} /> };
		const others = dm.members.filter((m) => m.id !== chats.me);
		return { ...plain, ...state, label: dm.title, icon: <Avatar name={dm.title} image={others.length === 1 ? others[0]!.image : undefined} size="sm" /> };
	};
}

/**
 * Under the rail's tabs: your pins (any chat, DM, page, database or record; drag to reorder), then what
 * you opened lately that isn't pinned. Pin from a sidebar row's menu, or right-click one here.
 * `open` is what's on screen, lit like a tab.
 */
export function RailPins({ open, tipFor, hideTip }: { open: PinKey | undefined; tipFor: TipFor; hideTip: () => void }) {
	const { pins, recent, toggle } = usePins();
	const resolve = useEntries([...pins, ...recent]);
	const pinned = pins.map(resolve).filter((e): e is Entry => !!e);
	const { sorted, drag } = useSortable("pinsOrder", pinned, entryKey);
	const lately = recent
		.filter((k) => !pins.includes(k))
		.map(resolve)
		.filter((e): e is Entry => !!e)
		.slice(0, RECENT_SHOWN);
	const row = (e: Entry, isPinned: boolean, d?: DragProps) => (
		<RailItem key={e.key} entry={e} active={e.key === open} pinned={isPinned} drag={d} onToggle={() => toggle(e.key)} tip={tipFor(e.label, isPinned ? undefined : "Recent")} hideTip={hideTip} />
	);
	return (
		<>
			{!!sorted.length && <Divider />}
			{sorted.map((e) => row(e, true, drag(e.key)))}
			{!!lately.length && <Divider />}
			{lately.map((e) => row(e, false))}
		</>
	);
}

const Divider = () => <span aria-hidden className="my-1 h-px w-6 shrink-0 bg-neutral-300/80" />;

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
	const [menuAt, setMenuAt] = useState<DOMRect>();
	return (
		<div
			{...drag}
			onContextMenu={(e) => (e.preventDefault(), hideTip(), setMenuAt(new DOMRect(e.clientX, e.clientY, 0, 0)))}
			className={`relative flex shrink-0 ${drag?.className ?? ""}`}
		>
			<span className="relative flex" {...tip}>
				<button
					type="button"
					aria-label={entry.mentioned ? `${entry.label}, unread mention` : entry.label}
					aria-current={active ? "page" : undefined}
					onClick={() => (hideTip(), navigate(...entry.path))}
					className={`no-drag flex size-9 items-center justify-center rounded-lg transition-colors ${active ? "bg-neutral-200/90 text-neutral-900" : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900"}`}
				>
					{entry.icon}
				</button>
				{(entry.mentioned || entry.unread) && (
					<span className={`pointer-events-none absolute top-1 right-1 size-2 rounded-full border-2 border-neutral-100 ${entry.mentioned ? "bg-red-500" : "bg-sky-500"}`} />
				)}
			</span>
			{menuAt && (
				<PopoverPanel anchor={menuAt} className="w-44 p-1 text-sm" onClose={() => setMenuAt(undefined)}>
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
