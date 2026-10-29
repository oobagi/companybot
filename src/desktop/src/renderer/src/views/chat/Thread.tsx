import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { api } from "../../api";
import { useMutation, useQuery, useWorkspace } from "../../convex";
import { Loading, Notice, useRun } from "../../ui";
import { CloseIcon } from "../../icons";
import { FileDrop, useAttachments } from "./Attachments";
import { IconButton } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type TokenNames, chatTitle } from "./data";
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
	const messages = useQuery(api.messages.list, { chatId: chat._id, threadId });
	const send = useMutation(api.messages.send);
	const typing = useTypingPing(chat._id, threadId);
	const files = useAttachments();
	const workspace = useWorkspace();
	const { error, fail } = useRun();

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
					send({ chatId: chat._id, threadId, text, mentions, attachments }).catch(fail);
				}}
			/>
		</div>
	);

	return (
		<FileDrop attachments={files} className="flex w-[26rem] shrink-0 flex-col border-l border-neutral-200">
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
					onError={fail}
					header={header}
					footer={footer}
				/>
			)}
		</FileDrop>
	);
}
