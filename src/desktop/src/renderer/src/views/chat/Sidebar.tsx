import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { CaretRightIcon, ChannelIcon, PlusIcon, PrivateIcon } from "../../icons";
import { AgentBadge, Avatar } from "./common";
import type { ChatList } from "./data";
import { BrowseChannels, CreateChannel, NewMessage } from "./dialogs";

type Dialog = "create" | "browse" | "message";

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
		...chats.dms.filter((d) => !d.agentId).map((d) => ({ key: d._id, dmId: d._id, name: d.title, agent: false, unread: d.unread, mentioned: d.mentioned, at: d.lastMessageAt, open: () => onOpen(d._id), title: undefined as string | undefined })),
		...chats.agents.map((a) => ({
			key: a._id,
			dmId: a.dmId,
			name: a.name,
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
						icon={<Avatar name={d.name} agent={d.agent} size="xs" />}
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
						className="flex size-5 items-center justify-center rounded text-neutral-400 opacity-0 group-hover/section:opacity-100 hover:bg-neutral-200/70 hover:text-neutral-800"
					>
						<PlusIcon />
					</button>
				)}
			</div>
			{children}
		</section>
	);
}

export function Item({
	icon,
	active,
	unread,
	mentioned,
	muted,
	title,
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
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			className={`flex items-center gap-2 rounded-lg px-2 py-1 text-left text-sm ${itemTone({ active, unread, muted })}`}
		>
			{icon && <span className="flex w-5 shrink-0 items-center justify-center text-base text-neutral-400">{icon}</span>}
			{children}
			{mentioned && !active && (
				<span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-medium text-white">
					@
				</span>
			)}
		</button>
	);
}

function itemTone({ active, unread, muted }: { active?: boolean; unread?: boolean; muted?: boolean }) {
	if (active) return "bg-neutral-200/70 font-medium text-neutral-900";
	if (unread) return "font-semibold text-neutral-900 hover:bg-neutral-100";
	if (muted) return "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700";
	return "text-neutral-600 hover:bg-neutral-100";
}
