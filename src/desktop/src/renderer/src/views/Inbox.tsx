import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { Select } from "../controls";
import { useMutation, useQuery } from "../convex";
import {
	AgentIcon,
	AttachIcon,
	CaretUpDownIcon,
	CheckIcon,
	CloseIcon,
	HandIcon,
	InboxIcon,
	InstagramLogoIcon,
	MailIcon,
	MembersIcon,
	MessengerLogoIcon,
	PaperPlaneTiltIcon,
	PhoneIcon,
	RecordIcon,
	SavedReplyIcon,
	ReplyIcon,
	SidebarIcon,
	SparkleIcon,
	TagIcon,
	TextMessageIcon,
	TrashIcon,
	UserIcon,
	WebChatIcon,
	ChatIcon,
	MoreIcon,
	WhatsappLogoIcon,
} from "../icons";
import { navigate } from "../router";
import {
	CountBadge,
	EmptyState,
	Form,
	Loading,
	NotFound,
	Notice,
	Scroll,
	TopBar,
	bareFieldClass,
	bareSelectClass,
	choiceCardButton,
	actionButton,
	actionPrimaryButton,
	composerButton,
	descriptionClass,
	iconButton,
	inboxPill,
	conversationColumn,
	linkButton,
	metadataClass,
	primaryButton,
	secondaryButton,
	sentBubbleClass,
	shortAgo,
	labelButton,
	smallIconButton,
	quoteToggleButton,
	surfaceButton,
	useRun,
} from "../ui";
import { recordPath } from "./records/logic";
import { Avatar, DialogButtons, MenuItem, Modal, Popover, clock, dayLabel } from "./chat/common";
import { AddButton, AddMenu, Group as NavGroup, Item, SectionGroup, SectionsNav } from "./chat/Sidebar";
import { useUnsectioned } from "../sections";
import { type DragProps, useSortable } from "../sortable";
import { useStoredIds } from "../arrangements";
import { Composer } from "./chat/Composer";
import { Thread } from "./InboxComments";
import { ProfileLink } from "./chat/Profile";
import type { Participant } from "./chat/data";

// Inbox: conversations with people outside the workspace, by email and text (backend inbox.ts). The
// sidebar lists them, the latest first; one opens here with what was said, the agent's replies waiting
// for staff, and a box to answer as the business. Staff can take one over from its agent and hand it back.

type Opened = NonNullable<FunctionReturnType<typeof api.inbox.get>>;

const contactLabel = (c: { channel: "email" | "sms"; contact: string; contactName: string | null }) => c.contactName ?? (c.channel === "sms" ? formatPhone(c.contact) : c.contact);
const ChannelIcon = ({ channel, className }: { channel: "email" | "sms"; className?: string }) => (channel === "email" ? <MailIcon className={className} /> : <TextMessageIcon className={className} />);

type Row = NonNullable<FunctionReturnType<typeof api.inbox.list>>[number];

/** What Inbox's sidebar picks: a view of who's handling it, a channel, or something planned. */
type Filter = "needs" | "mine" | "agent" | "all" | "email" | "sms" | (typeof planned)[number]["id"];

const views = [
	{ id: "needs", label: "Needs you", icon: <HandIcon />, match: (c: Row) => !!c.needsStaff },
	{ id: "mine", label: "Assigned to me", icon: <UserIcon />, match: (c: Row) => c.mine },
	{ id: "agent", label: "Agent handling", icon: <AgentIcon />, match: (c: Row) => c.mode === "agent" },
	{ id: "all", label: "All", icon: <InboxIcon />, match: () => true },
] as const;

const channels = [
	{ id: "email", label: "Email", icon: <MailIcon />, match: (c: Row) => c.channel === "email" },
	{ id: "sms", label: "Texts", icon: <TextMessageIcon />, match: (c: Row) => c.channel === "sms" },
] as const;

/** Shown, greyed, so everyone can see what's coming. Picking one says what it will do. */
const planned = [
	{ id: "calls", label: "Calls", icon: <PhoneIcon />, text: "Your agents will answer calls and take messages. Recordings and transcripts will show up here." },
	{ id: "whatsapp", label: "WhatsApp", icon: <WhatsappLogoIcon />, text: "Answer WhatsApp messages here, with your agents' help, like email and texts." },
	{ id: "instagram", label: "Instagram", icon: <InstagramLogoIcon />, text: "Answer Instagram DMs here, with your agents' help." },
	{ id: "messenger", label: "Messenger", icon: <MessengerLogoIcon />, text: "Answer Facebook Messenger chats here, with your agents' help." },
	{ id: "webchat", label: "Web chat", icon: <WebChatIcon />, text: "A chat box for your website. Visitors' chats land here." },
	{ id: "tags", label: "Tags", row: "Tag conversations", icon: <TagIcon />, text: "Label conversations (new lead, billing, VIP) and see each label's here." },
] as const;

const filters: Record<string, { label: string; icon: React.ReactNode; match?: (c: Row) => boolean; text?: string; row?: string }> = Object.fromEntries([...views, ...channels, ...planned].map((f) => [f.id, f]));
/** Every sidebar row, in the order a new Inbox shows them (core `inboxRowIds`). */
const channelRows = [...channels, ...planned.filter((f) => f.id !== "tags")];
const tagsRow = planned.find((f) => f.id === "tags")!;
const rowKey = (r: { id: string }) => r.id;

// Which one is picked: the sidebar sets it, the conversation list reads it. Kept per computer.
const FILTER_KEY = "inboxFilter";
const pickedFilter = {
	value: ((): Filter => {
		try {
			const saved = localStorage.getItem(FILTER_KEY);
			if (saved && saved in filters) return saved as Filter;
		} catch {
			// Storage may be unavailable: start on All.
		}
		return "all";
	})(),
	listeners: new Set<() => void>(),
};
const subscribeFilter = (on: () => void) => (pickedFilter.listeners.add(on), () => void pickedFilter.listeners.delete(on));
function useFilter() {
	const filter = useSyncExternalStore(subscribeFilter, () => pickedFilter.value);
	const pick = (f: Filter) => {
		pickedFilter.value = f;
		try {
			localStorage.setItem(FILTER_KEY, f);
		} catch {
			// It still holds until reload.
		}
		pickedFilter.listeners.forEach((on) => on());
	};
	return [filter, pick] as const;
}

/**
 * Inbox's sidebar, laid out like Chat's: the views of who's handling what (Needs you counts what waits
 * for staff) on top and in the sections people add, moving like Chat's channels; then the built-in
 * Channels and Tags groups, like Direct messages: they fold, Channels' rows reorder, and nobody deletes them. The conversations are in their own column (InboxView).
 */
export function InboxNav() {
	const list = useQuery(api.inbox.list);
	const [filter, pick] = useFilter();
	// The views move like Chat's channels, into sections people add; Channels and Tags are built in, like Direct messages.
	const { sorted, drag } = useUnsectioned("inbox", views, rowKey);
	const channelOrder = useSortable("inboxChannels", channelRows, rowKey);
	const [folded, changeFolded] = useStoredIds("folded");
	const fold = (id: string) => ({ collapsed: folded.includes(id), onToggle: () => changeFolded({ op: folded.includes(id) ? "remove" : "add", id }) });
	const count = (match: (c: Row) => boolean) => list?.filter(match).length ?? 0;
	const row = (id: string, drag: DragProps | undefined) => {
		const f = filters[id];
		if (!f) return null;
		const soon = !f.match;
		const n = id === "needs" || id === "mine" ? count(f.match!) : 0;
		return (
			<Item key={id} drag={drag} icon={f.icon} label={f.label} active={filter === id} muted={soon} onClick={() => pick(id as Filter)}>
				<span className="truncate">{f.row ?? f.label}</span>
				{soon ? (
					<span className={`ml-auto shrink-0 font-normal ${metadataClass}`}>Soon</span>
				) : n > 0 && (id === "needs" ? <CountBadge count={n} className="ml-auto" /> : <span className={`ml-auto shrink-0 font-normal tabular-nums ${metadataClass}`}>{n}</span>)}
			</Item>
		);
	};
	return (
		<>
			{!!sorted.length && <div className="flex flex-col gap-px">{sorted.map((r) => row(r.id, drag(r.id)))}</div>}
			<SectionsNav tab="inbox" builtIns={[
				// Folded, only the picked row stays, like a folded section's.
				{ id: "inboxChannels", render: (at) => (
					<NavGroup title="Channels" section={fold("inboxChannels")} {...at}>
						{channelOrder.sorted.filter((r) => !folded.includes("inboxChannels") || r.id === filter).map((r) => row(r.id, channelOrder.drag(r.id)))}
					</NavGroup>
				) },
				{ id: "inboxTags", render: (at) => (
					<NavGroup title="Tags" section={fold("inboxTags")} {...at}>
						{(!folded.includes("inboxTags") || filter === tagsRow.id) && row(tagsRow.id, undefined)}
					</NavGroup>
				) },
			]}>
				{(section, at) => (
					// Folded, the picked one stays.
					<SectionGroup {...at} tab="inbox" section={section} rows={section.ids.filter((id) => id in filters)} keep={(id) => id === filter} render={(id, drag) => row(id, drag?.item)} />
				)}
			</SectionsNav>
		</>
	);
}

/** The conversations the sidebar picked, the latest first: who, when, the last thing said, and who's answering. */
function ConversationList({ openId }: { openId: string | undefined }) {
	const list = useQuery(api.inbox.list);
	const [filter] = useFilter();
	const f = filters[filter]!;
	const shown = f.match ? (list ?? []).filter(f.match) : [];
	return (
		<div className="flex w-80 shrink-0 flex-col border-r border-neutral-200">
			<Scroll header={<TopBar title={<h2 className="min-w-0 truncate">{f.label}</h2>} />}>
				{list === undefined ? (
					<Loading />
				) : !f.match ? (
					<EmptyState icon={f.icon} title={`${f.label} is coming soon`}>
						{f.text}
					</EmptyState>
				) : shown.length === 0 ? (
					<EmptyState icon={f.icon} title={filter === "needs" ? "Nothing needs you" : "No conversations"}>
						{filter === "needs" ? "When an agent hands one off or has a reply for you to check, it shows up here." : "When someone emails or texts one of your agents, it shows up here."}
					</EmptyState>
				) : (
					<div className="flex flex-col gap-px px-3 pb-3">
						{shown.map((c) => (
							<ConversationRow key={c.id} c={c} open={openId === c.id} />
						))}
					</div>
				)}
			</Scroll>
		</div>
	);
}

/** One waiting for staff is bold, with a dot on its icon. */
function ConversationRow({ c, open }: { c: Row; open: boolean }) {
	return (
		<Item
			icon={
				<span className="relative flex">
					<ChannelIcon channel={c.channel} />
					{/* Waiting for staff: a dot on the icon, the same spot on every row. Its ring matches the row behind it. */}
					{c.needsStaff && (
						<span
							aria-label="Needs staff"
							className={`absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ${open ? "ring-neutral-200" : "ring-white group-hover/item:ring-neutral-100"}`}
						/>
					)}
				</span>
			}
			label={contactLabel(c)}
			active={open}
			onClick={() => navigate("inbox", c.id)}
		>
			<span className="flex min-w-0 flex-1 flex-col py-0.5 text-left">
				<span className="flex items-baseline gap-2">
					<span className={`min-w-0 flex-1 truncate ${c.needsStaff ? "font-semibold text-neutral-900" : ""}`}>{contactLabel(c)}</span>
					<span className={`shrink-0 font-normal tabular-nums ${metadataClass}`}>{shortAgo(c.lastAt)}</span>
				</span>
				<span className="flex items-center gap-1.5">
					<span className="min-w-0 flex-1 truncate text-xs font-normal text-neutral-500">{c.preview || "No messages yet"}</span>
					{c.assignee && <Avatar name={c.assignee.name} image={c.assignee.image} agent={c.assignee.type === "agent"} size="xs" />}
				</span>
			</span>
		</Item>
	);
}

/** The + beside Inbox's name: starts a conversation from an agent's address or number, and (with `sidebar.arrange`) adds a section. */
export function InboxAdd({ canStart, onNewSection }: { canStart: boolean; onNewSection?: () => void }) {
	const [starting, setStarting] = useState(false);
	return (
		<>
			{onNewSection ? (
				<AddMenu label="New" actions={[...(canStart ? [{ label: "New conversation", onClick: () => setStarting(true) }] : []), { label: "New section", onClick: onNewSection }]} />
			) : (
				canStart && <AddButton label="New conversation" onClick={() => setStarting(true)} />
			)}
			{starting && <NewConversation onClose={() => setStarting(false)} />}
		</>
	);
}

/** Inbox on screen: the picked conversations, then the open one (else an empty state). */
export function InboxView({ access, conversationId }: { access: Access; conversationId: string | undefined }) {
	if (!can(access, "inbox.use"))
		return (
			<Scroll header={<TopBar title="Inbox" />}>
				<EmptyState icon={<InboxIcon />} title="No access to Inbox">Ask an owner for a role that can see Inbox.</EmptyState>
			</Scroll>
		);
	return (
		<div className="flex min-h-0 flex-1">
			<ConversationList openId={conversationId} />
			<div className="flex min-w-0 flex-1 flex-col">
				{conversationId ? (
					<ConversationScreen key={conversationId} id={conversationId as Id<"inboxConversations">} />
				) : (
					<Scroll header={<TopBar title="" />}>
						<EmptyState icon={<InboxIcon />} title="Pick a conversation">
							Open one from the list. Start one with + beside Inbox.
						</EmptyState>
					</Scroll>
				)}
			</div>
		</div>
	);
}

function ConversationScreen({ id }: { id: Id<"inboxConversations"> }) {
	const c = useQuery(api.inbox.get, { id });
	if (!c)
		return (
			<NotFound loaded={c === null} icon={<InboxIcon />} title="Conversation not found">
				It may have been deleted with its agent.
			</NotFound>
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
		<Customer.Provider value={c}>
			<div ref={row} className="relative flex min-h-0 min-w-0 flex-1">
				<Messages
					c={c}
					them={them}
					bar={
						<TopBar title={<h1 className="min-w-0 truncate"><CustomerLink className="hover:underline">{them}</CustomerLink></h1>} description={c.channel === "email" ? "Email" : "Text"}>
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
		</Customer.Provider>
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
	const items = itemsOf(c.messages, c.channel);
	const email = c.channel === "email";
	const sent = c.messages.filter((m) => m.direction !== "event" && m.status !== "draft");
	// An email thread shows the latest email open and the rest folded to a line, as a mail app does; a click flips one.
	const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
	const isOpen = (m: Message) => (m.id === sent.at(-1)?.id || m.status === "failed" || m.status === "sending") !== flipped.has(m.id);
	const flip = (id: string) => setFlipped((set) => (set.has(id) ? new Set([...set].filter((x) => x !== id)) : new Set([...set, id])));
	// The email a reply answers: one picked with its Reply, else their latest (else ours).
	const [picked, setPicked] = useState<string>();
	const [commenting, setCommenting] = useState<string>();
	const answering = email ? (sent.find((m) => m.id === picked) ?? sent.findLast((m) => m.direction === "in") ?? sent.at(-1)) : undefined;
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
						<ReplyBox conversation={c} answering={answering} picked={!!picked && answering?.id === picked} onSent={() => setPicked(undefined)} />
					</div>
					{side && <div aria-hidden className="w-72 shrink-0" />}
				</div>
			}
			onScroll={(e) => (nearBottom.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 120)}
		>
			<div className="flex flex-1 items-start">
				<div ref={content} className={`${conversationColumn} flex flex-1 flex-col justify-end self-stretch px-5 pt-4 pb-5`}>
					{email && c.subject && <h2 className="pt-4 pb-2 text-lg font-semibold break-words text-neutral-900">{c.subject}</h2>}
					{items.map((item, i) => {
						const first = item.messages[0]!;
						const prev = items[i - 1]?.messages.at(-1);
						// A time over the first, and after a quiet stretch; room between groups. Emails carry their own time, a line between each.
						const stamp = !email && (!prev || first.at - prev.at > GROUP_GAP_MS);
						return (
							<Fragment key={first.id}>
								{stamp && <p className={`pt-8 pb-4 text-center tabular-nums ${metadataClass}`}>{dayLabel(first.at)}, {clock(first.at)}</p>}
								{/* Emails get a line between them; a line between emails (an assignment) separates them itself. A draft's box sits a little below its line. */}
								<div className={`group/msg ${email ? (first.direction === "event" ? "py-3" : `${prev && prev.direction !== "event" ? "border-t border-neutral-100" : ""}`) : stamp ? "" : "pt-3"}`}>
									{first.assignedTo ? (
										<Line who={first.author} name="Someone on staff">
											assigned this to <PersonPill who={first.assignedTo} />
										</Line>
									) : first.status === "draft" ? (
										<Draft message={first} channel={c.channel} agent={c.agent} />
									) : email ? (
										<EmailItem
											message={first}
											them={them}
											contact={c.contact}
											open={isOpen(first)}
											onToggle={() => flip(first.id)}
											replying={answering?.id === first.id}
											onReply={() => setPicked(picked === first.id ? undefined : first.id)}
											onComment={() => setCommenting(first.id)}
										/>
									) : (
										<Group messages={item.messages} them={them} channel={c.channel} subject={c.subject} />
									)}
									{first.direction !== "event" && (
										<Thread
											messageId={item.messages.at(-1)!.id}
											comments={item.messages.flatMap((m) => m.comments).sort((a, b) => a.at - b.at)}
											side={email || first.direction === "in" ? "them" : "us"}
											{...(email && { className: `pb-3 pl-12 ${first.status !== "draft" && !isOpen(first) ? "-mt-1.5" : ""}`, quiet: true, open: commenting === first.id, onOpenChange: (on: boolean) => setCommenting(on ? first.id : undefined) })}
										/>
									)}
									{/* Lines get the same room under them as a group's comment pill, so every gap is the same. */}
									{!email && first.direction === "event" && <div aria-hidden className="h-7.5" />}
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
		<section aria-label="Details" className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm">
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
						<RecordIcon className="shrink-0 text-neutral-400" /> <span className="truncate">{c.record.title}</span>
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
				className={`${bareSelectClass} -mr-1.5 gap-2`}
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
		<ProfileLink who={who} className={`${inboxPill} bg-neutral-100 pl-1 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900`}>
			{inside}
		</ProfileLink>
	) : (
		<span className={`${inboxPill} bg-neutral-100 pl-1 text-neutral-600`}>{inside}</span>
	);
}

/** Messages this close together sit in one group under one time. */
const GROUP_GAP_MS = 15 * 60_000;
const sideOf = (m: Message) => (m.direction === "in" ? "them" : m.direction === "event" ? "event" : "us");

/**
 * The conversation as groups: a run of messages from one sender, close in time, is one group (one name
 * over it, connected bubbles, one comment thread under it). Lines and drafts stand alone.
 */
function itemsOf(messages: Message[], channel: "email" | "sms") {
	const items: { messages: Message[] }[] = [];
	// An email is a row of its own; texts from one sender run together.
	const alone = (m: Message) => channel === "email" || m.direction === "event" || m.status === "draft";
	for (const m of messages) {
		const run = items.at(-1)?.messages;
		const prev = run?.at(-1);
		if (run && prev && !alone(m) && !alone(prev) && sideOf(prev) === sideOf(m) && prev.author?.name === m.author?.name && m.at - prev.at <= GROUP_GAP_MS) run.push(m);
		else items.push({ messages: [m] });
	}
	return items;
}

/**
 * One email in a thread, as a mail app lists it: who, to whom and when, then the body. Folded, the body
 * is one line under the name; the header opens and folds it. Reply and Comment sit by the time (on
 * hover); Reply stays lit on the email the reply box answers.
 */
function EmailItem({ message: m, them, contact, open, onToggle, replying, onReply, onComment }: { message: Message; them: string; contact: string; open: boolean; onToggle: () => void; replying: boolean; onReply: () => void; onComment: () => void }) {
	const mine = m.direction !== "in";
	const failed = m.status === "failed";
	const name = mine ? (m.author?.name ?? "Someone on staff") : them;
	const forWho = m.author?.for;
	const hover = "opacity-0 group-hover/email:opacity-100 focus-visible:opacity-100";
	const [history, setHistory] = useState(false);
	return (
		<article className={`group/email relative flex flex-col ${open ? "pb-3" : ""}`}>
			{/*
			 * Folded, one line: who, then a gray preview. Open, who and their address, with the email under it.
			 * The whole row folds and opens it; our people's and agents' names and pictures open their card, as in texts.
			 */}
			<div className={`relative flex w-full gap-3 py-2.5 ${open ? "items-start" : "items-center"}`}>
				<button type="button" aria-expanded={open} aria-label={`${open ? "Fold" : "Open"} the email from ${name}`} onClick={onToggle} className={`${surfaceButton} absolute inset-0`} />
				<span className="pointer-events-none relative flex min-w-0 flex-1 gap-3">
					{m.author ? (
						<ProfileLink who={m.author} className="pointer-events-auto shrink-0 self-start rounded-full">
							<Avatar name={name} image={m.author.image} agent={m.author.type === "agent"} size="md" />
						</ProfileLink>
					) : (
						<CustomerLink className="pointer-events-auto shrink-0 self-start rounded-full">
							<Avatar name={name} size="md" />
						</CustomerLink>
					)}
					{/* Room on the right for the time and buttons over this line. */}
					<span className={`flex min-w-0 flex-1 items-baseline gap-2 pr-48 ${open ? "" : "self-center"}`}>
						{m.author ? (
							<ProfileLink who={m.author} className="pointer-events-auto shrink-0 font-medium text-neutral-900 hover:underline">
								{name}
							</ProfileLink>
						) : (
							<CustomerLink className="pointer-events-auto shrink-0 font-medium text-neutral-900 hover:underline">
								{name}
							</CustomerLink>
						)}
						{open ? (
							<span className={`min-w-0 truncate ${metadataClass}`}>
								{mine ? `to ${them}` : contact}
								{m.cc.length > 0 && `, also to ${m.cc.join(", ")}`}
								{forWho && (
									<>
										{", for "}
										<ProfileLink who={forWho} className="pointer-events-auto hover:underline">
											{forWho.name}
										</ProfileLink>
									</>
								)}
								{m.delivery === "delivered" && " · Delivered"}
							</span>
						) : (
							<span className="min-w-0 truncate text-neutral-500">{m.text.replace(/\s+/g, " ")}</span>
						)}
					</span>
				</span>
			</div>
			<span className={`absolute right-0 flex items-center gap-0.5 ${open ? "top-2" : "top-3.5"}`}>
				<button type="button" title="Comment" aria-label="Comment" className={`${smallIconButton} ${hover}`} onClick={onComment}>
					<ChatIcon />
				</button>
				<button type="button" title={replying ? "Replying to this email" : "Reply to this email"} aria-label="Reply" aria-pressed={replying} className={`${smallIconButton} ${replying ? "text-neutral-900" : hover}`} onClick={onReply}>
					<ReplyIcon />
				</button>
				<span className={`pl-1 tabular-nums ${metadataClass}`}>
					{dayLabel(m.at)}, {clock(m.at)}
				</span>
			</span>
			{/* Pulled up under the name, not under the picture. */}
			{open && (
				<div className="relative -mt-5 flex flex-col items-start gap-2 pl-12">
					<LinkedText text={m.text} className="w-full" />
					{/* The history their mail app quoted under it, folded like Gmail's. */}
					{m.quoted && (
						<>
							<button type="button" aria-expanded={history} aria-label={history ? "Hide quoted text" : "Show quoted text"} title={history ? "Hide quoted text" : "Show quoted text"} className={quoteToggleButton} onClick={() => setHistory(!history)}>
								<MoreIcon />
							</button>
							{/* The border marks it as quoted: their ">" marks go. */}
							{history && <LinkedText text={m.quoted.replace(/^(> ?)+/gm, "")} className="w-full border-l-2 border-neutral-200 pl-3 text-neutral-500" />}
						</>
					)}
				</div>
			)}
			{(failed || m.status === "sending") && <p className={`pt-1 pl-12 ${failed ? "text-xs text-red-600" : metadataClass}`}>{failed ? `Didn't send: ${m.error ?? "unknown error"}` : "Sending…"}</p>}
			{m.delivery === "bounced" && <p className="pt-1 pl-12 text-xs text-red-600">Bounced: {m.error}</p>}
			{m.delivery === "spam" && <p className="pt-1 pl-12 text-xs text-amber-700">They marked it as spam. Their mail app may hide what this address sends them.</p>}
		</article>
	);
}

// Web addresses and email addresses in what a customer wrote: "<https://…>", "[https://…]" and "(https://…)" too,
// without the punctuation around them.
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;
const TRAILING = /[.,;:!?'")\]>]+$/;

/** Plain text (never their HTML), its links clickable: a bare web address shows as its site, the whole address on hover. */
function LinkedText({ text, className = "" }: { text: string; className?: string }) {
	const parts: React.ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(LINK)) {
		const raw = match[0];
		const link = raw.replace(TRAILING, "");
		const at = match.index;
		parts.push(text.slice(last, at));
		const email = !/^(https?:|www\.)/i.test(link);
		const href = email ? `mailto:${link}` : /^www\./i.test(link) ? `https://${link}` : link;
		let label = link;
		if (!email) try { label = new URL(href).hostname.replace(/^www\./, ""); } catch { /* shown as written */ }
		parts.push(
			<a key={at} href={href} target="_blank" rel="noreferrer" title={email ? undefined : href} className="text-link hover:underline">
				{label}
			</a>,
		);
		last = at + link.length;
	}
	parts.push(text.slice(last));
	return <p className={`break-words whitespace-pre-wrap ${className}`}>{parts}</p>;
}

/** The open conversation, for its customer's card wherever their name shows. */
const Customer = createContext<Opened | null>(null);

/** A customer's name or picture: their card on click, as a teammate's or an agent's opens theirs. */
function CustomerLink({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	const c = useContext(Customer);
	if (!c) return <span className={className}>{children}</span>;
	return (
		<Popover trigger={children} className={`cursor-pointer ${className}`}>
			{() => <CustomerCard conversation={c} />}
		</Popover>
	);
}

/** Who they are to you: name, their address or number, and the record they're linked to. */
function CustomerCard({ conversation: c }: { conversation: Opened }) {
	const them = contactLabel(c);
	const address = c.channel === "sms" ? formatPhone(c.contact) : c.contact;
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-3">
				<Avatar name={them} />
				<div className="min-w-0">
					<p className="truncate font-semibold">{them}</p>
					<p className="truncate text-neutral-500 select-text">{them === address ? (c.channel === "sms" ? "Texts" : "Emails") + " your agents" : address}</p>
				</div>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
				<dt className="text-neutral-500">Record</dt>
				<dd className="min-w-0 truncate">{c.record ? c.record.title : "Not in your records"}</dd>
			</dl>
			<div className="flex">
				{c.record ? (
					<button type="button" onClick={() => navigate(...recordPath(c.record!.typeKey, c.record!.id))} className={actionButton}>
						Open record
					</button>
				) : (
					<Soon trigger="Add to records" label="Add to records" text={`Save ${them} as a contact, with their ${c.channel === "sms" ? "number" : "address"} filled in.`} className={actionButton} />
				)}
			</div>
		</div>
	);
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
			<div className="pb-1.5">
				<CustomerLink className={`${line} rounded-md`}>
					<Avatar name={them ?? "Them"} size="sm" />
					<span className="hover:underline">{them}</span>
				</CustomerLink>
			</div>
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
			<div className={`max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 select-text ${corners}`}>
				{subject && (
					<p className="flex items-center gap-2 pb-1 font-semibold text-neutral-900">
						<MailIcon /> {subject}
					</p>
				)}
				<p className="break-words whitespace-pre-wrap">{m.text}</p>
			</div>
		) : (
			<div className={`max-w-[75%] rounded-2xl px-4 py-2.5 select-text ${corners} ${mine ? sentBubbleClass : "bg-neutral-100 text-neutral-900"}`}>
				<LinkedText text={m.text} />
			</div>
		);
	const forWho = m.author?.for;
	return (
		<div className={`flex w-full flex-col ${mine ? "items-end" : "items-start"}`}>
			{body}
			{(failed || m.status === "sending") && <p className={`pt-1 ${failed ? "text-xs text-red-600" : metadataClass}`}>{failed ? `Didn't send: ${m.error ?? "unknown error"}` : "Sending…"}</p>}
			{!failed && m.status !== "sending" && last && forWho && (
				<p className={`pt-1 ${metadataClass}`}>
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
	const email = channel === "email";
	return (
		<div className="flex flex-col items-end">
			{email ? null : <Sender author={agent} them="Agent" mine />}
			{/* In an email thread, laid out like the emails around it (no box, so it lines up with them): who, then the draft under their name. */}
			<div className={`flex flex-col gap-2.5 ${email ? "w-full py-2.5" : "w-[85%] rounded-2xl border border-dashed border-neutral-300 bg-white px-4 py-3"}`}>
				{email ? (
					<p className="flex min-w-0 items-start gap-3">
						<Avatar name={agent?.name ?? "Agent"} image={agent?.image} agent size="md" />
						<span className="flex min-w-0 items-center gap-2">
							<span className="shrink-0 font-medium text-neutral-900">{agent?.name ?? "Agent"}</span>
							<span className={`${inboxPill} bg-amber-50 pl-2.5 text-amber-800`}>Draft</span>
							<span className={`min-w-0 truncate ${metadataClass}`}>Check it, then send it.</span>
						</span>
					</p>
				) : (
					<p className="text-xs text-neutral-500">Draft reply. Check it, then send it.</p>
				)}
				<textarea aria-label="Reply" rows={email ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} className={`w-full resize-none bg-transparent outline-none ${email ? "-mt-5 field-sizing-content pl-12" : ""}`} />
				<Notice>{error}</Notice>
				<div className="flex justify-end gap-2">
					<button type="button" disabled={busy} className={actionButton} onClick={() => run(discard({ messageId: m.id }))}>
						<TrashIcon /> Discard
					</button>
					<button type="button" disabled={busy || !text.trim()} className={actionPrimaryButton} onClick={() => run(send({ messageId: m.id, text }))}>
						Send
					</button>
				</div>
			</div>
		</div>
	);
}

/** Answer as the business, from the agent's address or number. Enter sends; Shift+Enter starts a new line. */
function ReplyBox({ conversation: c, answering, picked, onSent }: { conversation: Opened; answering: Message | undefined; picked: boolean; onSent: () => void }) {
	const reply = useMutation(api.inbox.reply);
	const sendWith = useQuery(api.preferences.get)?.sendWith ?? "enter";
	const { error, fail } = useRun();
	const who = contactLabel(c);
	const email = c.channel === "email";
	// A send that fails puts the text back in the box (Composer), with why above it.
	const send = (text: string) => {
		fail();
		const sending = reply({ id: c.id, text, ...(picked && answering && { answers: answering.id }) });
		sending.then(onSent, fail);
		return sending;
	};
	return (
		<div className={`${conversationColumn} flex flex-col gap-2 px-5 pt-4 pb-7`}>
			<Notice>{error}</Notice>
			{/* An email's reply: what it answers on a card tucked behind the box's top edge (pick another with an email's Reply). With no address or number to send from, the box stays, greyed, saying why. */}
			<div className={`relative ${email && c.from ? "pt-8" : ""}`}>
				{email && c.from && (
					<div aria-label="Replying to" className="absolute inset-x-3 top-0 flex h-14 min-w-0 items-start gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 pt-1 text-sm">
						<span className="flex h-6 min-w-0 flex-1 items-center gap-2">
							<ReplyIcon className="shrink-0 text-neutral-500" />
							<span className="max-w-1/2 shrink-0 truncate font-medium text-neutral-900">{c.subject || "(no subject)"}</span>
							{answering && <span className="min-w-0 flex-1 truncate text-neutral-500">{answering.text.replace(/\s+/g, " ")}</span>}
						</span>
						<span className="flex shrink-0 items-center gap-1">
							<Soon trigger="Cc" label="Cc" text="Copy teammates or anyone else on a reply." className={labelButton} />
							<Soon trigger="Bcc" label="Bcc" text="Copy someone without the others seeing." className={labelButton} />
							<Soon trigger={<CloseIcon />} label="New email" text="Start a new email to them, with its own subject, instead of replying." className={smallIconButton} />
						</span>
					</div>
				)}
				<div className="relative">
					<Composer
						key={c.id}
						sendWith={sendWith}
						placeholder={!c.from ? `${c.agentName} has no ${email ? "email address" : "phone number"} now, so replies can't be sent` : email ? `Reply to ${who}` : `Text ${who}`}
						disabled={!c.from}
						sources={noSources}
						draftKey={`inbox:${c.id}`}
						onSend={send}
						start={<Soon trigger={<AttachIcon />} label="Attach files" text="Send photos and files by email and text." />}
						tools={
							<>
								<Soon trigger={<SparkleIcon />} label="Write a reply" text={`${c.agentName} will draft a reply from the conversation and ${who}'s record, for you to edit.`} />
								<Soon trigger={<SavedReplyIcon />} label="Saved replies" text="Answers your team sends often, a click away." />
							</>
						}
					/>
				</div>
			</div>
		</div>
	);
}

/** Inbox replies go to someone outside: nobody to @mention, no channels or skills. Emoji (:) still work. */
const noSources = { people: [], agents: [], channels: [], skills: [] };

/** Something planned (a composer tool, Cc): there to see, and says what it will do, in a popover. */
function Soon({ trigger, label, text, className = composerButton }: { trigger: React.ReactNode; label: string; text: string; className?: string }) {
	return (
		<Popover trigger={trigger} label={`${label} (coming soon)`} className={className} panelClassName="w-64 p-3">
			<p className="text-sm font-medium text-neutral-900">{label}</p>
			<p className={descriptionClass}>{text}</p>
			<p className={`pt-2 ${metadataClass}`}>Coming soon</p>
		</Popover>
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
		<Modal title="New conversation" onClose={onClose}>
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
