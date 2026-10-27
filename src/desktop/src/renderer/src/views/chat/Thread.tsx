import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api, errorMessage } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Loading, Notice } from "../../ui";
import { CloseIcon } from "../../icons";
import { IconButton } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type Participant, chatTitle } from "./data";
import { MessageList } from "./MessageList";
import { TypingLine, useTypingPing } from "./Typing";

export function ThreadPanel({
	chat,
	threadId,
	sendWith,
	candidates,
	names,
	onClose,
}: {
	chat: ChatDetails;
	threadId: Id<"chatMessages">;
	sendWith: SendWith;
	candidates: Participant[];
	names: string[];
	onClose: () => void;
}) {
	const messages = useQuery(api.messages.list, { chatId: chat._id, threadId });
	const send = useMutation(api.messages.send);
	const typing = useTypingPing(chat._id, threadId);
	const [error, setError] = useState<string>();
	const onError = (e: unknown) => setError(errorMessage(e));

	const header = (
		<header className="drag flex h-12 shrink-0 items-center gap-2 px-5">
			<h2 className="text-sm font-semibold">Thread</h2>
			<span className="truncate text-sm text-neutral-400">{chatTitle(chat)}</span>
			<span className="ml-auto">
				<IconButton label="Close thread" onClick={onClose}>
					<CloseIcon />
				</IconButton>
			</span>
		</header>
	);
	const footer = (
		<div className="flex flex-col gap-2 px-4 pt-4 pb-4">
			{error && <Notice>{error}</Notice>}
			<Composer
				key={threadId}
				sendWith={sendWith}
				placeholder="Reply…"
				candidates={candidates}
				status={<TypingLine chatId={chat._id} threadId={threadId} />}
				onType={typing.ping}
				onSend={(text, mentions) => {
					setError(undefined);
					typing.sent();
					send({ chatId: chat._id, threadId, text, mentions }).catch(onError);
				}}
			/>
		</div>
	);

	return (
		<aside className="flex w-[26rem] shrink-0 flex-col border-l border-neutral-200">
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
					names={names}
					summaryLabel="Agents"
					onError={onError}
					header={header}
					footer={footer}
				/>
			)}
		</aside>
	);
}
