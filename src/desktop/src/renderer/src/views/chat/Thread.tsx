import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Loading, Notice, TopBar, useRun } from "../../ui";
import { CloseIcon } from "../../icons";
import { IconButton } from "./common";
import { Composer, type SendWith } from "./Composer";
import { type ChatDetails, type TokenNames, chatTitle } from "./data";
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
	const { error, fail } = useRun();

	const header = (
		<TopBar title="Thread" description={chatTitle(chat)}>
			<IconButton label="Close thread" onClick={onClose}>
				<CloseIcon />
			</IconButton>
		</TopBar>
	);
	const footer = (
		<div className="flex flex-col gap-2 px-4 pt-4 pb-7">
			<Notice>{error}</Notice>
			<Composer
				key={threadId}
				sendWith={sendWith}
				placeholder="Reply…"
				sources={sources}
				status={<TypingLine chatId={chat._id} threadId={threadId} />}
				onType={typing.ping}
				onSend={(text, mentions) => {
					fail();
					typing.sent();
					send({ chatId: chat._id, threadId, text, mentions }).catch(fail);
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
					tokens={tokens}
					summaryLabel="Agents"
					onError={fail}
					header={header}
					footer={footer}
				/>
			)}
		</aside>
	);
}
