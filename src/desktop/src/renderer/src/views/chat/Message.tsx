import { actionLabel, toolLine } from "@companybot/core/action-words";
import { splitLinks } from "@companybot/core/link-preview";
import { routerDecisionModels } from "@companybot/core/router";
import { Fragment, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { Notice, timeAgo, useTip } from "../../ui";
import { WidgetView } from "../../widgets";
import { CallDetails } from "../Activity";
import { ApprovalMessages } from "./Approval";
import { AutomationIcon, EditIcon, MoreIcon, ReactIcon, ReplyIcon, TrashIcon } from "../../icons";
import { AgentBadge, Avatar, AvatarStack, EmojiPicker, IconButton, MenuItem, PairAvatar, Popover, PopoverPanel, clock, useConfirm, useDismiss } from "./common";
import type { Message, TokenNames } from "./data";
import { navigate } from "../../router";
import { ProfileLink } from "./Profile";
import { MessageFiles } from "./Attachments";
import { LinkPreviews } from "./LinkPreviews";
import { TokenChip } from "./TokenChip";
import { splitTokens } from "./tokens";

export function MessageRow({
	message: row,
	grouped,
	tokens,
	onOpenThread,
	readOnly,
	onError,
}: {
	message: Message;
	/** Same author as the message above: no avatar or name. */
	grouped: boolean;
	/** What to show as chips: @names, #channels, /skills. */
	tokens: TokenNames;
	/** Absent inside a thread: threads are one level deep. */
	onOpenThread?: () => void;
	/** No hover actions, and reactions only show. */
	readOnly?: boolean;
	onError: (e: unknown) => void;
}) {
	// A reply streams into its own small query (backend replyStreams): only this row re-renders per token.
	const live = useQuery(api.messages.stream, row.status === "streaming" ? { messageId: row._id } : "skip");
	const message = live ? { ...row, ...live } : row;
	const react = useMutation(api.messages.react);
	const remove = useMutation(api.messages.remove);
	const [picker, setPicker] = useState(false);
	const [editing, setEditing] = useState(false);
	// The ⋯ menu, then what it opened in its place.
	const [more, setMore] = useState<{ at: DOMRect; view: "menu" | "reactions" }>();
	const moreButton = useRef<HTMLSpanElement>(null);
	const toolbar = useDismiss<HTMLDivElement>(() => setPicker(false), picker);
	const { confirm, dialog } = useConfirm();
	const isAgent = message.author.type === "agent";
	const sending = message.sending;
	const toggle = (emoji: string) => react({ messageId: message._id, emoji }).catch(onError);

	const held = isAgent && !message.deleted ? message.parts.filter((p) => p.type === "approval") : [];

	// A reply shows whole once it's written; meanwhile the line under the composer says what the agent is
	// doing. A card asking permission shows at once, since the reply waits on it.
	if (message.status === "streaming" && held.length === 0) return null;
	if (message.pause && !message.deleted) return <PausedLine message={message} pause={message.pause} onError={onError} />;
	if (held.length > 0 && held.length === message.parts.length && !message.text) return <ApprovalMessages message={message} parts={held} />;

	return (
		<>
			<div
				id={`message-${message._id}`}
				className={`group relative flex gap-3 px-5 hover:bg-neutral-50/80 ${grouped ? "py-0.5" : "pt-2 pb-0.5"}`}
			>
				<div className="flex w-9 shrink-0 items-start justify-center">
					{grouped ? (
						<span className="invisible pt-1 text-[10px] whitespace-nowrap text-neutral-400 tabular-nums group-hover:visible">
							{clock(message._creationTime)}
						</span>
					) : (
						<ProfileLink who={message.author}>
							{message.author.for ? (
								<PairAvatar agent={message.author} person={message.author.for} />
							) : (
								<Avatar name={message.author.name} image={message.author.image} agent={isAgent} />
							)}
						</ProfileLink>
					)}
				</div>
				<div className={`flex min-w-0 flex-1 flex-col gap-1 ${sending ? "opacity-50" : ""}`}>
					{!grouped && (
						<div className="flex items-baseline gap-2">
							{message.author.for ? (
								// An agent sending as a person: each name opens its own card.
								<span className="font-semibold">
									<ProfileLink who={{ ...message.author, for: undefined }} className="hover:underline">
										{message.author.name}
									</ProfileLink>
									{", for "}
									<ProfileLink who={message.author.for} className="hover:underline">
										{message.author.for.name}
									</ProfileLink>
								</span>
							) : (
								<ProfileLink who={message.author} className="font-semibold hover:underline">
									{message.author.name}
								</ProfileLink>
							)}
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
						<AgentBody message={message} tokens={tokens} />
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
					{message.reactions.length > 0 && <Reactions reactions={message.reactions} onToggle={readOnly ? undefined : toggle} />}
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
				{!message.deleted && !editing && !sending && !readOnly && (
					<div
						ref={toolbar}
						className={`absolute -top-3 right-5 z-10 items-center rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm ${
							picker || more ? "flex" : "hidden group-hover:flex"
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
						{message.reactions.length > 0 && (
							<span ref={moreButton} className="flex">
								<IconButton
									label="More"
									onClick={() => setMore(more ? undefined : { at: moreButton.current!.getBoundingClientRect(), view: "menu" })}
								>
									<MoreIcon weight="bold" />
								</IconButton>
							</span>
						)}
						{more && (
							<PopoverPanel anchor={more.at} ignore={moreButton} className={more.view === "menu" ? "w-52 p-1" : "w-64 p-1"} onClose={() => setMore(undefined)}>
								{more.view === "menu" ? (
									<MenuItem onClick={() => setMore({ ...more, view: "reactions" })}>
										<ReactIcon /> Reactions
									</MenuItem>
								) : (
									<ReactionList reactions={message.reactions} />
								)}
							</PopoverPanel>
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

type Reaction = Message["reactions"][number];

/** Names in a hover tip before "and N others"; ⋯ → Reactions has everyone. */
const TIP_NAMES = 6;

/** "Ada", "Ada and Bo", "Ada, Bo and Cy", "Ada, Bo, … and 4 others". */
function whoReacted(people: Reaction["people"]) {
	const names = people.map((p) => p.name);
	if (names.length > TIP_NAMES) return `${names.slice(0, TIP_NAMES - 1).join(", ")} and ${names.length - TIP_NAMES + 1} others`;
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/**
 * The chips under a message: click one to add or take back yours (`onToggle`; absent read-only).
 * Hover one for who reacted with it; the message's ⋯ → Reactions lists everyone.
 */
function Reactions({ reactions, onToggle }: { reactions: Reaction[]; onToggle?: (emoji: string) => void }) {
	const { tipFor, tip } = useTip("below");
	return (
		<>
			<div className="flex flex-wrap gap-1 pt-0.5">
				{reactions.map((r) => (
					<button
						type="button"
						key={r.emoji}
						aria-label={`${r.emoji} ${whoReacted(r.people)}`}
						{...tipFor(whoReacted(r.people))}
						onClick={onToggle && (() => onToggle(r.emoji))}
						className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-sm tabular-nums ${
							r.mine ? "border-neutral-400 bg-neutral-100 text-neutral-900" : "border-neutral-200 text-neutral-600 hover:border-neutral-300"
						}`}
					>
						<span className="text-base leading-none">{r.emoji}</span>
						{r.count}
					</button>
				))}
			</div>
			{tip}
		</>
	);
}

/** Everyone who reacted, under each emoji. */
function ReactionList({ reactions }: { reactions: Reaction[] }) {
	return (
		<div className="flex flex-col gap-1">
			{reactions.map((r) => (
				<section key={r.emoji} className="flex flex-col">
					<h3 className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs text-neutral-500 tabular-nums">
						<span className="text-base leading-none">{r.emoji}</span>
						{r.count}
					</h3>
					{r.people.map((p) => (
						<ProfileLink key={`${p.type}:${p.id}`} who={p} className="flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-neutral-100">
							<Avatar name={p.name} image={p.image} agent={p.type === "agent"} size="xs" />
							<span className="truncate">{p.name}</span>
							{p.type === "agent" && <AgentBadge />}
						</ProfileLink>
					))}
				</section>
			))}
		</div>
	);
}

/** A person's message: its links open in the browser; @names, #channels and /skills are chips, like in the composer. */
function TokenText({ text, tokens }: { text: string; tokens: TokenNames }) {
	return splitLinks(text).map((part, i) =>
		typeof part === "string" ? (
			splitTokens(part, tokens).map((t, j) => (typeof t === "string" ? <Fragment key={`${i}.${j}`}>{t}</Fragment> : <TokenChip key={`${i}.${j}`} token={t} />))
		) : (
			<a key={i} href={part.url} target="_blank" rel="noreferrer noopener" className="wrap-anywhere text-link hover:underline">
				{part.url}
			</a>
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

function AgentBody({ message, tokens }: { message: Message; tokens: TokenNames }) {
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
								<ToolPart key={part.id} replyId={message._id} part={part} author={message.author.name} />
							))}
						</div>
					) : run.part.type === "text" ? (
						<Markdown key={run.i} tokens={tokens} className="leading-relaxed" isAnimating={streaming && run.i === lastText}>
							{run.part.text}
						</Markdown>
					) : run.part.type === "widget" ? (
						<WidgetView key={run.part.id} widget={run.part.widget} />
					) : null,
				)}
				{message.status === "error" && <Notice>{message.error ?? "Something went wrong."}</Notice>}
				{message.stoppedBy && <p className="text-xs text-neutral-400">Stopped by {message.stoppedBy}</p>}
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
function ToolPart({ replyId, part, author }: { replyId: Message["_id"]; part: ToolPart; author: string }) {
	// Replies from before tool lines had labels: make one from the name.
	const label = toolLine(part.label ?? (part.name === "connectors_search" ? "Look up connected actions" : actionLabel(part.name)), part.status);
	if (part.status === "running") return <p className="text-xs text-neutral-400">{label}</p>;
	// A call that made a thread (an ask to another agent) is a chip that opens it, read-only: "Scout asked Quill →".
	// One that sent a message jumps to it: "Companybot posted in #sales →".
	if (part.opens) {
		const { chatId, messageId, kind } = part.opens;
		return (
			<div className="flex">
				<button
					type="button"
					onClick={() => navigate("chat", chatId, kind ?? "thread", messageId)}
					className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
				>
					{author} {label.charAt(0).toLowerCase() + label.slice(1)} →
				</button>
			</div>
		);
	}
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

/** The line under a reply (model, time, cost, and the dispatcher's pick if nobody @mentioned it); click for the full breakdown. */
function ReplyDetails({ stats }: { stats: Stats }) {
	const cost = stats.costUsd + (stats.imageCostUsd ?? 0) + (stats.searchCostUsd ?? 0);
	const { dispatch } = stats;
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
		// Nobody @mentioned it. The decision is its own call, once for every agent in the channel, so it's
		// apart from "This reply" (Usage counts it under Reply decisions). Named by another agent: no call.
		...(dispatch?.by
			? ([["Picked by", dispatch.by]] as [string, string][])
			: dispatch
				? ([
						["Picked by", `Dispatcher (${dispatcherName(dispatch.model)})`],
						["Confidence", confidence(dispatch)],
						["Decision", `${tinyUsd(dispatch.costUsd)}, apart from this reply`],
					] as [string, string][])
				: []),
	];
	return (
		<div className="flex">
			<Popover
				trigger={`${shortModel(stats.model)} · ${seconds(stats.durationMs)} · ${tokens(stats.contextTokens)} context · ${usd(cost)} · ${usd(stats.conversationCostUsd)} total${dispatch?.by ? ` · via ${dispatch.by}` : dispatch ? ` · via dispatcher${dispatch.probability !== undefined ? ` ${percent(dispatch.probability)}` : ""}` : ""}`}
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
/** A dispatcher call costs a few hundredths of a cent. */
const tinyUsd = (n: number) => (n < 0.001 ? `$${n.toFixed(5)}` : usd(n));
const percent = (p: number) => `${Math.round(p * 100)}%`;
/** Jev's chance of each choice ("84% reply · 1% react · 15% quiet"); a hop's, of going next; none from a language model. */
function confidence({ probability, probabilities }: NonNullable<Stats["dispatch"]>) {
	if (probabilities) return ["reply", "react", "quiet"].filter((c) => probabilities[c] !== undefined).map((c) => `${percent(probabilities[c]!)} ${c}`).join(" · ");
	return probability !== undefined ? `${percent(probability)} go next` : "—";
}
/** "Jev" for TypeSafe's decision model, else the model's short id. */
const dispatcherName = (id: string) => routerDecisionModels.find((m) => m.id === id)?.name.split(" ")[0] ?? shortModel(id);

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

/**
 * Agents stopped at a limit (backend chains.ts): a quiet line, not a message. The person they work
 * for picks Continue (a fresh budget) or Stop; everyone else sees who it waits for.
 */
function PausedLine({ message, pause, onError }: { message: Message; pause: NonNullable<Message["pause"]>; onError: (e: unknown) => void }) {
	const decide = useMutation(api.chains.decide);
	const [busy, setBusy] = useState(false);
	const act = (action: "continue" | "stop") => {
		setBusy(true);
		decide({ messageId: message._id, action }).catch(onError).finally(() => setBusy(false));
	};
	const button = "font-medium text-neutral-700 hover:text-neutral-950 hover:underline disabled:opacity-50";
	return (
		<div id={`message-${message._id}`} className="flex items-center gap-3 px-5 py-1.5 text-xs text-neutral-500">
			<span className="h-px flex-1 bg-neutral-200" />
			<span className="flex flex-wrap items-center justify-center gap-x-1.5 text-center">
				<span>{message.text}</span>
				{pause.canDecide ? (
					<>
						<span>·</span>
						<button type="button" disabled={busy} onClick={() => act("continue")} className={button}>
							Continue
						</button>
						<span>·</span>
						<button type="button" disabled={busy} onClick={() => act("stop")} className={button}>
							Stop
						</button>
					</>
				) : (
					<span>
						·{" "}
						{pause.status === "paused"
							? `Waiting for ${pause.for}`
							: `${pause.status === "continued" ? "Continued" : "Stopped"}${pause.by ? ` by ${pause.by}` : ""}`}
					</span>
				)}
			</span>
			<span className="h-px flex-1 bg-neutral-200" />
		</div>
	);
}
