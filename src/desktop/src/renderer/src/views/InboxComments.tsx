import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { ArrowUpIcon, ChatIcon, CloseIcon, EditIcon, TrashIcon } from "../icons";
import { Notice, compactButton, compactPrimaryButton, commentPillButton, rowButton, sendButton, smallIconButton, useRun } from "../ui";
import { Avatar, AvatarStack, clock, dayLabel } from "./chat/common";
import { ProfileLink } from "./chat/Profile";

// Comments on an Inbox message (backend inboxComments.ts): staff only, never sent to the customer.
// Under a message with comments, a short line leads to "N comments", which opens its thread; a message
// without shows "Comment" on hover. In a thread: who said what and when, @mentions, and your own to
// edit or delete.

type Comments = NonNullable<FunctionReturnType<typeof api.inbox.get>>["messages"][number]["comments"];
type Comment = Comments[number];

const COMMENT_MAX = 5_000;

/** A message's comments: the pill (or "Comment" on hover), and its thread when open. `side` is the message's. */
export function Thread({ messageId, comments, side }: { messageId: Id<"inboxMessages">; comments: Comments; side: "them" | "us" }) {
	const [open, setOpen] = useState(false);
	const left = side === "them";
	if (open)
		return (
			<div className={`flex w-full pt-1.5 ${left ? "justify-start" : "justify-end"}`}>
				<ThreadCard messageId={messageId} comments={comments} onClose={() => setOpen(false)} />
			</div>
		);
	if (!comments.length)
		return (
			<div className={`flex pt-1.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 ${left ? "justify-start" : "justify-end"}`}>
				<button type="button" className={commentPillButton} onClick={() => setOpen(true)}>
					<ChatIcon /> Comment
				</button>
			</div>
		);
	// Who's in the thread, each once, in the order they joined it.
	const authors = [...new Map(comments.map((k) => [`${k.author.type}:${k.author.id}`, k.author])).values()];
	return (
		<div className={`flex pt-1.5 ${left ? "justify-start" : "justify-end"}`}>
			<button type="button" className={`group/pill ${commentPillButton} pl-1`} onClick={() => setOpen(true)}>
				<AvatarStack people={authors} size="xs" ring="ring-neutral-100 group-hover/pill:ring-neutral-200" />
				{comments.length === 1 ? "1 comment" : `${comments.length} comments`}
			</button>
		</div>
	);
}

function ThreadCard({ messageId, comments, onClose }: { messageId: Id<"inboxMessages">; comments: Comments; onClose: () => void }) {
	const add = useMutation(api.inboxComments.add);
	const card = useRef<HTMLElement>(null);
	// Opening it, or a new comment, keeps the whole card (and its reply box) in view.
	useEffect(() => {
		card.current?.scrollIntoView({ block: "nearest" });
	}, [comments.length]);
	return (
		<section
			ref={card}
			aria-label="Comments"
			onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && onClose()}
			className="flex w-full max-w-[75%] flex-col gap-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white pt-3 text-sm shadow-sm [&>*]:px-3"
		>
			<div className="flex items-center gap-2 text-neutral-600">
				<ChatIcon />
				<span className="flex-1 font-medium">{comments.length ? (comments.length === 1 ? "1 comment" : `${comments.length} comments`) : "Comment for staff"}</span>
				<button type="button" aria-label="Close comments" title="Close" className={smallIconButton} onClick={onClose}>
					<CloseIcon />
				</button>
			</div>
			{comments.map((k) => (
				<CommentRow key={k.id} comment={k} />
			))}
			<CommentBox footer placeholder={comments.length ? "Reply for staff…" : "Only staff see comments…"} autoFocus onSave={(text, mentions) => add({ messageId, text, mentions })} />
		</section>
	);
}

function CommentRow({ comment: k }: { comment: Comment }) {
	const edit = useMutation(api.inboxComments.edit);
	const remove = useMutation(api.inboxComments.remove);
	const [editing, setEditing] = useState(false);
	const { error, run } = useRun();
	return (
		<div className="group/comment flex items-start gap-2.5">
			<Avatar name={k.author.name} image={k.author.image} agent={k.author.type === "agent"} size="sm" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="flex items-baseline gap-2">
					<ProfileLink who={k.author} className="font-medium text-neutral-900 hover:underline">
						{k.author.name}
					</ProfileLink>
					<span className="text-xs text-neutral-400">
						{dayLabel(k.at)}, {clock(k.at)}
						{k.edited && " (edited)"}
					</span>
					{k.mine && !editing && (
						<span className="ml-auto flex gap-0.5 opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100">
							<button type="button" aria-label="Edit comment" title="Edit" className={smallIconButton} onClick={() => setEditing(true)}>
								<EditIcon />
							</button>
							<button type="button" aria-label="Delete comment" title="Delete" className={smallIconButton} onClick={() => run(remove({ id: k.id }))}>
								<TrashIcon />
							</button>
						</span>
					)}
				</p>
				{editing ? (
					<CommentBox
						initial={k.text}
						initialMentions={k.mentions}
						autoFocus
						onSave={(text, mentions) => edit({ id: k.id, text, mentions }).then(() => setEditing(false))}
						onCancel={() => setEditing(false)}
					/>
				) : (
					<p className="whitespace-pre-wrap text-neutral-700 select-text">
						<Mentioned text={k.text} names={k.mentions.map((m) => m.name)} />
					</p>
				)}
				<Notice>{error}</Notice>
			</div>
		</div>
	);
}

/** The text, with each @Name it mentions picked out. */
function Mentioned({ text, names }: { text: string; names: string[] }) {
	if (!names.length) return text;
	const escaped = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const parts = text.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
	return parts.map((part, i) => (i % 2 ? <span key={i} className="rounded bg-neutral-100 px-0.5 font-medium text-neutral-900">{part}</span> : <Fragment key={i}>{part}</Fragment>));
}

type Person = { userId: Id<"users">; name: string; image: string | null };

/**
 * Writing a comment: Enter saves, Shift+Enter starts a new line. Typing @ lists teammates who can use
 * Inbox; picking one puts @Name in and mentions them (still mentioned while @Name is in the text).
 */
function CommentBox({
	initial = "",
	initialMentions = [],
	footer,
	placeholder,
	autoFocus,
	onSave,
	onCancel,
}: {
	initial?: string;
	initialMentions?: { id: string; name: string }[];
	/** The thread's reply box: the card's bottom strip, with a send button. Otherwise (editing) a plain field. */
	footer?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	onSave: (text: string, mentions: Id<"users">[]) => Promise<unknown>;
	onCancel?: () => void;
}) {
	const team = useQuery(api.workspace.team);
	const field = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState(initial);
	const [picked, setPicked] = useState(() => new Map(initialMentions.map((m) => [m.name, m.id as Id<"users">])));
	const [query, setQuery] = useState<{ at: number; text: string } | null>(null);
	const [active, setActive] = useState(0);
	const { error, busy, run } = useRun();
	const people: Person[] = (team?.members ?? []).filter((m) => m.inbox).map((m) => ({ userId: m.userId, name: m.name || m.email, image: m.image }));
	const matches = query ? people.filter((p) => p.name.toLowerCase().includes(query.text.toLowerCase())).slice(0, 6) : [];

	// After each change: is the caret just after "@something"? Then that's what the list filters by.
	const look = (value: string, caret: number) => {
		const before = value.slice(0, caret);
		const found = /(?:^|\s)@([^\s@]{0,30})$/.exec(before);
		setQuery(found ? { at: caret - found[1]!.length - 1, text: found[1]! } : null);
		setActive(0);
	};
	const choose = (p: Person) => {
		if (!query) return;
		const el = field.current;
		const end = query.at + 1 + query.text.length;
		const next = `${text.slice(0, query.at)}@${p.name} ${text.slice(end)}`;
		setText(next);
		setPicked(new Map(picked).set(p.name, p.userId));
		setQuery(null);
		const caret = query.at + p.name.length + 2;
		requestAnimationFrame(() => (el?.focus(), el?.setSelectionRange(caret, caret)));
	};
	const save = () => {
		if (!text.trim() || busy) return;
		const mentions = [...picked].filter(([name]) => text.includes(`@${name}`)).map(([, id]) => id);
		run(
			onSave(text, mentions).then(() => {
				setText("");
				setPicked(new Map());
			}),
		);
	};
	return (
		<div className={`relative flex flex-col gap-1.5 ${footer ? "border-t border-neutral-200" : ""}`}>
			{matches.length > 0 && (
				<ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-0 z-10 mb-1 flex w-56 flex-col rounded-xl border border-neutral-200 bg-white p-1 shadow-lg">
					{matches.map((p, i) => (
						<li key={p.userId} role="option" aria-selected={i === active}>
							<button
								type="button"
								onMouseDown={(e) => (e.preventDefault(), choose(p))}
								className={`${rowButton} items-center gap-2 ${i === active ? "bg-neutral-100" : ""}`}
							>
								<Avatar name={p.name} image={p.image} size="xs" />
								<span className="truncate">{p.name}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<div className={footer ? "flex items-end gap-2 py-2" : "flex rounded-lg border border-neutral-200 bg-white px-2.5 py-1 focus-within:border-neutral-300"}>
				<textarea
					ref={field}
					aria-label="Comment"
					rows={1}
					autoFocus={autoFocus}
					maxLength={COMMENT_MAX}
					value={text}
					placeholder={placeholder}
					onChange={(e) => (setText(e.target.value), look(e.target.value, e.target.selectionStart))}
					onKeyDown={(e) => {
						if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
							e.preventDefault();
							setActive((active + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
						} else if (matches.length && (e.key === "Enter" || e.key === "Tab")) {
							e.preventDefault();
							choose(matches[active]!);
						} else if (e.key === "Escape" && (query || onCancel)) {
							e.preventDefault();
							query ? setQuery(null) : onCancel?.();
						} else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							save();
						}
					}}
					className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-5 outline-none"
				/>
				{footer && (
					<button type="button" aria-label="Comment" disabled={busy || !text.trim()} className={`${sendButton} -mr-1 size-7`} onClick={save}>
						<ArrowUpIcon weight="bold" />
					</button>
				)}
			</div>
			{onCancel && (
				<div className="flex justify-end gap-2">
					<button type="button" className={compactButton} onClick={onCancel}>
						Cancel
					</button>
					<button type="button" disabled={busy || !text.trim()} className={compactPrimaryButton} onClick={save}>
						Save
					</button>
				</div>
			)}
			<Notice>{error}</Notice>
		</div>
	);
}
