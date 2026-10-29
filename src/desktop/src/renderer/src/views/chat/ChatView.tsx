import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { ChannelIcon, ChatIcon, PrivateIcon } from "../../icons";
import { EmptyState, Loading, NotFound, Notice, Scroll, TopBar, useRun } from "../../ui";
import { FileDrop, useAttachments } from "./Attachments";
import { AgentBadge, AvatarStack } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type Mentions, chatTitle, useDirectory } from "./data";
import { ChannelDetails } from "./dialogs";
import { MessageList } from "./MessageList";
import { ThreadPanel } from "./Thread";
import { TrashNotice } from "../Trash";
import { TutorialTray } from "./Tutorial";
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
	const sendMessage = useMutation(api.messages.send);
	const markRead = useMutation(api.chats.markRead);
	const directory = useDirectory();
	const [threadId, setThreadId] = useState<Id<"chatMessages">>();
	const [details, setDetails] = useState(false);
	const { error, fail } = useRun();
	const [nudge, setNudge] = useState(0);

	// A link to a thread opens it; a link to a message scrolls to it once it's loaded.
	const focusThread = focus && "thread" in focus ? focus.thread : undefined;
	const focusMessage = focus && "message" in focus ? focus.message : undefined;
	useEffect(() => {
		if (focusThread) setThreadId(focusThread as Id<"chatMessages">);
	}, [focusThread]);
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
	const files = useAttachments();
	const send = (text: string, mentions: Mentions, attachments: Id<"_storage">[] = []) => {
		fail();
		typing.sent();
		// Posting in #general without asking an agent: remind them of step 1.
		if (chat.isDefault && mentions.agentIds.length === 0) setNudge((n) => n + 1);
		sendMessage({ chatId: chat._id, text, mentions, attachments }).catch(fail);
	};
	const composer = (
		<Composer
			sendWith={sendWith}
			placeholder={`Message ${title}`}
			status={<TypingLine chatId={chat._id} />}
			// Channels only: it teaches @mentions, and a DM is a step of its own.
			tray={chat.kind === "channel" && <TutorialTray agent={directory.agents[0]?.name ?? "an agent"} nudge={nudge} />}
			// Nobody else could see it in an agent DM.
			onType={agent ? undefined : typing.ping}
			sources={directory}
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
					<h1 className="flex min-w-0 items-center gap-1 truncate">
						{chat.private && chat.kind === "channel" && <PrivateIcon className="shrink-0 text-neutral-400" />}
						{title}
					</h1>
					{agent && <AgentBadge />}
				</>
			}
			description={chat.topic}
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
						onOpenThread={setThreadId}
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
					onClose={() => setThreadId(undefined)}
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
