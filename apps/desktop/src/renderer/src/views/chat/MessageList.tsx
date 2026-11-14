import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { Scroll, smallButton } from "../../ui";
import { CaretDownIcon, CaretRightIcon } from "../../icons";
import { dayLabel, sameDay } from "./common";
import type { Message, TokenNames } from "./data";
import { MessageRow, shows } from "./Message";

/** Consecutive messages from one author within this window share a header. */
const GROUP_MS = 5 * 60 * 1000;

const grouped = (m: Message, prev: Message | undefined) =>
	!!prev &&
	!prev.deleted &&
	prev.author.type === m.author.type &&
	prev.author.id === m.author.id &&
	prev.author.for?.id === m.author.for?.id &&
	m._creationTime - prev._creationTime < GROUP_MS &&
	sameDay(m._creationTime, prev._creationTime);

export function MessageList({
	chatId,
	threadId,
	messages,
	onLoadMore,
	tokens,
	summaryLabel,
	onOpenThread,
	readOnly,
	onError,
	intro,
	header,
	footer,
}: {
	chatId: Id<"chats">;
	threadId?: Id<"chatMessages">;
	messages: Message[];
	/** Loads the page before the oldest shown; unset once there's none (or while one loads). */
	onLoadMore?: () => void;
	tokens: TokenNames;
	/** Who sees the summary, e.g. "Agents" or "Sales Bot". */
	summaryLabel: string;
	onOpenThread?: (id: Id<"chatMessages">) => void;
	/** No reacting or editing (an ask between agents). */
	readOnly?: boolean;
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

	// Older messages land above: keep what you're reading where it is (distance from the bottom).
	const fromBottom = useRef<number | null>(null);
	// A thread's parent stays first: its oldest loaded reply is what changes.
	const oldest = messages[threadId ? 1 : 0]?._id;
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && fromBottom.current !== null) el.scrollTop = el.scrollHeight - fromBottom.current;
		fromBottom.current = null;
	}, [oldest]);
	const loadOlder = () => {
		const el = scroller.current;
		if (!el || !onLoadMore) return;
		fromBottom.current = el.scrollHeight - el.scrollTop;
		onLoadMore();
	};
	// Near the top, or a page too short to scroll: the next older page.
	const NEAR_TOP = 400;
	useEffect(() => {
		const el = scroller.current;
		if (el && onLoadMore && el.scrollTop < NEAR_TOP) loadOlder();
	});

	const upTo = place?.summarizedUpTo ?? null;
	// A thread's parent counts its replies, loaded or not (an ask's doesn't: count what's here).
	const replies = Math.max(messages[0]?.replyCount ?? 0, messages.length - 1);

	return (
		<Scroll
			overlayScrollbar
			ref={scroller}
			header={header}
			footer={footer}
			onScroll={(e) => {
				const el = e.currentTarget;
				nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
				if (el.scrollTop < NEAR_TOP) loadOlder();
			}}
		>
			<div ref={content} className="flex flex-1 flex-col justify-end py-4">
				{intro}
				{messages.map((m, i) => {
					// A reply still being written draws nothing yet, so the next message groups with the one above it.
					const prev = messages.slice(0, i).findLast(shows);
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
								readOnly={readOnly}
								onError={onError}
							/>
							{threadId && i === 0 && messages.length > 1 && (
								<Divider>
									{replies} {replies === 1 ? "reply" : "replies"}
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

function Divider({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 px-5 py-2 text-xs text-neutral-400">
			{children}
			<div className="h-px flex-1 bg-neutral-200" />
		</div>
	);
}

function DayDivider({ ms }: { ms: number }) {
	return (
		<div className="flex items-center gap-3 px-5 pt-4 pb-1 text-xs font-medium text-neutral-500">
			<div className="h-px flex-1 bg-neutral-200" />
			{dayLabel(ms)}
			<div className="h-px flex-1 bg-neutral-200" />
		</div>
	);
}

function SummaryDivider({ label, summary }: { label: string; summary: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2 px-5 py-2">
			<div className="flex items-center gap-3 text-xs text-neutral-400">
				<div className="h-px flex-1 bg-neutral-200" />
				<span className="flex flex-wrap items-center justify-center gap-2 text-center">
					{label} {label === "Agents" ? "see" : "sees"} a summary of the messages above
					<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={smallButton}>
						{open ? <CaretDownIcon /> : <CaretRightIcon />} {open ? "Hide" : "Show"} summary
					</button>
				</span>
				<div className="h-px flex-1 bg-neutral-200" />
			</div>
			{open && (
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">{summary}</Markdown>
			)}
		</div>
	);
}
