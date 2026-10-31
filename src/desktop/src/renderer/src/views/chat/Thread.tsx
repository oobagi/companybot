import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { api } from "../../api";
import { useMutation, useQuery, useWorkspace } from "../../convex";
import { Loading, Notice, ResizeHandle, useRun, useStoredWidth } from "../../ui";
import { CloseIcon } from "../../icons";
import { FileDrop, useAttachments } from "./Attachments";
import { IconButton } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type TokenNames, chatTitle, showSending } from "./data";
import { draftKey } from "./drafts";
import type { Sources } from "./editor";
import { MessageList } from "./MessageList";
import { TypingLine, useTypingPing } from "./Typing";

export function ThreadPanel({
	chat,
	threadId,
	sendWith,
	sources,
	tokens,
	onClose,
}: {
	chat: ChatDetails;
	threadId: Id<"chatMessages">;
	sendWith: SendWith;
	sources: Sources;
	tokens: TokenNames;
	onClose: () => void;
}) {
	const size = useStoredWidth("thread.width", 416, 280, 800);
	const messages = useQuery(api.messages.list, { chatId: chat._id, threadId });
	const send = useMutation(api.messages.send, showSending);
	const typing = useTypingPing(chat._id, threadId);
	const workspace = useWorkspace();
	const files = useAttachments(draftKey(workspace?.id, chat._id, threadId));
	const { error, fail } = useRun();
	// An agent's ask of another (chat.ask_agent) shows read-only: the person steps in from the chat.
	const ask = messages?.[0]?.ask;

	const header = (
		<header className="drag flex h-12 shrink-0 items-center gap-2 px-5">
			<h2 className="shrink-0 text-sm font-semibold">{ask ? `${ask.from} asked ${ask.to}` : "Thread"}</h2>
			<span className="truncate text-sm text-neutral-400">{chatTitle(chat)}</span>
			<span className="ml-auto">
				<IconButton label="Close thread" onClick={onClose}>
					<CloseIcon />
				</IconButton>
			</span>
		</header>
	);
	const footer = ask ? (
		<div className="flex flex-col gap-1 px-5 pt-3 pb-7 text-xs text-neutral-400">
			<Notice>{error}</Notice>
			<TypingLine chatId={chat._id} threadId={threadId} />
			<p>To step in, reply in the chat.</p>
		</div>
	) : (
		<div className="flex flex-col gap-2 px-4 pt-4 pb-7">
			<Notice>{error}</Notice>
			<Composer
				key={threadId}
				sendWith={sendWith}
				placeholder="Reply…"
				sources={sources}
				draftKey={draftKey(workspace?.id, chat._id, threadId)}
				status={<TypingLine chatId={chat._id} threadId={threadId} />}
				onType={typing.ping}
				attachments={files}
				onSend={(text, mentions, attachments) => {
					fail();
					typing.sent();
					const sending = send({ chatId: chat._id, threadId, text, mentions, attachments });
					sending.catch(fail);
					return sending;
				}}
			/>
		</div>
	);

	return (
		<aside style={{ width: size.width }} className="relative flex shrink-0 flex-col border-l border-neutral-200">
			<ResizeHandle side="left" label="Resize thread" size={size} />
			<FileDrop attachments={ask ? undefined : files} className="flex min-h-0 flex-1 flex-col">
			{!messages || messages.length === 0 ? (
				<>
					{header}
					<div className="flex-1">{!messages ? <Loading /> : <p className="p-5 text-sm text-neutral-400">This message is gone.</p>}</div>
					{footer}
				</>
			) : (
				<MessageList
					chatId={chat._id}
					threadId={threadId}
					messages={messages}
					tokens={tokens}
					summaryLabel="Agents"
					readOnly={!!ask}
					onError={fail}
					header={header}
					footer={footer}
				/>
			)}
			</FileDrop>
		</aside>
	);
}
