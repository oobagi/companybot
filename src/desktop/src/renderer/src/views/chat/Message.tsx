import { actionLabel, toolLine } from "@companybot/core/action-words";
import { Fragment, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { Notice, timeAgo } from "../../ui";
import { WidgetView } from "../../widgets";
import { CallDetails } from "../Activity";
import { ApprovalMessages } from "./Approval";
import { AutomationIcon, EditIcon, ReactIcon, ReplyIcon, TrashIcon } from "../../icons";
import { AgentBadge, Avatar, AvatarStack, EmojiPicker, Popover, clock, useDismiss } from "./common";
import type { Message } from "./data";
import { ProfileLink } from "./Profile";

export function MessageRow({
	message: row,
	grouped,
	names,
	onOpenThread,
	onError,
}: {
	message: Message;
	/** Same author as the message above: no avatar or name. */
	grouped: boolean;
	/** Names to highlight as @mentions. */
	names: string[];
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
	const isAgent = message.author.type === "agent";
	const toggle = (emoji: string) => react({ messageId: message._id, emoji }).catch(onError);

	const held = isAgent && !message.deleted ? message.parts.filter((p) => p.type === "approval") : [];

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
				<div className="flex min-w-0 flex-1 flex-col gap-1">
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
						<p className="leading-relaxed break-words whitespace-pre-wrap">
							<MentionText text={message.text} names={names} />
							{message.editedAt && <span className="text-xs text-neutral-400"> (edited)</span>}
						</p>
					)}
					{message.reactions.length > 0 && (
						<div className="flex flex-wrap gap-1 pt-0.5">
							{message.reactions.map((r) => (
								<button
									type="button"
									key={r.emoji}
									title={r.names.join(", ")}
									onClick={() => toggle(r.emoji)}
									className={`flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums ${
										r.mine ? "border-neutral-400 bg-neutral-100 text-neutral-900" : "border-neutral-200 text-neutral-600 hover:border-neutral-300"
									}`}
								>
									<span>{r.emoji}</span>
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
				{!message.deleted && !editing && (
					<div
						ref={toolbar}
						className={`absolute -top-3 right-5 z-10 items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm ${
							picker ? "flex" : "hidden group-hover:flex"
						}`}
					>
						<Action label="Add reaction" onClick={() => setPicker(!picker)}>
							<ReactIcon />
						</Action>
						{onOpenThread && (
							<Action label="Reply in thread" onClick={onOpenThread}>
								<ReplyIcon />
							</Action>
						)}
						{message.mine && !isAgent && (
							<>
								<Action label="Edit" onClick={() => setEditing(true)}>
									<EditIcon />
								</Action>
								<Action
									label="Delete"
									onClick={() => confirm("Delete this message?") && remove({ messageId: message._id }).catch(onError)}
								>
									<TrashIcon />
								</Action>
							</>
						)}
						{picker && <EmojiPicker className="absolute top-full right-0 mt-1" onPick={toggle} onClose={() => setPicker(false)} />}
					</div>
				)}
			</div>
			{/* Calls held for permission read as their own messages from the agent, after its reply. */}
			{held.length > 0 && <ApprovalMessages message={message} parts={held} />}
		</>
	);
}

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			className="flex size-7 items-center justify-center rounded-md text-base text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
		>
			{children}
		</button>
	);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function MentionText({ text, names }: { text: string; names: string[] }) {
	if (names.length === 0) return text;
	const pattern = new RegExp(`(@(?:${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")}))`, "g");
	return text.split(pattern).map((chunk, i) =>
		i % 2 === 1 ? (
			<span key={i} className="rounded bg-sky-50 px-0.5 font-medium text-sky-700">
				{chunk}
			</span>
		) : (
			<Fragment key={i}>{chunk}</Fragment>
		),
	);
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
			<div className="flex flex-col gap-3">
				{message.parts.map((part, i) =>
					part.type === "text" ? (
						<Markdown key={i} className="leading-relaxed" isAnimating={streaming && i === lastText}>
							{part.text}
						</Markdown>
					) : part.type === "tool" ? (
						<ToolPart key={part.id} replyId={message._id} part={part} />
					) : part.type === "widget" ? (
						<WidgetView key={part.id} widget={part.widget} />
					) : null,
				)}
				{streaming && message.parts.length === 0 && <p className="text-sm text-neutral-400">Thinking…</p>}
				{message.status === "error" && <Notice>{message.error ?? "Something went wrong."}</Notice>}
			</div>
			{message.stats && <ReplyDetails stats={message.stats} />}
		</div>
	);
}

type ToolPart = Extract<Message["parts"][number], { type: "tool" }>;

/** "Sent SMS with Fake CRM"; click to see what went in and came out (from the activity log). */
function ToolPart({ replyId, part }: { replyId: Message["_id"]; part: ToolPart }) {
	// Replies from before tool lines had labels: make one from the name.
	const label = toolLine(part.label ?? (part.name === "connectors_search" ? "Look up connected actions" : actionLabel(part.name)), part.status);
	if (part.status === "running") return <p className="text-xs text-neutral-400">{label}</p>;
	return (
		<div className="flex">
			<Popover trigger={label} className="text-xs text-neutral-400 hover:text-neutral-600" panelClassName="w-[32rem] p-3">
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
	const rows: [string, string][] = [
		["Model", stats.model],
		["Time", `${seconds(stats.durationMs)}${stats.firstTokenMs !== undefined ? `, first words after ${seconds(stats.firstTokenMs)}` : ""}`],
		["Context", `${tokens(stats.contextTokens)} tokens`],
		["Input", `${tokens(stats.inputTokens)} tokens${stats.cachedInputTokens ? `, ${tokens(stats.cachedInputTokens)} cached` : ""}`],
		["Output", `${tokens(stats.outputTokens)} tokens`],
		["Model calls", String(stats.steps)],
		["This reply", usd(stats.costUsd)],
		["Here so far", usd(stats.conversationCostUsd)],
	];
	return (
		<div className="flex">
			<Popover
				trigger={`${shortModel(stats.model)} · ${seconds(stats.durationMs)} · ${tokens(stats.contextTokens)} context · ${usd(stats.costUsd)} · ${usd(stats.conversationCostUsd)} total`}
				className="text-xs text-neutral-400 tabular-nums hover:text-neutral-600"
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
