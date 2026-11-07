import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { Segmented, Select } from "../controls";
import { useMutation, useQuery } from "../convex";
import { ArrowUpIcon, EmailIcon, InboxIcon, PaperPlaneTiltIcon, RecordIcon, TakeOverIcon, TextMessageIcon, TrashIcon } from "../icons";
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
	timeAgo,
	useRun,
	wideControlClass,
} from "../ui";
import { recordPath } from "./records/logic";
import { DialogButtons, Modal } from "./chat/common";
import { Item } from "./chat/Sidebar";

// Inbox: conversations with people outside the workspace, by email and text (backend inbox.ts). The
// sidebar lists them, the latest first; one opens here with what was said, the agent's replies waiting
// for staff, and a box to answer as the business. Staff can take one over from its agent and hand it back.

type Opened = NonNullable<FunctionReturnType<typeof api.inbox.get>>;

const contactLabel = (c: { channel: "email" | "sms"; contact: string; contactName: string | null }) => c.contactName ?? (c.channel === "sms" ? formatPhone(c.contact) : c.contact);
const ChannelIcon = ({ channel }: { channel: "email" | "sms" }) => (channel === "email" ? <EmailIcon /> : <TextMessageIcon />);

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

/** Inbox on screen: the open conversation, else an empty state. */
export function InboxView({ access, conversationId }: { access: Access; conversationId: string | undefined }) {
	const [starting, setStarting] = useState(false);
	const list = useQuery(api.inbox.list);
	if (!can(access, "inbox.use"))
		return (
			<Scroll header={<TopBar title="Inbox" />}>
				<EmptyState icon={<InboxIcon />} title="No access to Inbox">Ask an owner for a role that can see Inbox.</EmptyState>
			</Scroll>
		);
	const newButton = <NewButton label="New conversation" onClick={() => setStarting(true)} />;
	return (
		<>
			{starting && <NewConversation onClose={() => setStarting(false)} />}
			{conversationId ? (
				<ConversationScreen key={conversationId} id={conversationId as Id<"inboxConversations">} actions={newButton} />
			) : (
				<Scroll header={<TopBar title="">{newButton}</TopBar>}>
					{list === undefined ? (
						<Loading />
					) : (
						<EmptyState icon={<InboxIcon />} title={list?.length ? "Pick a conversation" : "No conversations yet"}>
							{list?.length ? "Open one from the list." : "When someone emails or texts one of your agents, it shows up here."}
						</EmptyState>
					)}
				</Scroll>
			)}
		</>
	);
}

function ConversationScreen({ id, actions }: { id: Id<"inboxConversations">; actions: React.ReactNode }) {
	const c = useQuery(api.inbox.get, { id });
	const takeOver = useMutation(api.inbox.takeOver);
	const handBack = useMutation(api.inbox.handBack);
	const { error, run } = useRun();
	if (c === undefined) return <Scroll header={<TopBar title="" />}><Loading /></Scroll>;
	if (c === null)
		return (
			<Scroll header={<TopBar title="Not found">{actions}</TopBar>}>
				<EmptyState icon={<InboxIcon />} title="Conversation not found">It may have been deleted with its agent.</EmptyState>
			</Scroll>
		);
	const who = c.mode === "agent" ? `${c.agentName} answers` : c.takenByName ? `${c.takenByName} took it over` : "Staff answer";
	return (
		<Scroll
			overlayScrollbar
			header={
				<TopBar title={<span className="truncate">{contactLabel(c)}</span>} description={`${c.channel === "email" ? "Email" : "Text"} · ${who}`}>
					{c.mode === "agent" ? (
						<button type="button" className={barButton} onClick={() => run(takeOver({ id }))}>
							<TakeOverIcon /> Take over
						</button>
					) : (
						<button type="button" className={barButton} onClick={() => run(handBack({ id }))}>
							<TakeOverIcon /> Hand back to {c.agentName}
						</button>
					)}
					{actions}
				</TopBar>
			}
			footer={<ReplyBox conversation={c} />}
		>
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 pt-4 pb-6">
				<Notice>{error}</Notice>
				<div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${descriptionClass}`}>
					<span className="flex items-center gap-1.5"><ChannelIcon channel={c.channel} /> {c.channel === "sms" ? formatPhone(c.contact) : c.contact}</span>
					{c.subject && <span className="truncate">{c.subject}</span>}
					{c.record && (
						<button type="button" className={`flex items-center gap-1.5 ${linkButton}`} onClick={() => navigate(...recordPath(c.record!.typeKey, c.record!.id))}>
							<RecordIcon /> {c.record.title}
						</button>
					)}
				</div>
				{c.needsStaff === "handoff" && <Notice>{c.agentName} handed this to staff. Take it over to answer, or hand it back.</Notice>}
				{c.messages.map((m) => (m.status === "draft" ? <Draft key={m.id} message={m} channel={c.channel} agent={c.agentName} /> : <Bubble key={m.id} message={m} />))}
				{c.replying && <p className={metadataClass}>{c.agentName} is writing a reply…</p>}
			</div>
		</Scroll>
	);
}

type Message = Opened["messages"][number];

function Bubble({ message: m }: { message: Message }) {
	if (m.direction === "note")
		return (
			<div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm">
				<p className={metadataClass}>{m.by ?? "Agent"} · for staff only · {timeAgo(m.at)}</p>
				<p className="whitespace-pre-wrap">{m.text}</p>
			</div>
		);
	const mine = m.direction === "out";
	const state = m.status === "sending" ? "Sending…" : m.status === "failed" ? `Didn't send: ${m.error ?? "unknown error"}` : timeAgo(m.at);
	return (
		<div className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
			<div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap select-text ${mine ? "bg-neutral-900 text-white" : "bg-neutral-100"}`}>{m.text}</div>
			<p className={`${metadataClass} ${m.status === "failed" ? "text-red-600" : ""}`}>
				{mine ? `${m.by ?? "Agent"} · ` : ""}
				{state}
			</p>
		</div>
	);
}

/** The agent's reply, waiting because Public can't reply on its own: staff edit it, send it, or discard it. */
function Draft({ message: m, channel, agent }: { message: Message; channel: "email" | "sms"; agent: string }) {
	const send = useMutation(api.inbox.sendDraft);
	const discard = useMutation(api.inbox.discardDraft);
	const [text, setText] = useState(m.text);
	const { error, busy, run } = useRun();
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-4 py-3">
			<p className={metadataClass}>{agent} wrote a reply. Check it, then send it.</p>
			<textarea aria-label="Reply" rows={channel === "sms" ? 3 : 6} value={text} onChange={(e) => setText(e.target.value)} className={`${compactControlClass} w-full`} />
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
	);
}

/** Answer as the business, from the agent's address or number. */
function ReplyBox({ conversation: c }: { conversation: Opened }) {
	const reply = useMutation(api.inbox.reply);
	const [text, setText] = useState("");
	const { error, busy, run } = useRun();
	const blocked = !c.from;
	return (
		<div className="mx-auto w-full max-w-2xl px-6 pb-6">
			<Notice>{error}</Notice>
			<Form className="flex w-full items-end gap-2 rounded-2xl border border-neutral-200 bg-white p-2 pl-4 shadow-sm focus-within:border-neutral-300" onSubmit={() => run(reply({ id: c.id, text }).then(() => setText("")))}>
				<textarea
					aria-label="Reply"
					rows={2}
					disabled={blocked}
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder={blocked ? `${c.agentName} no longer has ${c.channel === "email" ? "an email address" : "a phone number"}.` : `Reply by ${c.channel === "email" ? "email" : "text"} from ${c.from}`}
					className="min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none"
				/>
				<button type="submit" disabled={busy || blocked || !text.trim()} className={sendButton} aria-label="Send">
					<ArrowUpIcon weight="bold" />
				</button>
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

