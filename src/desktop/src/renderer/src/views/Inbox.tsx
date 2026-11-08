import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { Segmented, Select } from "../controls";
import { useMutation, useQuery } from "../convex";
import { ArrowUpIcon, CaretUpDownIcon, CheckIcon, InboxIcon, MailIcon, MembersIcon, PaperPlaneTiltIcon, ReactIcon, RecordIcon, SidebarIcon, TextMessageIcon, TrashIcon } from "../icons";
import { navigate } from "../router";
import {
	EmptyState,
	Form,
	Loading,
	NewButton,
	Notice,
	Scroll,
	Setting,
	Settings,
	TopBar,
	bareFieldClass,
	bareSelectClass,
	choiceCardButton,
	compactButton,
	compactControlClass,
	compactPrimaryButton,
	composerButton,
	descriptionClass,
	iconButton,
	inboxPill,
	linkButton,
	primaryButton,
	secondaryButton,
	sendButton,
	sentBubbleClass,
	shortAgo,
	useRun,
	wideControlClass,
} from "../ui";
import { recordPath } from "./records/logic";
import { Avatar, DialogButtons, MenuItem, Modal, Popover, clock, dayLabel } from "./chat/common";
import { AddButton, Item } from "./chat/Sidebar";
import { EmojiPanel } from "./chat/EmojiPanel";
import { Thread } from "./InboxComments";
import { ProfileLink } from "./chat/Profile";
import type { Participant } from "./chat/data";

// Inbox: conversations with people outside the workspace, by email and text (backend inbox.ts). The
// sidebar lists them, the latest first; one opens here with what was said, the agent's replies waiting
// for staff, and a box to answer as the business. Staff can take one over from its agent and hand it back.

type Opened = NonNullable<FunctionReturnType<typeof api.inbox.get>>;

const contactLabel = (c: { channel: "email" | "sms"; contact: string; contactName: string | null }) => c.contactName ?? (c.channel === "sms" ? formatPhone(c.contact) : c.contact);
const ChannelIcon = ({ channel }: { channel: "email" | "sms" }) => (channel === "email" ? <MailIcon /> : <TextMessageIcon />);

/**
 * Inbox's sidebar: every conversation, the latest first: who, when, the last thing said, and who's
 * answering (their picture). One waiting for staff is bold, with a dot on its icon.
 */
export function InboxNav({ openId }: { openId: string | undefined }) {
	const list = useQuery(api.inbox.list);
	if (!list?.length) return null;
	return (
		<div className="flex flex-col gap-px">
			{list.map((c) => (
				<Item
					key={c.id}
					icon={
						<span className="relative flex">
							<ChannelIcon channel={c.channel} />
							{/* Waiting for staff: a dot on the icon, the same spot on every row. Its ring matches the row behind it. */}
							{c.needsStaff && (
								<span
									aria-label="Needs staff"
									className={`absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ${openId === c.id ? "ring-neutral-200" : "ring-neutral-50 group-hover/item:ring-neutral-100"}`}
								/>
							)}
						</span>
					}
					label={contactLabel(c)}
					active={openId === c.id}
					onClick={() => navigate("inbox", c.id)}
				>
					<span className="flex min-w-0 flex-1 flex-col py-0.5 text-left">
						<span className="flex items-center gap-2">
							<span className={`min-w-0 flex-1 truncate ${c.needsStaff ? "font-semibold text-neutral-900" : ""}`}>{contactLabel(c)}</span>
							<span className="shrink-0 text-xs font-normal text-neutral-400">{shortAgo(c.lastAt)}</span>
						</span>
						<span className="flex items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-xs font-normal text-neutral-500">{c.preview || "No messages yet"}</span>
							{c.assignee && <Avatar name={c.assignee.name} image={c.assignee.image} agent={c.assignee.type === "agent"} size="xs" />}
						</span>
					</span>
				</Item>
			))}
		</div>
	);
}

/** The + beside Inbox's name: starts a conversation from an agent's address or number. */
export function InboxAdd() {
	const [starting, setStarting] = useState(false);
	return (
		<>
			<AddButton label="New conversation" onClick={() => setStarting(true)} />
			{starting && <NewConversation onClose={() => setStarting(false)} />}
		</>
	);
}

/** Inbox on screen: the open conversation, else an empty state. */
export function InboxView({ access, conversationId }: { access: Access; conversationId: string | undefined }) {
	const list = useQuery(api.inbox.list);
	if (!can(access, "inbox.use"))
		return (
			<Scroll header={<TopBar title="Inbox" />}>
				<EmptyState icon={<InboxIcon />} title="No access to Inbox">Ask an owner for a role that can see Inbox.</EmptyState>
			</Scroll>
		);
	return (
		<>
			{conversationId ? (
				<ConversationScreen key={conversationId} id={conversationId as Id<"inboxConversations">} />
			) : (
				<Scroll header={<TopBar title="" />}>
					{list === undefined ? (
						<Loading />
					) : (
						<EmptyState icon={<InboxIcon />} title={list?.length ? "Pick a conversation" : "No conversations yet"}>
							{list?.length ? "Open one from the list." : "When someone emails or texts one of your agents, it shows up here. Start one with + beside Inbox."}
						</EmptyState>
					)}
				</Scroll>
			)}
		</>
	);
}

function ConversationScreen({ id }: { id: Id<"inboxConversations"> }) {
	const c = useQuery(api.inbox.get, { id });
	if (c === undefined) return <Scroll header={<TopBar title="" />}><Loading /></Scroll>;
	if (c === null)
		return (
			<Scroll header={<TopBar title="Not found" />}>
				<EmptyState icon={<InboxIcon />} title="Conversation not found">It may have been deleted with its agent.</EmptyState>
			</Scroll>
		);
	return <Conversation c={c} />;
}

/** Below this width the details card is hidden, and opens over the messages when asked for. */
const DETAILS_FROM_PX = 860;

/**
 * An open conversation: the messages and reply box, and beside them a column with the details card.
 * The top bar's button hides or shows the card (kept per computer); where there isn't room for a
 * column, it's hidden, and the button opens it over the messages instead.
 */
function Conversation({ c }: { c: Opened }) {
	const them = contactLabel(c);
	const row = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(true);
	const [hidden, setHidden] = useState(() => localStorage.getItem("inbox.details.hidden") === "true");
	const [opened, setOpened] = useState(false);
	// Opening it (or it changing while open) clears your notifications about it.
	const mine = useQuery(api.notifications.list);
	const clearMine = useMutation(api.notifications.clearConversation);
	const pending = mine?.some((n) => n.conversationId === c.id);
	useEffect(() => {
		if (pending) void clearMine({ conversationId: c.id });
	}, [pending, c.id, clearMine]);
	useLayoutEffect(() => {
		const el = row.current;
		if (!el) return;
		const observer = new ResizeObserver(() => setWide(el.clientWidth >= DETAILS_FROM_PX));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const shown = wide ? !hidden : opened;
	const toggle = () => (wide ? (setHidden(!hidden), localStorage.setItem("inbox.details.hidden", String(!hidden))) : setOpened(!opened));
	return (
		<div ref={row} className="relative flex min-h-0 min-w-0 flex-1">
			<Messages
				c={c}
				them={them}
				bar={
					<TopBar title={<span className="truncate">{them}</span>} description={c.channel === "email" ? "Email" : "Text"}>
						<button type="button" aria-label={shown ? "Hide details" : "Show details"} title={shown ? "Hide details" : "Show details"} aria-expanded={shown} className={iconButton} onClick={toggle}>
							<SidebarIcon className="-scale-x-100" />
						</button>
					</TopBar>
				}
				side={shown && wide ? <Details conversation={c} /> : null}
			/>
			{shown && !wide && (
				<aside className="absolute top-12 right-3 z-40 w-72 rounded-xl shadow-lg">
					<Details conversation={c} />
				</aside>
			)}
		</div>
	);
}

/**
 * The messages, with the details card (`side`) as a column beside them in the same scrolling area, so
 * its scrollbar runs down the screen's edge rather than between the two.
 */
function Messages({ c, them, bar, side }: { c: Opened; them: string; bar: React.ReactNode; side: React.ReactNode }) {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const nearBottom = useRef(true);
	const items = itemsOf(c.messages);
	// Opens at the latest message, and follows new ones while you're at the bottom (as chat does).
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el || !content.current) return;
		const follow = () => nearBottom.current && (el.scrollTop = el.scrollHeight);
		follow();
		const observer = new ResizeObserver(follow);
		observer.observe(content.current);
		return () => observer.disconnect();
	}, []);
	return (
		<Scroll
			ref={scroller}
			overlayScrollbar
			header={bar}
			footer={
				<div className="flex">
					<div className="min-w-0 flex-1">
						<ReplyBox conversation={c} />
					</div>
					{side && <div aria-hidden className="w-72 shrink-0" />}
				</div>
			}
			onScroll={(e) => (nearBottom.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 120)}
		>
			<div className="flex flex-1 items-start">
				<div ref={content} className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end self-stretch px-5 pt-4 pb-5">
					{items.map((item, i) => {
						const first = item.messages[0]!;
						const prev = items[i - 1]?.messages.at(-1);
						// A time over the first, and after a quiet stretch; room between groups.
						const stamp = !prev || first.at - prev.at > GROUP_GAP_MS;
						return (
							<Fragment key={first.id}>
								{stamp && <p className="pt-8 pb-4 text-center text-xs text-neutral-400">{dayLabel(first.at)}, {clock(first.at)}</p>}
								<div className={`group/msg ${stamp ? "" : "pt-3"}`}>
									{first.assignedTo ? (
										<Line who={first.author} name="Someone on staff">
											assigned this to <PersonPill who={first.assignedTo} />
										</Line>
									) : first.status === "draft" ? (
										<Draft message={first} channel={c.channel} agent={c.agent} />
									) : (
										<Group messages={item.messages} them={them} channel={c.channel} subject={c.subject} />
									)}
									{first.direction !== "event" && (
										<Thread
											messageId={item.messages.at(-1)!.id}
											comments={item.messages.flatMap((m) => m.comments).sort((a, b) => a.at - b.at)}
											side={first.direction === "in" ? "them" : "us"}
										/>
									)}
									{/* Lines get the same room under them as a group's comment pill, so every gap is the same. */}
									{first.direction === "event" && <div aria-hidden className="h-7.5" />}
								</div>
							</Fragment>
						);
					})}
					{c.needsStaff === "handoff" && (
						<div className="pt-3">
							<Line who={c.agent} name={c.agentName}>
								handed this to
								<span className={`${inboxPill} bg-amber-50 pl-2 text-amber-800`}>
									<MembersIcon /> Staff
								</span>
							</Line>
						</div>
					)}
					{c.replying && (
						<div className="pt-3">
							<Line who={c.agent} name={c.agentName}>
								is writing a reply…
							</Line>
						</div>
					)}
				</div>
				{side && <aside className="sticky top-12 w-72 shrink-0 pr-3 pb-3">{side}</aside>}
			</div>
		</Scroll>
	);
}

/** Who this is with and who's handling it: the customer, their address and record; who it's assigned to; and the address replies go from. */
function Details({ conversation: c }: { conversation: Opened }) {
	const them = contactLabel(c);
	const address = c.channel === "sms" ? formatPhone(c.contact) : c.contact;
	return (
		<section aria-label="Details" className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3 text-sm">
			<div className="flex flex-col gap-1.5 text-neutral-600">
				<p className="flex min-w-0 items-center gap-2 pb-0.5 font-medium text-neutral-900">
					<Avatar name={them} size="sm" />
					<span className="truncate">{them}</span>
				</p>
				<p className="flex min-w-0 items-center gap-2">
					<ChannelIcon channel={c.channel} />
					<span className="truncate select-text">{address}</span>
				</p>
				{c.record && (
					<button type="button" className={`flex min-w-0 items-center gap-2 ${linkButton}`} onClick={() => navigate(...recordPath(c.record!.typeKey, c.record!.id))}>
						<RecordIcon /> <span className="truncate">{c.record.title}</span>
					</button>
				)}
			</div>
			<div className="flex flex-col gap-1 border-t border-neutral-100 pt-3">
				<p className="text-xs font-medium text-neutral-500">Assigned to</p>
				<Assignee conversation={c} />
			</div>
			{c.from && (
				<div className="flex flex-col gap-1 border-t border-neutral-100 pt-3">
					<p className="text-xs font-medium text-neutral-500">Replies go from</p>
					<p className="truncate text-neutral-600 select-text">{c.channel === "sms" ? formatPhone(c.from) : c.from}</p>
				</div>
			)}
		</section>
	);
}

/** Who answers it, as a picker: its agent, or anyone on staff who can use Inbox (the agent stops answering). */
function Assignee({ conversation: c }: { conversation: Opened }) {
	const team = useQuery(api.workspace.team);
	const assign = useMutation(api.inbox.assign);
	const { error, run } = useRun();
	const current = c.mode === "agent" ? c.agent : c.takenBy;
	const people = (team?.members ?? []).filter((m) => m.inbox).sort((a, b) => Number(b.isYou) - Number(a.isYou));
	const pick = (to: "agent" | Id<"users">) => run(assign({ id: c.id, to }));
	return (
		<>
			<Popover
				label="Assigned to"
				trigger={
					<>
						{current ? <Avatar name={current.name} image={current.image} agent={current.type === "agent"} size="sm" /> : null}
						<span className="min-w-0 flex-1 truncate text-left">{current?.name ?? "Someone on staff"}</span>
						<CaretUpDownIcon className="shrink-0 text-neutral-400" />
					</>
				}
				className={`-mx-1.5 flex items-center gap-2 ${bareSelectClass}`}
				panelClassName="flex w-64 flex-col p-1"
			>
				{(close) => (
					<>
						{c.agent && (
							<MenuItem onClick={() => (close(), c.mode !== "agent" && pick("agent"))}>
								<Avatar name={c.agent.name} image={c.agent.image} agent size="sm" />
								<span className="min-w-0 flex-1 truncate">{c.agent.name}</span>
								{c.mode === "agent" && <CheckIcon className="shrink-0" />}
							</MenuItem>
						)}
						{people.map((m) => {
							const on = c.mode === "staff" && c.takenBy?.id === m.userId;
							return (
								<MenuItem key={m.userId} onClick={() => (close(), !on && pick(m.userId))}>
									<Avatar name={m.name || m.email} image={m.image} size="sm" />
									<span className="min-w-0 flex-1 truncate">
										{m.name || m.email}
										{m.isYou && <span className="text-neutral-400"> (you)</span>}
									</span>
									{on && <CheckIcon className="shrink-0" />}
								</MenuItem>
							);
						})}
					</>
				)}
			</Popover>
			<Notice>{error}</Notice>
		</>
	);
}

type Message = Opened["messages"][number];

/**
 * A centered line in the conversation, as in "Changed status to [Contacted]": who, as a pill with
 * their picture (their card on click), then what: assignments, hand-offs, an agent writing.
 */
function Line({ who, name, children }: { who: Participant | null; name: string; children: React.ReactNode }) {
	return (
		<p className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-center text-xs text-neutral-500">
			<PersonPill who={who} name={name} />
			{children}
		</p>
	);
}

/** Someone in a line, as a pill with their picture; their card on click. */
function PersonPill({ who, name = "Someone" }: { who: Participant | null; name?: string }) {
	const inside = (
		<>
			<Avatar name={who?.name ?? name} image={who?.image} agent={who?.type === "agent"} size="line" />
			{who?.name ?? name}
		</>
	);
	return who ? (
		<ProfileLink who={who} className={`${inboxPill} bg-neutral-100 pl-1 text-neutral-700 hover:bg-neutral-200`}>
			{inside}
		</ProfileLink>
	) : (
		<span className={`${inboxPill} bg-neutral-100 pl-1 text-neutral-700`}>{inside}</span>
	);
}

/** Messages this close together sit in one group under one time. */
const GROUP_GAP_MS = 15 * 60_000;
const sideOf = (m: Message) => (m.direction === "in" ? "them" : m.direction === "event" ? "event" : "us");

/**
 * The conversation as groups: a run of messages from one sender, close in time, is one group (one name
 * over it, connected bubbles, one comment thread under it). Lines and drafts stand alone.
 */
function itemsOf(messages: Message[]) {
	const items: { messages: Message[] }[] = [];
	const alone = (m: Message) => m.direction === "event" || m.status === "draft";
	for (const m of messages) {
		const run = items.at(-1)?.messages;
		const prev = run?.at(-1);
		if (run && prev && !alone(m) && !alone(prev) && sideOf(prev) === sideOf(m) && prev.author?.name === m.author?.name && m.at - prev.at <= GROUP_GAP_MS) run.push(m);
		else items.push({ messages: [m] });
	}
	return items;
}

/** A run from one sender: their name and picture, then the messages, connected on the sender's side. */
function Group({ messages, them, channel, subject }: { messages: Message[]; them: string; channel: "email" | "sms"; subject: string | null }) {
	const mine = messages[0]!.direction !== "in";
	return (
		<div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
			<Sender author={messages[0]!.author} them={them} mine={mine} />
			{messages.map((m, i) => (
				<MessageItem key={m.id} message={m} channel={channel} subject={subject} corners={cornersOf(mine, i, messages.length)} last={i === messages.length - 1} />
			))}
		</div>
	);
}

/** Where a bubble sits in its run: its corners on the sender's side tighten where it meets the next. */
function cornersOf(mine: boolean, i: number, count: number) {
	const above = i > 0;
	const below = i < count - 1;
	if (mine) return `${above ? "rounded-tr-md" : ""} ${below ? "rounded-br-md" : ""}`;
	return `${above ? "rounded-tl-md" : ""} ${below ? "rounded-bl-md" : ""}`;
}

/**
 * Who wrote it, with their picture: on our side, the name then the picture; on theirs, the other way
 * round. Our people and agents open their card; `them` is the customer, by name only.
 */
function Sender({ author, them, mine }: { author: Participant | null; them?: string; mine: boolean }) {
	const line = `flex items-center gap-2 text-sm text-neutral-600 ${mine ? "flex-row-reverse" : ""}`;
	if (!author)
		return (
			<p className={`${line} pb-1.5`}>
				<Avatar name={them ?? "Them"} size="sm" />
				<span>{them}</span>
			</p>
		);
	return (
		<div className="pb-1.5">
			<ProfileLink who={author} className={`${line} rounded-md`}>
				<Avatar name={author.name} image={author.image} agent={author.type === "agent"} size="sm" />
				<span className="hover:underline">{author.name}</span>
			</ProfileLink>
		</div>
	);
}

/**
 * One message, as a text app shows it: ours on the right, theirs on the left, the sender's name and
 * picture over the first of a run. Texts are bubbles (ours blue); emails are cards with their subject.
 */
function MessageItem({ message: m, channel, subject, corners, last }: { message: Message; channel: "email" | "sms"; subject: string | null; corners: string; last: boolean }) {
	const mine = m.direction !== "in";
	const failed = m.status === "failed";
	const body =
		channel === "email" ? (
			<div className={`max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 text-sm text-neutral-800 select-text ${corners}`}>
				{subject && (
					<p className="flex items-center gap-2 pb-1 font-semibold text-neutral-900">
						<MailIcon /> {subject}
					</p>
				)}
				<p className="whitespace-pre-wrap">{m.text}</p>
			</div>
		) : (
			<div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap select-text ${corners} ${mine ? sentBubbleClass : "bg-neutral-100 text-neutral-900"}`}>{m.text}</div>
		);
	const forWho = m.author?.for;
	return (
		<div className={`flex w-full flex-col ${mine ? "items-end" : "items-start"}`}>
			{body}
			{(failed || m.status === "sending") && <p className={`pt-1 text-xs ${failed ? "text-red-600" : "text-neutral-400"}`}>{failed ? `Didn't send: ${m.error ?? "unknown error"}` : "Sending…"}</p>}
			{!failed && m.status !== "sending" && last && forWho && (
				<p className="pt-1 text-xs text-neutral-400">
					For{" "}
					<ProfileLink who={forWho} className="hover:underline">
						{forWho.name}
					</ProfileLink>
				</p>
			)}
		</div>
	);
}

/** The agent's reply, waiting because Public can't reply on its own: staff edit it, send it, or discard it. */
function Draft({ message: m, channel, agent }: { message: Message; channel: "email" | "sms"; agent: Participant | null }) {
	const send = useMutation(api.inbox.sendDraft);
	const discard = useMutation(api.inbox.discardDraft);
	const [text, setText] = useState(m.text);
	const { error, busy, run } = useRun();
	return (
		<div className="flex flex-col items-end">
			<Sender author={agent} them="Agent" mine />
			<div className="flex w-[85%] flex-col gap-2 rounded-2xl border border-dashed border-neutral-300 bg-white px-4 py-3">
				<p className="text-xs text-neutral-500">Draft reply. Check it, then send it.</p>
				<textarea aria-label="Reply" rows={channel === "sms" ? 3 : 6} value={text} onChange={(e) => setText(e.target.value)} className="w-full resize-none bg-transparent text-sm outline-none" />
				<Notice>{error}</Notice>
				<div className="flex justify-end gap-2">
					<button type="button" disabled={busy} className={compactButton} onClick={() => run(discard({ messageId: m.id }))}>
						<TrashIcon /> Discard
					</button>
					<button type="button" disabled={busy || !text.trim()} className={compactPrimaryButton} onClick={() => run(send({ messageId: m.id, text }))}>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}

/** Answer as the business, from the agent's address or number. Enter sends; Shift+Enter starts a new line. */
function ReplyBox({ conversation: c }: { conversation: Opened }) {
	const reply = useMutation(api.inbox.reply);
	const [text, setText] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	// An emoji goes in where the caret was.
	const insert = (emoji: string) => {
		const el = field.current;
		const at = el?.selectionStart ?? text.length;
		setText(text.slice(0, at) + emoji + text.slice(el?.selectionEnd ?? at));
		requestAnimationFrame(() => (el?.focus(), el?.setSelectionRange(at + emoji.length, at + emoji.length)));
	};
	const { error, busy, run } = useRun();
	const blocked = !c.from;
	const submit = () => text.trim() && !busy && !blocked && run(reply({ id: c.id, text }).then(() => setText("")));
	const who = contactLabel(c);
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-5 pt-2 pb-5">
			<Notice>{error}</Notice>
			{/* One 8px inset all round, and a corner that follows the round buttons' (16px radius + 8px = 24px). */}
			<Form className="flex w-full flex-col gap-1 rounded-3xl border border-neutral-200 bg-white p-2 focus-within:border-neutral-300" onSubmit={submit}>
				<textarea
					ref={field}
					aria-label="Reply"
					rows={1}
					disabled={blocked}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder={blocked ? `${c.agentName} no longer has ${c.channel === "email" ? "an email address" : "a phone number"}.` : c.channel === "email" ? `Email ${who}` : `Send a text to ${who}`}
					className="field-sizing-content max-h-48 min-w-0 resize-none bg-transparent px-2 pt-1.5 text-sm outline-none"
				/>
				<div className="flex items-center justify-between">
					<Popover trigger={<ReactIcon />} label="Add emoji" className={`${composerButton} bg-neutral-100`} panelClassName="w-auto">
						{(close) => <EmojiPanel onPick={(emoji) => (close(), insert(emoji))} />}
					</Popover>
					<button type="submit" disabled={busy || blocked || !text.trim()} className={`${sendButton} enabled:bg-sent`} aria-label="Send">
						<ArrowUpIcon weight="bold" />
					</button>
				</div>
			</Form>
		</div>
	);
}

/** Starts a conversation from an agent's address or number, laid out as an email: From, To, Subject, then the message. A person who starts one answers it; hand it back for the agent to. */
function NewConversation({ onClose }: { onClose: () => void }) {
	const agents = useQuery(api.agents.list);
	const start = useMutation(api.inbox.start);
	const [agentId, setAgentId] = useState<string>();
	const [picked, setPicked] = useState<"email" | "sms">("email");
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState("");
	const [text, setText] = useState("");
	const { error, busy, run } = useRun();
	const live = (agents ?? []).filter((a) => !a.archived);
	const chosen = agentId ?? live[0]?._id;
	const points = useQuery(api.contactPoints.forAgent, chosen ? { agentId: chosen as Id<"agents"> } : "skip");
	const has = { email: points?.email?.status === "active", sms: points?.phone?.status === "active" };
	// The one they picked, unless this agent can't send that way and can the other.
	const channel = !has[picked] && has[picked === "email" ? "sms" : "email"] ? (picked === "email" ? "sms" : "email") : picked;
	const point = channel === "email" ? points?.email : points?.phone;
	const from = point?.status === "active" ? (channel === "sms" ? formatPhone(point.address) : point.address) : null;
	const row = "flex items-center gap-3 border-b border-neutral-100 px-4";
	const rowLabel = "w-14 shrink-0 text-sm text-neutral-500";
	const agentPicker = (className: string) => <Select label="From" value={chosen} options={live.map((a) => ({ value: a._id as string, label: a.name }))} onChange={setAgentId} className={className} />;
	return (
		<Modal title="New message" onClose={onClose}>
			<Form
				onSubmit={() =>
					run(
						start({ agentId: chosen as Id<"agents">, channel, to, text, ...(channel === "email" && { subject }) }).then((r) => navigate("inbox", r.conversationId)),
						onClose,
					)
				}
			>
				<div role="group" aria-label="Send by" className="grid grid-cols-2 gap-3">
					{(["email", "sms"] as const).map((kind) => {
						const p = kind === "email" ? points?.email : points?.phone;
						const address = p?.status === "active" ? (kind === "sms" ? formatPhone(p.address) : p.address) : null;
						return (
							<button
								key={kind}
								type="button"
								aria-pressed={channel === kind && has[kind]}
								disabled={!points}
								// One it can't send by yet opens the agent's page, where it gets one.
								onClick={() => (has[kind] ? setPicked(kind) : (onClose(), navigate("settings", "agents", chosen!)))}
								className={choiceCardButton}
							>
								<span className={`text-xl ${address ? "text-neutral-700" : "text-neutral-400"}`}>{kind === "email" ? <MailIcon /> : <TextMessageIcon />}</span>
								<span className="flex min-w-0 flex-col">
									<span className={`font-medium ${address ? "" : "text-neutral-500"}`}>{kind === "email" ? "Email" : "Text message"}</span>
									<span className="truncate text-xs text-neutral-500">{address ?? (points ? `Set up ${kind === "email" ? "an address" : "a number"}` : "")}</span>
								</span>
							</button>
						);
					})}
				</div>
				<div className="flex flex-col overflow-hidden rounded-xl border border-neutral-200 focus-within:border-neutral-300">
					<div className={`${row} py-1`}>
						<span className={rowLabel}>From</span>
						{agentPicker(bareSelectClass)}
						<span className="min-w-0 truncate text-sm text-neutral-400">{from ?? ""}</span>
					</div>
					<label className={row}>
						<span className={rowLabel}>To</span>
						<input autoFocus aria-label="To" required value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === "email" ? "dana@acme.com" : "+1 555 123 4567"} className={bareFieldClass} />
					</label>
					{channel === "email" && (
						<label className={row}>
							<span className={rowLabel}>Subject</span>
							<input aria-label="Subject" required value={subject} onChange={(e) => setSubject(e.target.value)} className={bareFieldClass} />
						</label>
					)}
					<textarea aria-label="Message" required rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={channel === "email" ? "Write your email…" : "Write your text…"} className={`${bareFieldClass} resize-none px-4 py-3`} />
				</div>
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Discard
					</button>
					<button type="submit" disabled={busy || !chosen || !from || !to.trim() || !text.trim()} className={primaryButton}>
						<PaperPlaneTiltIcon /> Send
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}
