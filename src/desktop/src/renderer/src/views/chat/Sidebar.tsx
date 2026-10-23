import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../api";
import { Avatar } from "./common";
import type { ChatList } from "./data";
import { BrowseChannels, CreateChannel, NewMessage } from "./dialogs";

type Dialog = "create" | "browse" | "message";

/** The chat list: channels, DMs with people, and one DM per agent. */
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
	if (!chats) return <div className="flex-1" />;

	const peopleDms = chats.dms.filter((d) => !d.agentId);

	return (
		<div className="no-drag -mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-4">
			<Group title="Channels" onAdd={() => setDialog("create")} addLabel="Create a channel">
				{chats.channels.map((c) => (
					<Item key={c._id} active={c._id === openId} unread={c.unread} mentioned={c.mentioned} onClick={() => onOpen(c._id)}>
						<span className="w-5 shrink-0 text-center text-neutral-400">{c.private ? "🔒" : "#"}</span>
						<span className="truncate">{c.name}</span>
					</Item>
				))}
				<Item onClick={() => setDialog("browse")} muted>
					<span className="w-5 shrink-0 text-center">+</span>
					Browse channels
				</Item>
			</Group>

			<Group title="Direct messages" onAdd={() => setDialog("message")} addLabel="New message">
				{peopleDms.map((d) => (
					<Item key={d._id} active={d._id === openId} unread={d.unread} mentioned={d.mentioned} onClick={() => onOpen(d._id)}>
						<Avatar name={d.title} size="xs" />
						<span className="truncate">{d.title}</span>
					</Item>
				))}
				{peopleDms.length === 0 && (
					<Item onClick={() => setDialog("message")} muted>
						<span className="w-5 shrink-0 text-center">+</span>
						New message
					</Item>
				)}
			</Group>

			<Group title="Agents">
				{chats.agents.map((a) => (
					<Item
						key={a._id}
						active={!!a.dmId && a.dmId === openId}
						unread={a.unread}
						mentioned={a.mentioned}
						title={a.description}
						onClick={() =>
							a.dmId ? onOpen(a.dmId) : openDm({ userIds: [], agentIds: [a._id] }).then(onOpen, onError)
						}
					>
						<Avatar name={a.name} agent size="xs" />
						<span className="truncate">{a.name}</span>
					</Item>
				))}
			</Group>

			{dialog === "create" && <CreateChannel onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "browse" && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "message" && <NewMessage onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</div>
	);
}

function Group({
	title,
	onAdd,
	addLabel,
	children,
}: {
	title: string;
	onAdd?: () => void;
	addLabel?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="group/section flex flex-col gap-px">
			<div className="flex items-center justify-between px-2 pb-1">
				<h2 className="text-xs font-medium text-neutral-500">{title}</h2>
				{onAdd && (
					<button
						type="button"
						onClick={onAdd}
						title={addLabel}
						aria-label={addLabel}
						className="flex size-5 items-center justify-center rounded text-neutral-400 opacity-0 group-hover/section:opacity-100 hover:bg-neutral-200/70 hover:text-neutral-800"
					>
						+
					</button>
				)}
			</div>
			{children}
		</section>
	);
}

export function Item({
	active,
	unread,
	mentioned,
	muted,
	title,
	onClick,
	children,
}: {
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
