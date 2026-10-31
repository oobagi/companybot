import { actionLabel, toolLine } from "@companybot/core/action-words";
import { splitLinks } from "@companybot/core/link-preview";
import { Fragment, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { Notice, timeAgo } from "../../ui";
import { WidgetView } from "../../widgets";
import { CallDetails } from "../Activity";
import { ApprovalMessages } from "./Approval";
import { AutomationIcon, EditIcon, ReactIcon, ReplyIcon, TrashIcon } from "../../icons";
import { AgentBadge, Avatar, AvatarStack, EmojiPicker, IconButton, Popover, clock, useConfirm, useDismiss } from "./common";
import type { Message, TokenNames } from "./data";
import { navigate } from "../../router";
import { ProfileLink } from "./Profile";
import { MessageFiles } from "./Attachments";
import { LinkPreviews } from "./LinkPreviews";

export function MessageRow({
	message: row,
	grouped,
	tokens,
	onOpenThread,
	onError,
}: {
	message: Message;
	/** Same author as the message above: no avatar or name. */
	grouped: boolean;
	/** What to show as chips: @names, #channels, /skills. */
	tokens: TokenNames;
	/** Absent inside a thread: threads are one level deep. */
	onOpenThread?: () => void;
	onError: (e: unknown) => void;
}) {
	// A reply streams into its own small query (backend replyStreams): only this row re-renders per token.
	const live = useQuery(api.messages.stream, row.status === "streaming" ? { messageId: row._id } : "skip");
	const message = live ? { ...row, ...live } : row;
	const react = useMutation(api.messages.react);
	const remove = useMutation(api.messages.remove);
	const [picker, setPicker] = useState(false);
	const [editing, setEditing] = useState(false);
	const toolbar = useDismiss<HTMLDivElement>(() => setPicker(false), picker);
	const { confirm, dialog } = useConfirm();
	const isAgent = message.author.type === "agent";
	const sending = message.sending;
	const toggle = (emoji: string) => react({ messageId: message._id, emoji }).catch(onError);

	const held = isAgent && !message.deleted ? message.parts.filter((p) => p.type === "approval") : [];

	// A reply shows whole once it's written; meanwhile the line under the composer says what the agent is
	// doing. A card asking permission shows at once, since the reply waits on it.
	if (message.status === "streaming" && held.length === 0) return null;
	if (held.length > 0 && held.length === message.parts.length && !message.text) return <ApprovalMessages message={message} parts={held} />;

	return (
		<>
			<div
				id={`message-${message._id}`}
				className={`group relative flex gap-3 px-5 hover:bg-neutral-50/80 ${grouped ? "py-0.5" : "pt-2 pb-0.5"}`}
			>
				<div className="flex w-9 shrink-0 items-start justify-center">
					{grouped ? (
						<span className="invisible pt-1 text-[10px] text-neutral-400 tabular-nums group-hover:visible">
							{clock(message._creationTime)}
						</span>
					) : (
						<ProfileLink who={message.author}>
							<Avatar name={message.author.name} image={message.author.image} agent={isAgent} />
						</ProfileLink>
					)}
				</div>
				<div className={`flex min-w-0 flex-1 flex-col gap-1 ${sending ? "opacity-50" : ""}`}>
					{!grouped && (
						<div className="flex items-baseline gap-2">
							<ProfileLink who={message.author} className="font-semibold hover:underline">
								{message.author.name}
							</ProfileLink>
							{isAgent && <AgentBadge />}
							{message.automation && (
								<span className="flex items-center gap-1 self-center rounded bg-amber-50 px-1.5 text-xs text-amber-800">
									<AutomationIcon /> {message.automation.name}
								</span>
							)}
							<span className="text-xs text-neutral-400 tabular-nums">{clock(message._creationTime)}</span>
						</div>
					)}
					{message.deleted ? (
						<p className="text-neutral-400 italic">This message was deleted.</p>
					) : editing ? (
						<EditForm message={message} onDone={() => setEditing(false)} onError={onError} />
					) : message.automation ? (
						<AutomationPrompt prompt={message.text} />
					) : isAgent ? (
						<AgentBody message={message} />
					) : (
						(message.text || message.editedAt) && (
							<p className="leading-relaxed break-words whitespace-pre-wrap">
								<TokenText text={message.text} tokens={tokens} />
								{message.editedAt && <span className="text-xs text-neutral-400"> (edited)</span>}
							</p>
						)
					)}
					{!message.deleted && message.attachments.length > 0 && <MessageFiles files={message.attachments} />}
					{sending && sending.files > 0 && (
						<p className="text-sm text-neutral-500">
							Sending {sending.files} {sending.files === 1 ? "file" : "files"}…
						</p>
					)}
					{!message.deleted && message.linkPreviews.length > 0 && <LinkPreviews message={message} onError={onError} />}
					{message.reactions.length > 0 && (
						<div className="flex flex-wrap gap-1 pt-0.5">
							{message.reactions.map((r) => (
								<button
									type="button"
									key={r.emoji}
									title={r.names.join(", ")}
									onClick={() => toggle(r.emoji)}
									className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-sm tabular-nums ${
										r.mine ? "border-neutral-400 bg-neutral-100 text-neutral-900" : "border-neutral-200 text-neutral-600 hover:border-neutral-300"
									}`}
								>
									<span className="text-base leading-none">{r.emoji}</span>
									{r.count}
								</button>
							))}
						</div>
					)}
					{onOpenThread && message.replyCount ? (
						<button
							type="button"
							onClick={onOpenThread}
							className="-ml-1 flex w-fit items-center gap-2 rounded-lg px-1 py-0.5 text-xs hover:bg-white"
						>
							<AvatarStack people={message.replyAuthors} size="xs" />
							<span className="font-medium text-neutral-700">
								{message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
							</span>
							{message.lastReplyAt && <span className="text-neutral-400">Last reply {timeAgo(message.lastReplyAt)}</span>}
						</button>
					) : null}
				</div>
				{!message.deleted && !editing && !sending && (
					<div
						ref={toolbar}
						className={`absolute -top-3 right-5 z-10 items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm ${
							picker ? "flex" : "hidden group-hover:flex"
						}`}
					>
						<IconButton label="Add reaction" onClick={() => setPicker(!picker)}>
							<ReactIcon />
						</IconButton>
						{onOpenThread && (
							<IconButton label="Reply in thread" onClick={onOpenThread}>
								<ReplyIcon />
							</IconButton>
						)}
						{message.mine && !isAgent && (
							<>
								<IconButton label="Edit" onClick={() => setEditing(true)}>
									<EditIcon />
								</IconButton>
								<IconButton
									label="Delete"
									onClick={() => confirm({ title: "Delete this message?", action: "Delete", onConfirm: () => remove({ messageId: message._id }) })}
								>
									<TrashIcon />
								</IconButton>
							</>
						)}
						{picker && <EmojiPicker className="absolute top-full right-0 mt-1" onPick={toggle} onClose={() => setPicker(false)} />}
					</div>
				)}
			</div>
			{/* Calls held for permission read as their own messages from the agent, after its reply. */}
			{held.length > 0 && <ApprovalMessages message={message} parts={held} />}
			{dialog}
		</>
	);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (names: string[]) => [...names].sort((a, b) => b.length - a.length).map(escape).join("|");

/** `@Ada`, `#sales` (opens the channel) and `/Proposal` as chips, like in the composer. */
/** A person's message: its links open in the browser; @names, #channels and /skills stand out. */
function TokenText({ text, tokens }: { text: string; tokens: TokenNames }) {
	return splitLinks(text).map((part, i) =>
		typeof part === "string" ? (
			<Tokens key={i} text={part} tokens={tokens} />
		) : (
			<a key={i} href={part.url} target="_blank" rel="noreferrer noopener" className="wrap-anywhere text-link hover:underline">
				{part.url}
			</a>
		),
	);
}

function Tokens({ text, tokens }: { text: string; tokens: TokenNames }) {
	const parts = [
		tokens.names.length > 0 && `@(?:${alternation(tokens.names)})(?!\\w)`,
		tokens.channels.length > 0 && `#(?:${alternation(tokens.channels.map((c) => c.name))})(?![\\w-])`,
		tokens.skills.length > 0 && `\\/(?:${alternation(tokens.skills)})(?!\\w)`,
	].filter(Boolean);
	if (parts.length === 0) return text;
	const pattern = new RegExp(`(${parts.join("|")})`, "g");
	return text.split(pattern).map((chunk, i) => {
		if (i % 2 === 0) return <Fragment key={i}>{chunk}</Fragment>;
		const channel = chunk.startsWith("#") ? tokens.channels.find((c) => c.name === chunk.slice(1)) : undefined;
		return channel ? (
			<button type="button" key={i} onClick={() => navigate("chat", channel.id)} className="token hover:underline">
				{chunk}
			</button>
		) : (
			<span key={i} className="token">
				{chunk}
			</span>
		);
	});
}

function EditForm({ message, onDone, onError }: { message: Message; onDone: () => void; onError: (e: unknown) => void }) {
	const edit = useMutation(api.messages.edit);
	const [text, setText] = useState(message.text);
	const save = () => {
		if (!text.trim() || text === message.text) return onDone();
		edit({ messageId: message._id, text }).then(onDone, onError);
	};
	return (
		<div className="flex flex-col gap-1.5">
			<textarea
				value={text}
				autoFocus
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") onDone();
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						save();
					}
				}}
				className="resize-none rounded-xl border border-neutral-300 bg-white px-3 py-2 outline-none [field-sizing:content]"
			/>
			<p className="text-xs text-neutral-400">
				Escape to{" "}
				<button type="button" onClick={onDone} className="text-neutral-600 hover:underline">
					cancel
				</button>{" "}
				· Enter to{" "}
				<button type="button" onClick={save} className="text-neutral-600 hover:underline">
					save
				</button>
			</p>
		</div>
	);
}

function AgentBody({ message }: { message: Message }) {
	const streaming = message.status === "streaming";
	const lastText = message.parts.findLastIndex((p) => p.type === "text");
	return (
		<div className="flex flex-col gap-1">
			{/* 8px: the text's line height adds ~4px above it, so this reads as the 12px between paragraphs. */}
			<div className="flex flex-col gap-2">
				{runs(message.parts).map((run) =>
					Array.isArray(run) ? (
						// A run of tool lines stays together, as tight as the stats line under the reply.
						<div key={run[0]!.id} className="flex flex-col gap-1">
							{run.map((part) => (
								<ToolPart key={part.id} replyId={message._id} part={part} />
							))}
						</div>
					) : run.part.type === "text" ? (
						<Markdown key={run.i} className="leading-relaxed" isAnimating={streaming && run.i === lastText}>
							{run.part.text}
						</Markdown>
					) : run.part.type === "widget" ? (
						<WidgetView key={run.part.id} widget={run.part.widget} />
					) : null,
				)}
				{message.status === "error" && <Notice>{message.error ?? "Something went wrong."}</Notice>}
			</div>
			{message.stats && <ReplyDetails stats={message.stats} />}
		</div>
	);
}

type Part = Message["parts"][number];
type ToolPart = Extract<Part, { type: "tool" }>;

/** Parts in order, with back-to-back tool calls gathered into one list. */
function runs(parts: Part[]) {
	const out: (ToolPart[] | { part: Part; i: number })[] = [];
	parts.forEach((part, i) => {
		const last = out.at(-1);
		if (part.type !== "tool") out.push({ part, i });
		else if (Array.isArray(last)) last.push(part);
		else out.push([part]);
	});
	return out;
}

/** "Sent SMS with Fake CRM"; click to see what went in and came out (from the activity log). */
function ToolPart({ replyId, part }: { replyId: Message["_id"]; part: ToolPart }) {
	// Replies from before tool lines had labels: make one from the name.
	const label = toolLine(part.label ?? (part.name === "connectors_search" ? "Look up connected actions" : actionLabel(part.name)), part.status);
	if (part.status === "running") return <p className="text-xs text-neutral-400">{label}</p>;
	return (
		<div className="flex">
			<Popover trigger={label} className="text-left text-xs text-neutral-400 hover:text-neutral-600" panelClassName="w-[32rem] p-3">
				<CallPanel replyId={replyId} callId={part.id} />
			</Popover>
		</div>
	);
}

/** Loaded only when opened. */
function CallPanel({ replyId, callId }: { replyId: Message["_id"]; callId: string }) {
	const calls = useQuery(api.activity.forReply, { replyId });
	if (!calls) return <p className="text-xs text-neutral-400">Loading…</p>;
	const call = calls.find((c) => c.callId === callId);
	return call ? <CallDetails entry={call} /> : <p className="text-xs text-neutral-400">No details saved.</p>;
}

type Stats = NonNullable<Message["stats"]>;

/** The line under a reply (model, time, cost); click for the full breakdown. */
function ReplyDetails({ stats }: { stats: Stats }) {
	const cost = stats.costUsd + (stats.imageCostUsd ?? 0) + (stats.searchCostUsd ?? 0);
	const rows: [string, string][] = [
		["Model", stats.model],
		["Time", `${seconds(stats.durationMs)}${stats.firstTokenMs !== undefined ? `, first words after ${seconds(stats.firstTokenMs)}` : ""}`],
		["Context", `${tokens(stats.contextTokens)} tokens`],
		["Input", `${tokens(stats.inputTokens)} tokens${stats.cachedInputTokens ? `, ${tokens(stats.cachedInputTokens)} cached` : ""}`],
		["Output", `${tokens(stats.outputTokens)} tokens`],
		["Model calls", String(stats.steps)],
		...(stats.imageCostUsd ? ([["Pictures", usd(stats.imageCostUsd)]] as [string, string][]) : []),
		...(stats.searchCostUsd ? ([["Web search", usd(stats.searchCostUsd)]] as [string, string][]) : []),
		["This reply", usd(cost)],
		["Here so far", usd(stats.conversationCostUsd)],
	];
	return (
		<div className="flex">
			<Popover
				trigger={`${shortModel(stats.model)} · ${seconds(stats.durationMs)} · ${tokens(stats.contextTokens)} context · ${usd(cost)} · ${usd(stats.conversationCostUsd)} total`}
				className="text-left text-xs text-neutral-400 tabular-nums hover:text-neutral-600"
				panelClassName="w-80 p-3"
			>
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs tabular-nums">
					{rows.map(([label, value]) => (
						<Fragment key={label}>
							<dt className="text-neutral-500">{label}</dt>
							<dd className="break-words">{value}</dd>
						</Fragment>
					))}
				</dl>
			</Popover>
		</div>
	);
}

const shortModel = (id: string) => id.split("/").at(-1) ?? id;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : n < 1 ? 3 : 2)}`;

/** A message an automation posted for its author: collapsed, since they didn't type it. */
function AutomationPrompt({ prompt }: { prompt: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<button type="button" onClick={() => setOpen(!open)} className="self-start text-sm text-neutral-500 hover:text-neutral-800">
				Ran automatically · {open ? "Hide" : "Show"} what it asked
			</button>
			{open && <p className="text-sm leading-relaxed whitespace-pre-wrap text-neutral-600">{prompt}</p>}
		</div>
	);
}
