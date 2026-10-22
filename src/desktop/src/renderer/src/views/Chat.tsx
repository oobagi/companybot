import type { Doc, Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { Markdown } from "../markdown";
import { Loading, Notice } from "../ui";
import { WidgetView } from "../widgets";

const suggestions = [
	"What do you remember about me?",
	"Show the 5 largest US cities in a table",
	"Remember that I prefer mornings for meetings.",
];

type SendWith = "enter" | "mod-enter";

export function Chat({ agent, sendWith }: { agent: { _id: Id<"agents">; name: string }; sendWith: SendWith }) {
	const messages = useQuery(api.chat.messages, { agentId: agent._id });
	const sendMessage = useMutation(api.chat.send);
	const [error, setError] = useState<string>();
	const busy = messages?.at(-1)?.status === "streaming";

	const send = (text: string) => {
		if (busy || !text.trim()) return;
		setError(undefined);
		sendMessage({ agentId: agent._id, text }).catch((e) => setError(errorMessage(e)));
	};

	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	if (!messages) return <Loading />;

	if (messages.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-24">
				<h1 className="text-2xl font-medium tracking-tight">What can {agent.name} do for you?</h1>
				<Composer onSend={send} busy={busy} sendWith={sendWith} placeholder={`Message ${agent.name}`} />
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
				{error && <Notice>{error}</Notice>}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
					{messages.map((m) => (
						<Message key={m._id} message={m} />
					))}
					{error && <Notice>{error}</Notice>}
					<div ref={bottom} />
				</div>
			</div>
			<div className="mx-auto w-full max-w-2xl px-6 pb-6">
				<Composer onSend={send} busy={busy} sendWith={sendWith} placeholder={`Message ${agent.name}`} />
			</div>
		</div>
	);
}

function Message({ message }: { message: Doc<"messages"> }) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<p className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-neutral-100 px-4 py-2.5 leading-relaxed">{message.text}</p>
			</div>
		);
	}
	const streaming = message.status === "streaming";
	const lastText = message.parts.findLastIndex((p) => p.type === "text");
	return (
		<div className="flex flex-col gap-3">
			{message.parts.map((part, i) =>
				part.type === "text" ? (
					<Markdown key={i} className="leading-relaxed" isAnimating={streaming && i === lastText}>
						{part.text}
					</Markdown>
				) : part.type === "tool" ? (
					<p key={part.id} className="text-xs text-neutral-400">
						{part.status === "running" ? "Using" : part.status === "error" ? "Failed" : "Used"} {part.name}
					</p>
				) : (
					<WidgetView key={part.id} widget={part.widget} />
				),
			)}
			{streaming && message.parts.length === 0 && <p className="text-sm text-neutral-400">Thinking…</p>}
			{message.status === "error" && <Notice>{message.error ?? "Something went wrong."}</Notice>}
		</div>
	);
}

function Composer({
	onSend,
	busy,
	sendWith,
	placeholder,
}: {
	onSend: (text: string) => void;
	busy: boolean;
	sendWith: SendWith;
	placeholder: string;
}) {
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
					const mod = e.metaKey || e.ctrlKey;
					if (e.key === "Enter" && (sendWith === "enter" ? !e.shiftKey && !mod : mod)) {
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
