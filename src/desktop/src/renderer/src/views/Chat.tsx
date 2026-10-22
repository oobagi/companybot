import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage, getToolName, isToolUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Agent, SERVER_URL, useApi } from "../api";

const suggestions = [
	"What do you remember about our team?",
	"Remember that I prefer mornings for meetings.",
	"What time is it?",
];

/** Loads the saved conversation, then mounts the live chat. */
export function Chat({ agent, userId }: { agent: Agent; userId: string }) {
	const { data: history, error } = useApi<UIMessage[]>(userId, `/agents/${agent.id}/messages`);
	if (error) return <Notice>{error}</Notice>;
	if (!history) return null;
	return <Conversation key={`${userId}:${agent.id}`} agent={agent} userId={userId} history={history} />;
}

function Conversation({ agent, userId, history }: { agent: Agent; userId: string; history: UIMessage[] }) {
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: `${SERVER_URL}/agents/${agent.id}/chat`,
				headers: { "x-user-id": userId },
				// The server keeps the full history; send only the newest message.
				prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
			}),
		[agent.id, userId],
	);
	const { messages, sendMessage, status, error } = useChat({ transport, messages: history });
	const busy = status === "submitted" || status === "streaming";
	const send = (text: string) => !busy && text.trim() && sendMessage({ text: text.trim() });

	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [messages]);

	if (messages.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-24">
				<h1 className="text-2xl font-medium tracking-tight">What can {agent.name} do for you?</h1>
				<Composer onSend={send} busy={busy} placeholder={`Message ${agent.name}`} />
				<div className="flex max-w-xl flex-wrap justify-center gap-2">
					{suggestions.map((s) => (
						<button
							type="button"
							key={s}
							onClick={() => send(s)}
							className="rounded-full border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50"
						>
							{s}
						</button>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
					{messages.map((m) => (
						<Message key={m.id} message={m} />
					))}
					{status === "submitted" && <p className="text-sm text-neutral-400">Thinking…</p>}
					{error && <Notice>{error.message}</Notice>}
					<div ref={bottom} />
				</div>
			</div>
			<div className="mx-auto w-full max-w-2xl px-6 pb-6">
				<Composer onSend={send} busy={busy} placeholder={`Message ${agent.name}`} />
			</div>
		</div>
	);
}

function Message({ message }: { message: UIMessage }) {
	const mine = message.role === "user";
	return (
		<div className={mine ? "flex justify-end" : ""}>
			<div className={mine ? "max-w-[80%] rounded-2xl bg-neutral-100 px-4 py-2.5" : "flex flex-col gap-1.5"}>
				{message.parts.map((part, i) => {
					if (part.type === "text") {
						return (
							<p key={i} className="whitespace-pre-wrap leading-relaxed">
								{part.text}
							</p>
						);
					}
					if (isToolUIPart(part)) {
						return (
							<p key={i} className="text-xs text-neutral-400">
								{part.state === "output-error" ? "Failed" : "Used"} {getToolName(part)}
							</p>
						);
					}
					return null;
				})}
			</div>
		</div>
	);
}

function Composer({ onSend, busy, placeholder }: { onSend: (text: string) => void; busy: boolean; placeholder: string }) {
	const [text, setText] = useState("");
	const submit = () => {
		if (busy || !text.trim()) return;
		onSend(text);
		setText("");
	};
	return (
		<form
			className="flex w-full max-w-2xl items-end gap-2 rounded-3xl border border-neutral-200 bg-white p-2 pl-4 shadow-sm focus-within:border-neutral-300"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<textarea
				rows={1}
				value={text}
				autoFocus
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						submit();
					}
				}}
				placeholder={placeholder}
				className="max-h-40 flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-neutral-400"
			/>
			<button
				type="submit"
				disabled={busy || !text.trim()}
				className="size-8 shrink-0 rounded-full bg-neutral-900 text-white disabled:bg-neutral-200"
				aria-label="Send"
			>
				↑
			</button>
		</form>
	);
}

export function Notice({ children }: { children: React.ReactNode }) {
	return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{children}</p>;
}
