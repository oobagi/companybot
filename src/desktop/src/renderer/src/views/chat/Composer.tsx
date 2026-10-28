import type { Doc, Id } from "@companybot/backend/convex/_generated/dataModel";
import { type ReactNode, useRef, useState } from "react";
import { ArrowUpIcon } from "../../icons";
import { Avatar } from "./common";
import type { Mentions, Participant } from "./data";
import { Form, metadataClass } from "../../ui";

export type SendWith = Doc<"preferences">["sendWith"];

/** The `@query` being typed before the caret: `@` and up to one space ("@Sam L"). */
const mentionAt = (text: string, caret: number) => {
	const m = /(^|\s)@([^\s@]*(?: [^\s@]*)?)$/.exec(text.slice(0, caret));
	return m ? { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() } : null;
};

const matches = (name: string, query: string) => {
	const n = name.toLowerCase();
	return n.startsWith(query) || n.split(/\s+/).some((w) => w.startsWith(query));
};

export function Composer({
	onSend,
	sendWith,
	placeholder,
	status,
	tray,
	onType,
	candidates,
}: {
	onSend: (text: string, mentions: Mentions) => void;
	sendWith: SendWith;
	placeholder: string;
	/** The line under the box (who's typing). Its space is kept when empty, so the box doesn't jump. */
	status?: ReactNode;
	/** Sits on top of the box, joined to it (the tutorial). */
	tray?: ReactNode;
	onType?: () => void;
	/** People and agents offered by @mention autocomplete. */
	candidates: Participant[];
}) {
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [picked, setPicked] = useState<Participant[]>([]);
	const [index, setIndex] = useState(0);
	const [dismissed, setDismissed] = useState<number>();
	const input = useRef<HTMLTextAreaElement>(null);

	const at = mentionAt(text, caret);
	const options = at && at.start !== dismissed ? candidates.filter((c) => matches(c.name, at.query)).slice(0, 8) : [];
	const open = options.length > 0;
	const active = Math.min(index, options.length - 1);

	const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart);

	const pick = (c: Participant) => {
		if (!at) return;
		const insert = `@${c.name} `;
		const next = text.slice(0, at.start) + insert + text.slice(caret);
		const pos = at.start + insert.length;
		setText(next);
		setCaret(pos);
		setIndex(0);
		if (!picked.some((p) => p.id === c.id)) setPicked([...picked, c]);
		requestAnimationFrame(() => input.current?.setSelectionRange(pos, pos));
	};

	const submit = () => {
		if (!text.trim()) return;
		// Only mentions still in the text count.
		const kept = picked.filter((p) => text.includes(`@${p.name}`));
		onSend(text, {
			userIds: kept.filter((p) => p.type === "user").map((p) => p.id as Id<"users">),
			agentIds: kept.filter((p) => p.type === "agent").map((p) => p.id as Id<"agents">),
		});
		setText("");
		setPicked([]);
	};

	return (
		<div className="relative flex w-full flex-col gap-1.5">
			{open && (
				<ul className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
					{options.map((c, i) => (
						<li key={c.id}>
							<button
								type="button"
								onMouseDown={(e) => (e.preventDefault(), pick(c))}
								onMouseEnter={() => setIndex(i)}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === active ? "bg-neutral-100" : ""}`}
							>
								<Avatar name={c.name} image={c.image} agent={c.type === "agent"} size="sm" />
								<span className="flex-1 truncate">{c.name}</span>
								{c.type === "agent" && <span className={metadataClass}>Agent</span>}
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-col">
			{tray}
			<Form className="flex w-full items-end gap-2 rounded-2xl border border-neutral-200 bg-white p-2 pl-4 shadow-sm focus-within:border-neutral-300" onSubmit={() => submit()}>
				<textarea
					ref={input}
					rows={1}
					value={text}
					autoFocus
					onChange={(e) => {
						setText(e.target.value);
						if (e.target.value.trim()) onType?.();
						track(e.target);
						setIndex(0);
						setDismissed(undefined);
					}}
					onSelect={(e) => track(e.currentTarget)}
					onKeyDown={(e) => {
						if (open) {
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								const step = e.key === "ArrowDown" ? 1 : -1;
								setIndex((active + step + options.length) % options.length);
								return;
							}
							if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								pick(options[active]!);
								return;
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setDismissed(at?.start);
								return;
							}
						}
						const mod = e.metaKey || e.ctrlKey;
						if (e.key === "Enter" && (sendWith === "enter" ? !e.shiftKey && !mod : mod)) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={placeholder}
					className="max-h-48 flex-1 resize-none bg-transparent py-1.5 outline-none [field-sizing:content] placeholder:text-neutral-400"
				/>
				<button
					type="submit"
					disabled={!text.trim()}
					className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white disabled:bg-neutral-200"
					aria-label="Send"
				>
					<ArrowUpIcon weight="bold" />
				</button>
			</Form>
			</div>
			<p className="h-4 truncate px-4 text-xs text-neutral-400" aria-live="polite">
				{status}
			</p>
		</div>
	);
}
