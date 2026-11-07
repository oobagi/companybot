import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { Fragment, useState } from "react";
import { api } from "../api";
import { Segmented, Select } from "../controls";
import { useMutation, useQuery } from "../convex";
import { ArrowUpIcon, MailIcon, InboxIcon, PaperPlaneTiltIcon, RecordIcon, TakeOverIcon, TextMessageIcon, TrashIcon } from "../icons";
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
	barButton,
	compactButton,
	compactControlClass,
	compactPrimaryButton,
	descriptionClass,
	linkButton,
	metadataClass,
	primaryButton,
	secondaryButton,
	sendButton,
	sentBubbleClass,
	timeAgo,
	useRun,
	wideControlClass,
} from "../ui";
import { recordPath } from "./records/logic";
import { Avatar, DialogButtons, Modal, clock, dayLabel } from "./chat/common";
import { AddButton, Item } from "./chat/Sidebar";

// Inbox: conversations with people outside the workspace, by email and text (backend inbox.ts). The
// sidebar lists them, the latest first; one opens here with what was said, the agent's replies waiting
// for staff, and a box to answer as the business. Staff can take one over from its agent and hand it back.

type Opened = NonNullable<FunctionReturnType<typeof api.inbox.get>>;

const contactLabel = (c: { channel: "email" | "sms"; contact: string; contactName: string | null }) => c.contactName ?? (c.channel === "sms" ? formatPhone(c.contact) : c.contact);
const ChannelIcon = ({ channel }: { channel: "email" | "sms" }) => (channel === "email" ? <MailIcon /> : <TextMessageIcon />);

/** Inbox's sidebar: every conversation, the latest first. One waiting for staff shows a dot. */
export function InboxNav({ openId }: { openId: string | undefined }) {
	const list = useQuery(api.inbox.list);
	if (!list?.length) return null;
	return (
		<div className="flex flex-col gap-px">
			{list.map((c) => (
				<Item key={c.id} icon={<ChannelIcon channel={c.channel} />} label={contactLabel(c)} active={openId === c.id} unread={!!c.needsStaff} title={c.preview} onClick={() => navigate("inbox", c.id)}>
					<span className="truncate">{contactLabel(c)}</span>
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
	const takeOver = useMutation(api.inbox.takeOver);
	const handBack = useMutation(api.inbox.handBack);
	const { error, run } = useRun();
	if (c === undefined) return <Scroll header={<TopBar title="" />}><Loading /></Scroll>;
	if (c === null)
		return (
			<Scroll header={<TopBar title="Not found" />}>
				<EmptyState icon={<InboxIcon />} title="Conversation not found">It may have been deleted with its agent.</EmptyState>
			</Scroll>
		);
	const who = c.mode === "agent" ? `${c.agentName} answers` : c.takenByName ? `${c.takenByName} took it over` : "Staff answer";
	const address = c.channel === "sms" ? formatPhone(c.contact) : c.contact;
	const them = { name: contactLabel(c), image: null, agent: false };
	return (
		<Scroll
			overlayScrollbar
			header={
				<TopBar title={<span className="truncate">{contactLabel(c)}</span>} description={`${c.contactName ? `${address} · ` : ""}${c.channel === "email" ? "Email" : "Text"} · ${who}`}>
					{c.mode === "agent" ? (
						<button type="button" className={barButton} onClick={() => run(takeOver({ id }))}>
							<TakeOverIcon /> Take over
						</button>
					) : (
						<button type="button" className={barButton} onClick={() => run(handBack({ id }))}>
							<TakeOverIcon /> Hand back to {c.agentName}
						</button>
					)}
				</TopBar>
			}
			footer={<ReplyBox conversation={c} />}
		>
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end px-5 py-4">
				<Notice>{error}</Notice>
				{c.record && (
					<div className="flex justify-center pb-2">
						<button type="button" className={`inline-flex items-center gap-1.5 text-xs ${linkButton}`} onClick={() => navigate(...recordPath(c.record!.typeKey, c.record!.id))}>
							<RecordIcon /> {c.record.title}
						</button>
					</div>
				)}
				{c.messages.map((m, i) => {
					const prev = c.messages[i - 1];
					// A new group: the first, after a quiet stretch, or someone else talking.
					const stamp = !prev || m.at - prev.at > GROUP_GAP_MS;
					const named = stamp || sideOf(prev!) !== sideOf(m) || prev!.author?.name !== m.author?.name;
					const last = i === c.messages.length - 1 || sideOf(c.messages[i + 1]!) !== sideOf(m) || c.messages[i + 1]!.at - m.at > GROUP_GAP_MS;
					return (
						<Fragment key={m.id}>
							{stamp && <p className="pt-6 pb-3 text-center text-xs text-neutral-400">{dayLabel(m.at)}, {clock(m.at)}</p>}
							{m.status === "draft" ? (
								<Draft message={m} channel={c.channel} agent={{ name: c.agentName, image: c.agentImage, agent: true }} />
							) : (
								<MessageItem message={m} them={them} channel={c.channel} subject={c.subject} named={named} last={last} />
							)}
						</Fragment>
					);
				})}
				{c.needsStaff === "handoff" && <p className="pt-3 text-center text-xs text-neutral-500">{c.agentName} handed this to staff. Take it over to answer, or hand it back.</p>}
				{c.replying && <p className="pt-3 text-center text-xs text-neutral-400">{c.agentName} is writing a reply…</p>}
			</div>
		</Scroll>
	);
}

type Message = Opened["messages"][number];

type Author = { name: string; image: string | null; agent: boolean };

/** Messages this close together sit in one group under one time. */
const GROUP_GAP_MS = 15 * 60_000;
const sideOf = (m: Message) => (m.direction === "in" ? "them" : "us");

/** Who wrote it, with their picture: on our side, the name then the picture; on theirs, the other way round. */
function Sender({ author, mine }: { author: Author; mine: boolean }) {
	return (
		<p className={`flex items-center gap-2 pb-1.5 text-sm text-neutral-600 ${mine ? "flex-row-reverse" : ""}`}>
			<Avatar name={author.name} image={author.image} agent={author.agent} size="sm" />
			<span>{author.name}</span>
		</p>
	);
}

/**
 * One message, as a text app shows it: ours on the right, theirs on the left, the sender's name and
 * picture over the first of a run. Texts are bubbles (ours blue); emails are cards with their subject.
 */
function MessageItem({ message: m, them, channel, subject, named, last }: { message: Message; them: Author; channel: "email" | "sms"; subject: string | null; named: boolean; last: boolean }) {
	const author = m.author ?? them;
	const note = m.direction === "note";
	const mine = m.direction !== "in";
	const failed = m.status === "failed";
	const body =
		note ? (
			<div className="max-w-[80%] rounded-2xl bg-amber-50 px-4 py-2.5 text-sm whitespace-pre-wrap text-amber-950 select-text">
				<p className="pb-0.5 text-xs font-medium text-amber-700">Only staff see this</p>
				{m.text}
			</div>
		) : channel === "email" ? (
			<div className="max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 text-sm text-neutral-800 select-text">
				{subject && (
					<p className="flex items-center gap-2 pb-1 font-semibold text-neutral-900">
						<MailIcon /> {subject}
					</p>
				)}
				<p className="whitespace-pre-wrap">{m.text}</p>
			</div>
		) : (
			<div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap select-text ${mine ? sentBubbleClass : "bg-neutral-100 text-neutral-900"}`}>{m.text}</div>
		);
	return (
		<div className={`flex flex-col ${mine ? "items-end" : "items-start"} ${named ? "" : "pt-1.5"}`}>
			{named && <Sender author={author} mine={mine} />}
			{body}
			{(failed || m.status === "sending" || (last && m.for)) && (
				<p className={`pt-1 text-xs ${failed ? "text-red-600" : "text-neutral-400"}`}>
					{failed ? `Didn't send: ${m.error ?? "unknown error"}` : m.status === "sending" ? "Sending…" : `For ${m.for}`}
				</p>
			)}
		</div>
	);
}

/** The agent's reply, waiting because Public can't reply on its own: staff edit it, send it, or discard it. */
function Draft({ message: m, channel, agent }: { message: Message; channel: "email" | "sms"; agent: Author }) {
	const send = useMutation(api.inbox.sendDraft);
	const discard = useMutation(api.inbox.discardDraft);
	const [text, setText] = useState(m.text);
	const { error, busy, run } = useRun();
	return (
		<div className="flex flex-col items-end">
			<Sender author={agent} mine />
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
	const { error, busy, run } = useRun();
	const blocked = !c.from;
	const submit = () => text.trim() && !busy && !blocked && run(reply({ id: c.id, text }).then(() => setText("")));
	const who = contactLabel(c);
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-5 pt-2 pb-6">
			<Notice>{error}</Notice>
			<Form className="flex w-full flex-col gap-2 rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm focus-within:border-neutral-300" onSubmit={submit}>
				<textarea
					aria-label="Reply"
					rows={2}
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
					className="min-w-0 resize-none bg-transparent px-1 text-sm outline-none"
				/>
				<div className="flex items-center justify-between">
					<span className="px-1 text-xs text-neutral-400">{c.from ? `From ${c.channel === "sms" ? formatPhone(c.from) : c.from}` : ""}</span>
					<button type="submit" disabled={busy || blocked || !text.trim()} className={sendButton} aria-label="Send">
						<ArrowUpIcon weight="bold" />
					</button>
				</div>
			</Form>
		</div>
	);
}

/** Starts a conversation from an agent's address or number. A person who starts one answers it; hand it back for the agent to. */
function NewConversation({ onClose }: { onClose: () => void }) {
	const agents = useQuery(api.agents.list);
	const start = useMutation(api.inbox.start);
	const [agentId, setAgentId] = useState<string>();
	const [channel, setChannel] = useState<"email" | "sms">("email");
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState("");
	const [text, setText] = useState("");
	const { error, busy, run } = useRun();
	const live = (agents ?? []).filter((a) => !a.archived);
	const chosen = agentId ?? live[0]?._id;
	return (
		<Modal title="New conversation" onClose={onClose}>
			<Form
				onSubmit={() =>
					run(
						start({ agentId: chosen as Id<"agents">, channel, to, text, ...(channel === "email" && { subject }) }).then((r) => navigate("inbox", r.conversationId)),
						onClose,
					)
				}
			>
				<Settings>
					<Setting label="From" hint="The agent whose address or number it comes from.">
						<Select label="From" value={chosen} options={live.map((a) => ({ value: a._id as string, label: a.name }))} onChange={setAgentId} className={wideControlClass} />
					</Setting>
					<Setting label="By">
						<Segmented label="By" value={channel} onChange={setChannel} options={[{ value: "email", label: "Email" }, { value: "sms", label: "Text" }]} />
					</Setting>
					<Setting label="To">
						<input autoFocus aria-label="To" required value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === "email" ? "dana@acme.com" : "+1 555 123 4567"} className={wideControlClass} />
					</Setting>
					{channel === "email" && (
						<Setting label="Subject">
							<input aria-label="Subject" required value={subject} onChange={(e) => setSubject(e.target.value)} className={wideControlClass} />
						</Setting>
					)}
					<Setting label="Message">
						<textarea aria-label="Message" required rows={5} value={text} onChange={(e) => setText(e.target.value)} className={`${compactControlClass} w-full`} />
					</Setting>
				</Settings>
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !chosen || !to.trim() || !text.trim()} className={primaryButton}>
						<PaperPlaneTiltIcon /> Send
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

