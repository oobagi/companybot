import type { Doc } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";

const suggestions = [
	"What do you remember about our team?",
	"Remember that I prefer mornings for meetings.",
	"What time is it?",
];

export function Chat({ agent }: { agent: { id: string; name: string } }) {
	const messages = useQuery(api.chat.messages, { agentId: agent.id });
	const sendMessage = useMutation(api.chat.send);
	const [error, setError] = useState<string>();
	const busy = messages?.at(-1)?.status === "streaming";

	const send = (text: string) => {
		if (busy || !text.trim()) return;
		setError(undefined);
		sendMessage({ agentId: agent.id, text }).catch((e) => setError(errorMessage(e)));
	};

	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	if (!messages) return null;

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
				<Composer onSend={send} busy={busy} placeholder={`Message ${agent.name}`} />
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
	return (
		<div className="flex flex-col gap-1.5">
			{message.tools.map((t) => (
				<p key={t.id} className="text-xs text-neutral-400">
					{t.status === "running" ? "Using" : t.status === "error" ? "Failed" : "Used"} {t.name}
				</p>
			))}
			{message.text && <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>}
			{message.status === "streaming" && !message.text && <p className="text-sm text-neutral-400">Thinking…</p>}
			{message.status === "error" && <Notice>{message.error ?? "Something went wrong."}</Notice>}
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
