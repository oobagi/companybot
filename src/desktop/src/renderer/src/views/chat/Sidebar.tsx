import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { CaretRightIcon, ChannelIcon, PlusIcon, PrivateIcon } from "../../icons";
import { AgentBadge, Avatar } from "./common";
import type { ChatList, Participant } from "./data";
import { BrowseChannels, CreateChannel, NewMessage } from "./dialogs";

type Dialog = "create" | "browse" | "message";

/** The other person in a DM with just one, whose photo stands for it. */
const soleOther = (members: Participant[], me: Id<"users">) => {
	const others = members.filter((m) => m.id !== me);
	return others.length === 1 ? others[0] : undefined;
};

/**
 * The chat list: channels, then direct messages. Agents sit with people (labeled Bot), and
 * each one is listed even before you've written to it.
 */
export function ChatNav({
	chats,
	openId,
	onOpen,
	onError,
}: {
	chats: ChatList | null | undefined;
	/** The open chat, if the chat view is showing. */
	openId: Id<"chats"> | undefined;
	onOpen: (chatId: Id<"chats">) => void;
	onError: (e: unknown) => void;
}) {
	const openDm = useMutation(api.chats.openDm);
	const [dialog, setDialog] = useState<Dialog>();
	if (!chats) return null;

	// Your DMs with people (and groups), and one per agent; most recent first, then the agents you haven't messaged.
	const dms = [
		...chats.dms.filter((d) => !d.agentId).map((d) => ({ key: d._id, dmId: d._id, name: d.title, image: soleOther(d.members, chats.me)?.image, agent: false, unread: d.unread, mentioned: d.mentioned, at: d.lastMessageAt, open: () => onOpen(d._id), title: undefined as string | undefined })),
		...chats.agents.map((a) => ({
			key: a._id,
			dmId: a.dmId,
			name: a.name,
			image: a.image,
			agent: true,
			unread: a.unread,
			mentioned: a.mentioned,
			at: a.lastMessageAt ?? 0,
			title: a.description,
			open: () => (a.dmId ? onOpen(a.dmId) : openDm({ userIds: [], agentIds: [a._id] }).then(onOpen, onError)),
		})),
	].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));

	return (
		<>
			<Group title="Channels" onAdd={() => setDialog("create")} addLabel="Create a channel">
				{chats.channels.map((c) => (
					<Item
						key={c._id}
						icon={c.private ? <PrivateIcon /> : <ChannelIcon />}
						active={c._id === openId}
						unread={c.unread}
						mentioned={c.mentioned}
						onClick={() => onOpen(c._id)}
					>
						<span className="truncate">{c.name}</span>
					</Item>
				))}
				<Item icon={<PlusIcon />} onClick={() => setDialog("browse")} muted>
					Browse channels
				</Item>
			</Group>

			<Group title="Direct messages" onAdd={() => setDialog("message")} addLabel="New message">
				{dms.map((d) => (
					<Item
						key={d.key}
						icon={<Avatar name={d.name} image={d.image} agent={d.agent} size="xs" />}
						active={!!d.dmId && d.dmId === openId}
						unread={d.unread}
						mentioned={d.mentioned}
						title={d.title}
						onClick={d.open}
					>
						<span className="truncate">{d.name}</span>
						{d.agent && <AgentBadge />}
					</Item>
				))}
				<Item icon={<PlusIcon />} onClick={() => setDialog("message")} muted>
					New message
				</Item>
			</Group>

			{dialog === "create" && <CreateChannel onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "browse" && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "message" && <NewMessage onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</>
	);
}

/** A sidebar section. `onTitle` makes its title a link to the section's own screen (Pages → every page). */
export function Group({
	title,
	onTitle,
	onAdd,
	addLabel,
	children,
}: {
	title: string;
	onTitle?: () => void;
	onAdd?: () => void;
	addLabel?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="group/section flex flex-col gap-px">
			<div className="flex items-center justify-between px-2 pb-1">
				<h2 className="text-xs font-medium text-neutral-500">
					{onTitle ? (
						<button type="button" onClick={onTitle} className="group/title flex items-center gap-0.5 hover:text-neutral-900">
							{title}
							<CaretRightIcon className="opacity-0 group-hover/title:opacity-100" />
						</button>
					) : (
						title
					)}
				</h2>
				{onAdd && (
					<button
						type="button"
						onClick={onAdd}
						title={addLabel}
						aria-label={addLabel}
						className={`${trailingAction} opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100`}
					>
						<PlusIcon />
					</button>
				)}
			</div>
			{children}
		</section>
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
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<div
			style={indent ? { paddingLeft: 8 + indent * 12 } : undefined}
			className={`group/item relative flex items-center gap-2 rounded-lg px-2 py-1 text-sm ${itemTone({ active, unread, muted })}`}
		>
			{icon && <span className="flex w-5 shrink-0 items-center justify-center text-base text-neutral-400">{icon}</span>}
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
