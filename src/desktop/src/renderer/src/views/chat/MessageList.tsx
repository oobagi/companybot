import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { Scroll } from "../../ui";
import { dayLabel, sameDay } from "./common";
import type { Message, TokenNames } from "./data";
import { MessageRow } from "./Message";

/** Consecutive messages from one author within this window share a header. */
const GROUP_MS = 5 * 60 * 1000;

const grouped = (m: Message, prev: Message | undefined) =>
	!!prev &&
	!prev.deleted &&
	prev.author.type === m.author.type &&
	prev.author.id === m.author.id &&
	m._creationTime - prev._creationTime < GROUP_MS &&
	sameDay(m._creationTime, prev._creationTime);

export function MessageList({
	chatId,
	threadId,
	messages,
	tokens,
	summaryLabel,
	onOpenThread,
	onError,
	intro,
	header,
	footer,
}: {
	chatId: Id<"chats">;
	threadId?: Id<"chatMessages">;
	messages: Message[];
	tokens: TokenNames;
	/** Who sees the summary, e.g. "Agents" or "Sales Bot". */
	summaryLabel: string;
	onOpenThread?: (id: Id<"chatMessages">) => void;
	onError: (e: unknown) => void;
	/** Shown above the first message. */
	intro?: React.ReactNode;
	/** The bar above and the composer below; messages scroll under both. */
	header?: React.ReactNode;
	footer?: React.ReactNode;
}) {
	const place = useQuery(api.chats.place, { chatId, threadId });
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);

	// Follow new messages and streaming replies (which grow inside their own rows) only if you're
	// already at the bottom.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || !content.current) return;
		const follow = () => nearBottom.current && (el.scrollTop = el.scrollHeight);
		follow();
		const observer = new ResizeObserver(follow);
		observer.observe(content.current);
		return () => observer.disconnect();
	}, []);

	const upTo = place?.summarizedUpTo ?? null;

	return (
		<Scroll
			ref={scroller}
			header={header}
			footer={footer}
			onScroll={(e) => {
				const el = e.currentTarget;
				nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
			}}
		>
			<div ref={content} className="flex flex-1 flex-col justify-end py-4">
				{intro}
				{messages.map((m, i) => {
					const prev = messages[i - 1];
					const next = messages[i + 1];
					const newDay = !prev || !sameDay(prev._creationTime, m._creationTime);
					return (
						<Fragment key={m._id}>
							{newDay && !threadId && <DayDivider ms={m._creationTime} />}
							<MessageRow
								message={m}
								grouped={!newDay && grouped(m, prev) && !(threadId && i === 1)}
								tokens={tokens}
								onOpenThread={onOpenThread && !threadId ? () => onOpenThread(m._id) : undefined}
								onError={onError}
							/>
							{threadId && i === 0 && messages.length > 1 && (
								<Divider>
									{messages.length - 1} {messages.length === 2 ? "reply" : "replies"}
								</Divider>
							)}
							{place?.summary && upTo !== null && next && m._creationTime <= upTo && next._creationTime > upTo && (
								<SummaryDivider label={summaryLabel} summary={place.summary} />
							)}
						</Fragment>
					);
				})}
				{place?.compacting && <p className="py-2 text-center text-xs text-neutral-400">Summarizing earlier messages…</p>}
			</div>
		</Scroll>
	);
}

const Rule = () => <div className="h-px flex-1 bg-neutral-200" />;

function Divider({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 px-5 py-2 text-xs text-neutral-400">
			{children}
			<Rule />
		</div>
	);
}

function DayDivider({ ms }: { ms: number }) {
	return (
		<div className="flex items-center gap-3 px-5 pt-4 pb-1 text-xs font-medium text-neutral-500">
			<Rule />
			{dayLabel(ms)}
			<Rule />
		</div>
	);
}

function SummaryDivider({ label, summary }: { label: string; summary: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2 px-5 py-2">
			<div className="flex items-center gap-3 text-xs text-neutral-400">
				<Rule />
				<button type="button" onClick={() => setOpen(!open)} className="hover:text-neutral-600">
					{label} {label === "Agents" ? "see" : "sees"} a summary of the messages above · {open ? "Hide" : "Show"} summary
				</button>
				<Rule />
			</div>
			{open && (
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">{summary}</Markdown>
			)}
		</div>
	);
}
