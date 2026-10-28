import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMemo, useState } from "react";
import { api } from "../../api";
import { useMutation, useWorkspace } from "../../convex";
import { CaretRightIcon, ChannelIcon, PlusIcon, PrivateIcon } from "../../icons";
import { type DragProps, useSortable } from "../../sortable";
import { AgentBadge, Avatar, MenuItem, Popover } from "./common";
import type { ChatList, Participant } from "./data";
import { BrowseChannels, CreateChannel, NewMessage } from "./dialogs";

type Dialog = "create" | "browse" | "message";

/** The other person in a DM with just one, whose photo stands for it. */
const soleOther = (members: Participant[], me: Id<"users">) => {
	const others = members.filter((m) => m.id !== me);
	return others.length === 1 ? others[0] : undefined;
};

type ChatNavProps = {
	chats: ChatList;
	/** The open chat, if the chat view is showing. */
	openId: Id<"chats"> | undefined;
	onOpen: (chatId: Id<"chats">) => void;
	onError: (e: unknown) => void;
	section: SectionProps;
};

/** Channels, in your own order (drag to change). Collapsed, it keeps only the open one and unread ones, like Slack. */
export function ChannelsNav({ chats, openId, onOpen, section }: ChatNavProps) {
	const workspace = useWorkspace();
	const [dialog, setDialog] = useState<Dialog>();
	const { sorted, drag } = useSortable(`sidebar.channels:${workspace?.id}`, chats.channels, chatKey);
	const shown = section.collapsed ? sorted.filter((c) => c._id === openId || c.unread || c.mentioned) : sorted;
	return (
		<Group
			title="Channels"
			section={section}
			add={
				<Popover trigger={<PlusIcon />} label="Add channels" className={trailingAction} panelClassName="w-48 p-1">
					{(close) => (
						<>
							<MenuItem onClick={() => (close(), setDialog("create"))}>Create a channel</MenuItem>
							<MenuItem onClick={() => (close(), setDialog("browse"))}>Browse channels</MenuItem>
						</>
					)}
				</Popover>
			}
		>
			{shown.map((c) => (
				<Item
					key={c._id}
					drag={drag(c._id)}
					icon={c.private ? <PrivateIcon /> : <ChannelIcon />}
					active={c._id === openId}
					unread={c.unread}
					mentioned={c.mentioned}
					onClick={() => onOpen(c._id)}
				>
					<span className="truncate">{c.name}</span>
				</Item>
			))}
			{dialog === "create" && <CreateChannel onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "browse" && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</Group>
	);
}

/**
 * Direct messages: agents sit with people (labeled Bot), and each one is listed even before you've
 * written to it. Most recent first until you drag one; then your order, with new ones after.
 */
export function DmsNav({ chats, openId, onOpen, onError, section }: ChatNavProps) {
	const workspace = useWorkspace();
	const openDm = useMutation(api.chats.openDm);
	const [dialog, setDialog] = useState<Dialog>();
	// Your DMs with people (and groups), and one per agent; most recent first, then the agents you haven't messaged.
	const dms = useMemo(
		() =>
			[
				...chats.dms.filter((d) => !d.agentId).map((d) => ({ key: d._id as string, dmId: d._id, name: d.title, image: soleOther(d.members, chats.me)?.image, agent: false, unread: d.unread, mentioned: d.mentioned, at: d.lastMessageAt, agentId: undefined, title: undefined as string | undefined })),
				...chats.agents.map((a) => ({ key: a._id as string, dmId: a.dmId, name: a.name, image: a.image, agent: true, unread: a.unread, mentioned: a.mentioned, at: a.lastMessageAt ?? 0, agentId: a._id, title: a.description })),
			].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)),
		[chats],
	);
	const { sorted, drag } = useSortable(`sidebar.dms:${workspace?.id}`, dms, dmKey);
	const shown = section.collapsed ? sorted.filter((d) => (d.dmId && d.dmId === openId) || d.unread || d.mentioned) : sorted;
	return (
		<Group title="Direct messages" section={section} add={<AddButton label="New message" onClick={() => setDialog("message")} />}>
			{shown.map((d) => (
				<Item
					key={d.key}
					drag={drag(d.key)}
					icon={<Avatar name={d.name} image={d.image} agent={d.agent} size="row" />}
					active={!!d.dmId && d.dmId === openId}
					unread={d.unread}
					mentioned={d.mentioned}
					title={d.title}
					onClick={() => (d.dmId ? onOpen(d.dmId) : d.agentId && openDm({ userIds: [], agentIds: [d.agentId] }).then(onOpen, onError))}
				>
					<span className="truncate">{d.name}</span>
					{d.agent && <AgentBadge />}
				</Item>
			))}
			{dialog === "message" && <NewMessage onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</Group>
	);
}

const chatKey = (c: { _id: string }) => c._id;
const dmKey = (d: { key: string }) => d.key;

/** What the sidebar gives each section: whether it's folded, and its drag handle (the header) and drop area. */
export type SectionProps = { collapsed: boolean; onToggle: () => void; drag: DragProps };

/**
 * A sidebar section. With `section`, click its title to fold it and drag its title to move it.
 * `add` sits at the header's right end, showing on hover.
 */
export function Group({ title, section, add, children }: { title: string; section?: SectionProps; add?: React.ReactNode; children: React.ReactNode }) {
	const { draggable, onDragStart, onDragEnd, className = "", ...target } = section?.drag ?? {};
	return (
		<section {...target} className={`group/section relative flex flex-col gap-px ${className}`}>
			<div draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} className="flex items-center justify-between px-2 pb-1">
				<h2 className="text-xs font-medium text-neutral-500">
					{section ? (
						<button type="button" onClick={section.onToggle} aria-expanded={!section.collapsed} className="flex items-center gap-0.5 hover:text-neutral-900">
							{title}
							<CaretRightIcon className={section.collapsed ? "" : "rotate-90 opacity-0 group-hover/section:opacity-100"} />
						</button>
					) : (
						title
					)}
				</h2>
				{add && <span className="flex opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">{add}</span>}
			</div>
			{children}
		</section>
	);
}

/** A section header's +. */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} title={label} aria-label={label} className={trailingAction}>
			<PlusIcon />
		</button>
	);
}

/** A row's or section header's trailing control: same size and right edge everywhere, color-only hover. */
export const trailingAction = "flex size-5 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-800";

/** A sidebar row. The row is the only hover surface; `actions` show on hover at its right end. */
export function Item({
	icon,
	active,
	unread,
	mentioned,
	muted,
	title,
	indent = 0,
	actions,
	drag,
	onClick,
	children,
}: {
	/** Before the label: an icon or avatar, in a fixed-width slot so labels line up. */
	icon?: React.ReactNode;
	active?: boolean;
	unread?: boolean;
	mentioned?: boolean;
	muted?: boolean;
	title?: string;
	/** Tree depth: 12px more left padding per level. */
	indent?: number;
	/** Controls in the row (in the icon or at the end) need `relative z-10` to sit above the row's click area. */
	actions?: React.ReactNode;
	/** From `useSortable`: makes the row draggable within its list. */
	drag?: DragProps;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<div
			{...drag}
			style={indent ? { paddingLeft: 8 + indent * 12 } : undefined}
			className={`group/item relative flex items-center gap-2 rounded-lg px-2 py-1 text-sm ${itemTone({ active, unread, muted })} ${drag?.className ?? ""}`}
		>
			{icon && <span className="flex size-[22px] shrink-0 items-center justify-center text-lg text-neutral-500">{icon}</span>}
			<button type="button" title={title} onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left after:absolute after:inset-0 after:rounded-lg">
				{children}
				{mentioned && !active && (
					<span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-medium text-white">
						@
					</span>
				)}
			</button>
			{actions && <span className="relative z-10 hidden items-center gap-1 group-focus-within/item:flex group-hover/item:flex has-[[aria-expanded=true]]:flex">{actions}</span>}
		</div>
	);
}

function itemTone({ active, unread, muted }: { active?: boolean; unread?: boolean; muted?: boolean }) {
	if (active) return "bg-neutral-200/70 font-medium text-neutral-900";
	if (unread) return "font-semibold text-neutral-900 hover:bg-neutral-100";
	if (muted) return "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700";
	return "text-neutral-600 hover:bg-neutral-100";
}
