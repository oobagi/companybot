import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery, useWorkspace } from "../../convex";
import { navigate } from "../../router";
import { ChannelIcon, ChatIcon, CloseIcon, EditIcon, PlusIcon, PrivateIcon } from "../../icons";
import { EmptyState, Loading, NotFound, Notice, RenameInput, Scroll, TopBar, useRun } from "../../ui";
import { FileDrop, useAttachments } from "./Attachments";
import { AgentBadge, AvatarStack, MenuItem, Popover } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type Mentions, chatTitle, showSending, useDirectory } from "./data";
import { ChannelDetails } from "./dialogs";
import { draftKey } from "./drafts";
import { MessageList } from "./MessageList";
import { ThreadPanel } from "./Thread";
import { TrashNotice } from "../Trash";
import { nudgeTutorial } from "./Tutorial";
import { TypingLine, useTypingPing } from "./Typing";

const suggestions = [
	"What do you remember about me?",
	"Show the 5 largest US cities in a table",
	"Remember that I prefer mornings for meetings.",
];

/** A message to show on opening, from a link elsewhere (a record's discussion): its thread, or the message itself. */
type ChatFocus = { thread: string } | { message: string };

export function ChatView({
	chatId,
	sendWith,
	focus,
	onLeft,
}: {
	chatId: Id<"chats">;
	sendWith: SendWith;
	focus?: ChatFocus;
	onLeft: () => void;
}) {
	const chat = useQuery(api.chats.get, { chatId });
	if (!chat) return <NotFound loaded={chat === null} icon={<ChatIcon />} title="Chat not found">It may have been deleted, or you're not in it.</NotFound>;
	return <OpenChat chat={chat} sendWith={sendWith} focus={focus} onLeft={onLeft} />;
}

function OpenChat({ chat, sendWith, focus, onLeft }: { chat: ChatDetails; sendWith: SendWith; focus?: ChatFocus; onLeft: () => void }) {
	const messages = useQuery(api.messages.list, { chatId: chat._id });
	const sendMessage = useMutation(api.messages.send, showSending);
	const markRead = useMutation(api.chats.markRead);
	const directory = useDirectory();
	const workspace = useWorkspace();
	const [details, setDetails] = useState(false);
	const { error, fail } = useRun();

	// The open thread is in the route (/chat/<id>/thread/<message>), so the sidebar's thread rows,
	// Back, and the channel row (which closes it) all agree. A link to a message scrolls to it once loaded.
	const threadId = focus && "thread" in focus ? (focus.thread as Id<"chatMessages">) : undefined;
	const openThread = (id?: Id<"chatMessages">) => navigate(...(id ? ["chat", chat._id, "thread", id] : ["chat", chat._id]));
	const focusMessage = focus && "message" in focus ? focus.message : undefined;
	const loaded = !!messages;
	useEffect(() => {
		const el = loaded && focusMessage && document.getElementById(`message-${focusMessage}`);
		if (!el) return;
		el.scrollIntoView({ block: "center" });
		el.classList.add("bg-amber-50");
		const timer = setTimeout(() => el.classList.remove("bg-amber-50"), 2000);
		return () => clearTimeout(timer);
	}, [loaded, focusMessage]);

	// Reading the open chat clears its unread state, including for messages that arrive while it's open.
	const unread = chat.unread || chat.mentioned;
	useEffect(() => {
		if (unread) markRead({ chatId: chat._id }).catch(() => {});
	}, [unread, chat._id, markRead]);

	/** Set in an agent DM (you and one agent). */
	const agent = chat.agentId ? chat.members.find((m) => m.id === chat.agentId) : undefined;
	const title = chatTitle(chat);
	const typing = useTypingPing(chat._id);
	const files = useAttachments(draftKey(workspace?.id, chat._id));
	const send = (text: string, mentions: Mentions, attachments: Id<"_storage">[] = []) => {
		fail();
		typing.sent();
		// Posting in #general without asking an agent: remind them of step 1.
		if (chat.isDefault && mentions.agentIds.length === 0) nudgeTutorial();
		const sending = sendMessage({ chatId: chat._id, text, mentions, attachments });
		sending.catch(fail);
		return sending;
	};
	const composer = (
		<Composer
			sendWith={sendWith}
			placeholder={`Message ${title}`}
			status={<TypingLine chatId={chat._id} />}
			// Nobody else could see it in an agent DM.
			onType={agent ? undefined : typing.ping}
			sources={directory}
			draftKey={draftKey(workspace?.id, chat._id)}
			onSend={send}
			attachments={chat.trash ? undefined : files}
		/>
	);
	const footer = (
		<div className="flex flex-col gap-2 px-5 pt-4 pb-7">
			<Notice>{error}</Notice>
			{chat.trash ? <TrashNotice trash={chat.trash} /> : composer}
		</div>
	);

	const bar = (
		<TopBar
			title={
				<>
					{/* Inline, not flex: a flex row would take its baseline from the icon, not the name. */}
					<h1 className="min-w-0 truncate">
						{chat.private && chat.kind === "channel" && <PrivateIcon className="mr-1 inline align-[-0.125em] text-neutral-400" />}
						{title}
					</h1>
					{agent && <AgentBadge />}
					{agent && <SideChatTabs chat={chat} />}
				</>
			}
			description={agent ? undefined : chat.topic}
		>
			{!agent && (
				<button
					type="button"
					onClick={() => setDetails(true)}
					title="Members and details"
					className="flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
				>
					<AvatarStack people={chat.members} />
					{chat.members.length}
				</button>
			)}
		</TopBar>
	);

	return (
		<div className="flex min-h-0 flex-1">
			<FileDrop attachments={chat.trash ? undefined : files} className="flex min-w-0 flex-1 flex-col">
				{!messages ? (
					<>
						{bar}
						<Loading />
					</>
				) : agent && messages.length === 0 ? (
					<>
						{bar}
						<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-24">
							<h1 className="text-2xl font-medium tracking-tight">What can {agent.name} do for you?</h1>
							<div className="w-full max-w-2xl">{composer}</div>
							<div className="flex max-w-xl flex-wrap justify-center gap-2">
								{suggestions.map((s) => (
									<button
										type="button"
										key={s}
										onClick={() => send(s, { userIds: [], agentIds: [], skillIds: [] })}
										className="rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
									>
										{s}
									</button>
								))}
							</div>
							<Notice>{error}</Notice>
						</div>
					</>
				) : messages.length === 0 ? (
					<Scroll header={bar} footer={footer}>
						<EmptyState icon={chat.kind === "channel" ? <ChannelIcon /> : <ChatIcon />} title="No messages yet">{chat.kind === "channel" ? `Start a conversation in ${title}.` : `Send your first message to ${title}.`}</EmptyState>
					</Scroll>
				) : (
					<MessageList
						chatId={chat._id}
						messages={messages}
						tokens={directory.tokens}
						summaryLabel={agent?.name ?? "Agents"}
						onOpenThread={openThread}
						onError={fail}
						intro={messages.length < 200 && <Intro title={title} channel={chat.kind === "channel"} />}
						header={bar}
						footer={footer}
					/>
				)}
			</FileDrop>
			{threadId && (
				<ThreadPanel
					key={threadId}
					chat={chat}
					threadId={threadId}
					sendWith={sendWith}
					sources={directory}
					tokens={directory.tokens}
					onClose={() => openThread()}
				/>
			)}
			{details && <ChannelDetails chat={chat} onClose={() => setDetails(false)} onLeft={onLeft} />}
		</div>
	);
}

function Intro({ title, channel }: { title: string; channel: boolean }) {
	return (
		<div className="px-5 pt-6 pb-2">
			<p className="text-lg font-semibold">{title}</p>
			<p className="text-sm text-neutral-500">
				{channel ? `This is the very beginning of ${title}.` : `This is the beginning of your conversation with ${title}.`}
			</p>
		</div>
	);
}

/**
 * An agent DM's conversations, as plain text beside its name: Main (the DM), each side chat (its
 * own session and memory context, like a fresh chat in a chat app) with an × on hover that closes
 * it to Trash, and + for another. Double-click a side chat's name to rename it in place, or click
 * the open one's name for its menu (Rename). The sidebar nests the same ones under the agent.
 */
function SideChatTabs({ chat }: { chat: ChatDetails }) {
	const list = useQuery(api.chats.list);
	const create = useMutation(api.chats.createSideChat);
	const remove = useMutation(api.trash.move);
	const rename = useMutation(api.chats.renameChat);
	const [renaming, setRenaming] = useState<Id<"chats">>();
	const { error, run } = useRun();
	const mainId = chat.parentId ?? chat._id;
	const sides = (list?.dms ?? []).filter((d) => d.parentId === mainId);
	const tabs = [{ id: mainId, label: "Main", side: false }, ...sides.map((d) => ({ id: d._id, label: d.label ?? "New chat", side: true }))];
	const side = chat.parentId ? chat : undefined;
	const close = (id: Id<"chats">) => run(remove({ kind: "channel", id }), () => id === chat._id && navigate("chat", mainId));
	// The open tab wears the sidebar's selected pill; the others are quiet text until hovered. A side
	// chat's × shows on hover at the pill's right edge, on a patch of the pill's own colour (`--pill`)
	// that fades in over the label's tail, so every tab keeps the same width and nothing shifts.
	const pill = (open: boolean) =>
		`group/tab relative flex shrink-0 rounded-md bg-(--pill) text-sm ${open ? "font-medium text-neutral-900 [--pill:color-mix(in_oklab,var(--color-neutral-200)_70%,white)]" : "font-normal text-neutral-500 hover:text-neutral-900 hover:[--pill:var(--color-neutral-100)]"}`;
	const label = "max-w-48 shrink-0 truncate px-2 py-1";
	// More tabs than fit scroll sideways (no scrollbar; the open one is scrolled into view), while the agent's name and + stay put.
	const strip = useRef<HTMLDivElement>(null);
	useEffect(() => {
		strip.current?.querySelector('[aria-current="page"], [aria-expanded]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [chat._id]);
	return (
		<nav aria-label={`Chats with ${chat.title}`} className="no-drag flex min-w-0 flex-1 items-center gap-1 self-center">
			<span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-neutral-200" />
			<div ref={strip} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
			{tabs.map((t) => (
				<div key={t.id} className={pill(t.id === chat._id)}>
					{renaming === t.id ? (
						<RenameInput value={t.label} onSave={(title) => run(rename({ chatId: t.id, title }))} onDone={() => setRenaming(undefined)} className="w-40 px-2 py-1" />
					) : t.id === chat._id && side ? (
						<Popover trigger={<span onDoubleClick={() => setRenaming(t.id)}>{t.label}</span>} className={label} panelClassName="w-52 p-1">
							{(close) => <MenuItem onClick={() => (close(), setRenaming(t.id))}><EditIcon /> Rename</MenuItem>}
						</Popover>
					) : (
						<button type="button" aria-current={t.id === chat._id ? "page" : undefined} onClick={() => navigate("chat", t.id)} onDoubleClick={t.side ? () => setRenaming(t.id) : undefined} className={label}>
							{t.label}
						</button>
					)}
					{t.side && renaming !== t.id && (
						// Only the glyph takes clicks; the faded patch under it is just paint, so the label's tail still opens the tab.
						<span className="pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-end rounded-r-md bg-[linear-gradient(to_right,transparent,var(--pill)_14px)] pr-1 opacity-0 focus-within:opacity-100 group-hover/tab:opacity-100">
							<button type="button" title="Close (goes to Trash)" aria-label={`Close ${t.label}`} onClick={() => close(t.id)} className="pointer-events-auto flex size-5 items-center justify-center rounded text-neutral-500 hover:bg-neutral-300/60 hover:text-neutral-900">
								<CloseIcon className="size-3.5" weight="bold" />
							</button>
						</span>
					)}
				</div>
			))}
			</div>
			<button type="button" title="New chat" aria-label={`New chat with ${chat.title}`} onClick={() => run(create({ parentId: mainId }).then((id) => navigate("chat", id)))} className="flex size-6 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900">
				<PlusIcon />
			</button>
			<Notice>{error}</Notice>
		</nav>
	);
}
