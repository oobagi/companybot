import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { Loading, Notice } from "../../ui";
import { AgentBadge, AvatarStack } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type Mentions, chatTitle, useDirectory } from "./data";
import { ChannelDetails } from "./dialogs";
import { MessageList } from "./MessageList";
import { ThreadPanel } from "./Thread";

const suggestions = [
	"What do you remember about me?",
	"Show the 5 largest US cities in a table",
	"Remember that I prefer mornings for meetings.",
];

/** A message to show on opening, from a link elsewhere (a record's discussion): its thread, or the message itself. */
export type ChatFocus = { thread: string } | { message: string };

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
	if (!chat) {
		return (
			<>
				<div className="drag h-12 shrink-0" />
				{chat === null ? <p className="p-8 text-sm text-neutral-500">This chat isn't available.</p> : <Loading />}
			</>
		);
	}
	return <OpenChat chat={chat} sendWith={sendWith} focus={focus} onLeft={onLeft} />;
}

function OpenChat({ chat, sendWith, focus, onLeft }: { chat: ChatDetails; sendWith: SendWith; focus?: ChatFocus; onLeft: () => void }) {
	const messages = useQuery(api.messages.list, { chatId: chat._id });
	const sendMessage = useMutation(api.messages.send);
	const markRead = useMutation(api.chats.markRead);
	const directory = useDirectory();
	const [threadId, setThreadId] = useState<Id<"chatMessages">>();
	const [details, setDetails] = useState(false);
	const [error, setError] = useState<string>();
	const onError = (e: unknown) => setError(errorMessage(e));

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
	const candidates = [...directory.people, ...directory.agents];
	const send = (text: string, mentions: Mentions) => {
		setError(undefined);
		sendMessage({ chatId: chat._id, text, mentions }).catch(onError);
	};
	const composer = (
		<Composer
			sendWith={sendWith}
			placeholder={`Message ${title}`}
			hint={!agent && (chat.kind === "channel" || chat.members.some((m) => m.type === "agent")) ? "@mention an agent to ask it" : undefined}
			candidates={candidates}
			onSend={send}
		/>
	);

	return (
		<div className="flex min-h-0 flex-1">
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-neutral-200 px-5">
					<div className="flex min-w-0 items-baseline gap-2">
						<h1 className="truncate font-semibold">
							{chat.private && chat.kind === "channel" && <span className="mr-1 text-neutral-400">🔒</span>}
							{title}
						</h1>
						{agent && <AgentBadge />}
						{chat.topic && <p className="truncate text-sm text-neutral-500">{chat.topic}</p>}
					</div>
					{!agent && (
						<button
							type="button"
							onClick={() => setDetails(true)}
							title="Members and details"
							className="no-drag ml-auto flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
						>
							<AvatarStack people={chat.members} />
							{chat.members.length}
						</button>
					)}
				</header>

				{!messages ? (
					<Loading />
				) : agent && messages.length === 0 ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-24">
						<h1 className="text-2xl font-medium tracking-tight">What can {agent.name} do for you?</h1>
						<div className="w-full max-w-2xl">{composer}</div>
						<div className="flex max-w-xl flex-wrap justify-center gap-2">
							{suggestions.map((s) => (
								<button
									type="button"
									key={s}
									onClick={() => send(s, { userIds: [], agentIds: [] })}
									className="rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
								>
									{s}
								</button>
							))}
						</div>
						{error && <Notice>{error}</Notice>}
					</div>
				) : (
					<>
						<MessageList
							chatId={chat._id}
							messages={messages}
							names={directory.names}
							summaryLabel={agent?.name ?? "Agents"}
							onOpenThread={setThreadId}
							onError={onError}
							intro={messages.length < 200 && <Intro title={title} channel={chat.kind === "channel"} />}
						/>
						<div className="flex flex-col gap-2 px-5 pb-5">
							{error && <Notice>{error}</Notice>}
							{composer}
						</div>
					</>
				)}
			</div>
			{threadId && (
				<ThreadPanel
					key={threadId}
					chat={chat}
					threadId={threadId}
					sendWith={sendWith}
					candidates={candidates}
					names={directory.names}
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
