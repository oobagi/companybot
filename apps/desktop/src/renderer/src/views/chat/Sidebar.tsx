import { useStoredIds } from "../../arrangements";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { SectionTab } from "@companybot/core/arrangements";
import { Fragment, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery, useWorkspace } from "../../convex";
import { AgentIcon, ArchiveIcon, CaretRightIcon, ChannelIcon, ChatIcon, CheckIcon, CloseIcon, EditIcon, MembersIcon, MoreIcon, PinIcon, PlusIcon, PrivateIcon, SignOutIcon, ThreadIcon, TrashIcon, UnpinIcon } from "../../icons";
import { type PinKey, setRailVia, usePins } from "../../pins";
import { navigate } from "../../router";
import { blurActiveEditable, sidebarRow, useJump } from "../../shortcuts";
import { type Section, type SectionId, itemsGroup, unsectionedList, useSections, useUnsectioned } from "../../sections";
import { type DragListOptions, type DragProps, type RowDrag, splitDrag, useDragList, useDragStatic, useSortable } from "../../sortable";
import { CountBadge, Form, Notice, RenameInput, chevronButton, primaryButton, secondaryButton, surfaceButton, titleButton, trailingAction, useClock, useRun, fullControlClass } from "../../ui";
import { AgentBadge, Avatar, DialogButtons, MenuItem, Modal, Popover, PopoverPanel, archiveQuestion, useConfirm } from "./common";
import { AccessLock } from "../access";
import type { ChatList, Participant } from "./data";
import { BrowseChannels, ChannelDetailsFor, CreateChannel, NewMessage } from "./dialogs";
import { useDraftChats } from "./drafts";

type Dialog = "create" | "browse" | "message";

/** The other person in a DM with just one, whose photo stands for it. */
const soleOther = (members: Participant[], me: Id<"users">) => {
	const others = members.filter((m) => m.id !== me);
	return others.length === 1 ? others[0] : undefined;
};

type ChatNavProps = {
	chats: ChatList;
	/** The open chat, if the chat view is showing. */
	openId: Id<"chats"> | undefined;
	/** The thread open in it, if any. */
	openThread?: string;
	onOpen: (chatId: Id<"chats">) => void;
	onError: (e: unknown) => void;
	/** `agents.manage`: renames agents from their rows. */
	canManageAgents: boolean;
};

/**
 * Channels: the ones in no section at the top of the sidebar (like Drive's Home), in the workspace's
 * order, then the sections people add (`SectionsNav`), each channel with its active threads nested under
 * it (replied to lately, by the workspace's setting; `chats.activeThreads`). Drag a channel within or
 * between them. New channel, Browse channels and New section are the + beside the tab's name.
 */
export function ChannelsNav({ chats, openId, openThread, onOpen }: ChatNavProps) {
	const workspace = useWorkspace();
	const now = useClock();
	const threads = useQuery(api.chats.activeThreads, { now }) ?? [];
	const [folded, changeFolded] = useStoredIds("channelFolds");
	const [details, setDetails] = useState<Id<"chats">>();
	const [creatingIn, setCreatingIn] = useState<SectionId>();
	const markRead = useMutation(api.chats.markRead);
	const updateChannel = useMutation(api.chats.updateChannel);
	const leave = useMutation(api.chats.leave);
	const remove = useMutation(api.trash.move);
	const { error, run } = useRun();
	const { confirm, dialog: confirming } = useConfirm();
	const drafts = useDraftChats(chats.me, workspace?.id);
	const { place } = useSections("chat");
	const { sorted, drag } = useUnsectioned("chat", chats.channels, chatKey);
	const byId = useMemo(() => new Map<string, (typeof chats.channels)[number]>(chats.channels.map((c) => [c._id, c])), [chats.channels]);
	/** Leaving or deleting the open channel: nothing to show there anymore. */
	const left = (chatId: Id<"chats">) => chatId === openId && navigate("chat");
	const row = (c: (typeof chats.channels)[number], drag: DragProps | undefined) => {
				const own = threads.filter((t) => t.chatId === c._id);
				const open = !folded.includes(c._id);
		const d = splitDrag(drag);
				return (
					<div key={c._id} {...d.box} className={`flex flex-col gap-px ${d.box.className}`}>
				<Item
					drag={d.handle}
					pin={`chat:${c._id}`}
					icon={c.private ? <PrivateIcon /> : <ChannelIcon />}
					label={`#${c.name}`}
					expanded={open}
					onToggle={own.length ? () => changeFolded({ op: open ? "add" : "remove", id: c._id }) : undefined}
					active={c._id === openId}
					unread={c.unread}
					mentioned={c.mentioned}
					draft={drafts.has(c._id)}
					onClick={() => onOpen(c._id)}
					rename={c.canManage ? { value: c.name ?? "", onSave: (name) => run(updateChannel({ chatId: c._id, name })) } : undefined}
					menu={(close) => (
						<>
							<MenuItem onClick={() => (close(), setDetails(c._id))}><MembersIcon /> Members and details</MenuItem>
							<MenuItem onClick={() => (close(), run(markRead({ chatId: c._id })))}><CheckIcon /> Mark as read</MenuItem>
							{!c.isDefault && <MenuItem onClick={() => (close(), run(leave({ chatId: c._id }), () => left(c._id)))}><SignOutIcon /> Leave channel</MenuItem>}
							{c.canManage && !c.isDefault && (
								<MenuItem onClick={() => (close(), confirm(archiveQuestion(`#${c.name}`, () => remove({ kind: "channel", id: c._id }).then(() => left(c._id)), "The channel will close to new messages. Its messages and files are kept.")))}>
									<ArchiveIcon /> Archive channel
								</MenuItem>
							)}
						</>
					)}
				>
					<span className="truncate">{c.name}</span>
					<AccessLock lock={c.lock} verb="post in" />
				</Item>
				{open && own.map((t, i) => (
					<Item key={t.messageId} icon={<ThreadIcon />} guides={[i < own.length - 1]} title={t.title} active={c._id === openId && t.messageId === openThread} onClick={() => navigate("chat", c._id, "thread", t.messageId)}>
						<span className="truncate">{t.title}</span>
					</Item>
				))}
					</div>
				);
	};
	return (
		<>
			{!!sorted.length && <div className="flex flex-col gap-px">{sorted.map((c) => row(c, drag(c._id)))}</div>}
			<SectionsNav tab="chat">
				{(section, at) => {
					const rows = section.ids.filter((id) => byId.has(id));
					// Folded, what needs you stays, as in Direct messages.
					const keep = (id: string) => { const c = byId.get(id)!; return c._id === openId || c.unread || c.mentioned; };
					return <SectionGroup {...at} tab="chat" section={section} rows={rows} keep={keep} render={(id, drag) => row(byId.get(id)!, drag?.item)} add={<AddButton label={`New channel in ${section.name}`} onClick={() => setCreatingIn(section._id)} />} />;
				}}
			</SectionsNav>
			<Notice>{error}</Notice>
			{confirming}
			{details && <ChannelDetailsFor chatId={details} onClose={() => setDetails(undefined)} onLeft={() => left(details)} />}
			{creatingIn && <CreateChannel onClose={() => setCreatingIn(undefined)} onOpen={(id) => (place(id, creatingIn), onOpen(id))} />}
		</>
	);
}

/** The + beside Chat's name: New channel and Browse channels, for the channels listed under it, and New section. */
export function ChannelsAdd({ onOpen, onNewSection }: { onOpen: (chatId: Id<"chats">) => void; onNewSection?: () => void }) {
	const [dialog, setDialog] = useState<Dialog>();
	return (
		<>
			<AddMenu label="Add channels" actions={[{ label: "New channel", onClick: () => setDialog("create") }, { label: "Browse channels", onClick: () => setDialog("browse") }, ...(onNewSection ? [{ label: "New section", onClick: onNewSection }] : [])]} />
			{dialog === "create" && <CreateChannel onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "browse" && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</>
	);
}

/**
 * Direct messages: agents sit with people (labeled Bot), and each one is listed even before you've
 * written to it. Most recent first until you drag one; then your order, with new ones after.
 * An agent's side chats nest under it, like a channel's threads.
 */
export function DmsNav({ chats, openId, onOpen, onError, canManageAgents, section }: ChatNavProps & { section: SectionProps }) {
	const workspace = useWorkspace();
	const openDm = useMutation(api.chats.openDm);
	const createSide = useMutation(api.chats.createSideChat);
	const remove = useMutation(api.trash.move);
	const renameChat = useMutation(api.chats.renameChat);
	const renameAgent = useMutation(api.agents.rename);
	const [dialog, setDialog] = useState<Dialog>();
	const [folded, changeFolded] = useStoredIds("dmFolds");
	const { error, run } = useRun();
	const { confirm, dialog: confirming } = useConfirm();
	const sidesOf = (dmId: Id<"chats"> | null) => (dmId ? chats.dms.filter((d) => d.parentId === dmId) : []);
	const drafts = useDraftChats(chats.me, workspace?.id);
	// Your DMs with people (and groups), and one per agent; most recent first, then the agents you haven't messaged.
	const dms = useMemo(
		() =>
			[
				...chats.dms.filter((d) => !d.agentId && !d.parentId).map((d) => ({ key: d._id as string, dmId: d._id, name: d.title, image: soleOther(d.members, chats.me)?.image, agent: false, unread: d.unread, mentioned: d.mentioned, at: d.lastMessageAt, agentId: undefined, title: undefined as string | undefined })),
				...chats.agents.map((a) => ({ key: a._id as string, dmId: a.dmId, name: a.name, image: a.image, agent: true, unread: a.unread, mentioned: a.mentioned, at: a.lastMessageAt ?? 0, agentId: a._id, title: a.description })),
			].sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)),
		[chats],
	);
	const { sorted, drag } = useSortable("dms", dms, dmKey);
	// Collapsed, only what needs you stays: open or unread rows, and the side chats (and their agent) that are.
	const needed = (c: { _id: Id<"chats">; unread: boolean; mentioned: boolean }) => c._id === openId || c.unread || c.mentioned;
	const shown = section.collapsed ? sorted.filter((d) => (d.dmId && d.dmId === openId) || d.unread || d.mentioned || sidesOf(d.dmId).some(needed)) : sorted;
	const markRead = useMutation(api.chats.markRead);
	const closeDm = useMutation(api.chats.closeDm);
	return (
		<Group title="Direct messages" section={section} add={<AddButton label="New message" onClick={() => setDialog("message")} />}>
			{shown.map((d) => {
				const sides = section.collapsed ? sidesOf(d.dmId).filter(needed) : sidesOf(d.dmId);
				const open = section.collapsed || !folded.includes(d.key);
				/** A side chat with an agent you've never written to first needs the DM itself. */
				const newSide = async () => {
					const parentId = d.dmId ?? (await openDm({ userIds: [], agentIds: [d.agentId!] }));
					onOpen(await createSide({ parentId }));
				};
				const dd = splitDrag(drag(d.key));
				return (
					<div key={d.key} {...dd.box} className={`flex flex-col gap-px ${dd.box.className}`}>
				<Item
					drag={dd.handle}
					// No DM with this agent yet: pinning starts it (it's what the pin opens).
					pin={d.dmId ? `chat:${d.dmId}` : () => openDm({ userIds: [], agentIds: [d.agentId!] }).then((id) => `chat:${id}` as const, (e) => (onError(e), Promise.reject(e)))}
					icon={<Avatar name={d.name} image={d.image} agent={d.agent} size="row" />}
					label={d.name}
					active={!!d.dmId && d.dmId === openId}
					unread={d.unread}
					mentioned={d.mentioned}
					draft={!!d.dmId && drafts.has(d.dmId)}
					title={d.title}
					expanded={open}
					onToggle={sides.length ? () => changeFolded({ op: open ? "add" : "remove", id: d.key }) : undefined}
					onClick={() => (d.dmId ? onOpen(d.dmId) : d.agentId && openDm({ userIds: [], agentIds: [d.agentId] }).then(onOpen, onError))}
					// Agents rename here (`agents.manage`); a person's name is their own, set in their preferences.
					rename={d.agentId && canManageAgents ? { value: d.name, onSave: (name) => run(renameAgent({ agentId: d.agentId!, name })) } : undefined}
					// An agent you haven't written to yet has no chat to mark read.
					menu={
						d.dmId || d.agentId
							? (close) => (
									<>
										{d.agent && <MenuItem onClick={() => (close(), run(newSide()))}><PlusIcon /> New chat</MenuItem>}
										{d.dmId && <MenuItem onClick={() => (close(), markRead({ chatId: d.dmId! }).catch(onError))}><CheckIcon /> Mark as read</MenuItem>}
										{d.agentId && <MenuItem onClick={() => (close(), navigate("settings", "agents", d.agentId!))}><AgentIcon /> Agent settings</MenuItem>}
										{/* Hidden for you only, till someone writes there (Slack's Close). Agents' rows stay: they're how you reach them. */}
										{!d.agent && d.dmId && <MenuItem onClick={() => (close(), run(closeDm({ chatId: d.dmId! }), () => d.dmId === openId && navigate("chat")))}><CloseIcon /> Close conversation</MenuItem>}
									</>
								)
							: undefined
					}
				>
					<span className="truncate">{d.name}</span>
					{d.agent && <AgentBadge />}
				</Item>
				{open && sides.map((c, i) => (
					<Item
						key={c._id}
						pin={`chat:${c._id}`}
						icon={<ChatIcon />}
						guides={[i < sides.length - 1]}
						label={c.label ?? "New chat"}
						active={c._id === openId}
						unread={c.unread}
						mentioned={c.mentioned}
						onClick={() => onOpen(c._id)}
						rename={{ value: c.label ?? "", onSave: (title) => run(renameChat({ chatId: c._id, title })) }}
						menu={(close) => (
							<>
								<MenuItem onClick={() => (close(), markRead({ chatId: c._id }).catch(onError))}><CheckIcon /> Mark as read</MenuItem>
								<MenuItem onClick={() => (close(), confirm(archiveQuestion(c.label ?? "New chat", () => remove({ kind: "channel", id: c._id }).then(() => c._id === openId && d.dmId && onOpen(d.dmId)))))}><ArchiveIcon /> Archive</MenuItem>
							</>
						)}
					>
						<span className="truncate">{c.label}</span>
					</Item>
				))}
					</div>
				);
			})}
			<Notice>{error}</Notice>
			{confirming}
			{dialog === "message" && <NewMessage onClose={() => setDialog(undefined)} onOpen={onOpen} />}
		</Group>
	);
}

const chatKey = (c: { _id: string }) => c._id;
const dmKey = (d: { key: string }) => d.key;

/** What the sidebar gives each section: whether it's folded, and what folds it. */
export type SectionProps = { collapsed: boolean; onToggle: () => void };

/**
 * A sidebar section (Chat's Direct messages, Drive's All files, Databases' All databases, and the ones people add). With
 * `section`, click its title to fold it. `add` sits at the header's right end, showing on hover, then
 * `menu`'s ⋯ (also its right-click menu); `rename` puts Rename first in it and edits the title in place.
 * `drag` makes the header its handle among sections; `divider` makes the header a divider between drag
 * lists (`useDragStatic`), so a row dropped just under it goes in.
 */
export function Group({ title, section, add, menu, rename, drag, divider, children }: {
	title: string;
	section?: SectionProps;
	add?: React.ReactNode;
	menu?: (close: () => void) => React.ReactNode;
	rename?: { value: string; onSave: (name: string) => Promise<unknown> };
	drag?: DragProps;
	divider?: ReturnType<typeof useDragStatic>;
	children: React.ReactNode;
}) {
	const [renaming, setRenaming] = useState(false);
	const [menuAt, setMenuAt] = useState<"button" | { x: number; y: number }>();
	const closeMenu = () => setMenuAt(undefined);
	const titleRef = useRef<HTMLButtonElement>(null);
	const items = menu || rename
		? (close: () => void) => (
				<>
					{rename && <MenuItem onClick={() => (close(), setRenaming(true))}><EditIcon /> Rename</MenuItem>}
					{menu?.(close)}
				</>
			)
		: undefined;
	const d = splitDrag(drag);
	return (
		// Folded, ⌥1–9 skip its rows (`sidebarRow`).
		<section data-collapsed={section?.collapsed || undefined} {...d.box} className={`group/section relative flex flex-col gap-px ${d.box.className}`}>
			<div
				{...divider}
				// While renaming, a drag would take the text selection, and right-click is the input's own.
				// min-h-6: as tall with its + and ⋯ as without, so every section's rows start at the same place.
				onPointerDown={renaming ? undefined : d.handle?.onPointerDown}
				onContextMenu={items && !renaming ? (e) => (e.preventDefault(), setMenuAt({ x: e.clientX, y: e.clientY })) : undefined}
				className={`flex min-h-6 items-center justify-between gap-1 px-2 pb-1 ${divider?.className ?? ""}`}
			>
				{renaming && rename ? (
					<RenameInput value={rename.value} onSave={rename.onSave} onDone={() => setRenaming(false)} className="-my-0.5 -ml-1 min-w-0 flex-1 px-1 py-0.5 text-xs" />
				) : (
				<h2 className="min-w-0 truncate text-xs font-medium text-neutral-500">
					{section ? (
							<button ref={titleRef} type="button" onClick={section.onToggle} aria-expanded={!section.collapsed} className={`${titleButton} flex max-w-full items-center gap-0.5`}>
							<span className="truncate">{title}</span>
							<CaretRightIcon className={`shrink-0 ${section.collapsed ? "" : "rotate-90 opacity-0 group-hover/section:opacity-100"}`} />
						</button>
					) : (
						title
					)}
				</h2>
				)}
				{(add || items) && !renaming && (
					<span className={`flex items-center gap-0.5 ${menuAt ? "" : "opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"}`}>
						{add}
						{items && (
							<PopoverPanel
								opened={menuAt === "button"}
								onClose={closeMenu}
								className="w-52 p-1"
								target={
									<button type="button" title="More" aria-label={`Actions for ${title}`} onClick={() => setMenuAt(menuAt === "button" ? undefined : "button")} className={trailingAction}>
										<MoreIcon weight="bold" />
									</button>
								}
							>
								{items(closeMenu)}
							</PopoverPanel>
						)}
					</span>
				)}
				{items && typeof menuAt === "object" && (
					<PopoverPanel opened at={menuAt} returnFocus={titleRef} onClose={closeMenu} className="w-52 p-1">
						{items(closeMenu)}
					</PopoverPanel>
				)}
			</div>
			{children}
		</section>
	);
}

const sectionKey = (s: Section) => s._id;

/**
 * A tab's sections people added (backend sidebarSections.ts), in the workspace's order, after its rows
 * in no section. With `sidebar.arrange`, drag a header to move its section. `children` draws each one
 * (`SectionGroup`), told whether it's first: its header then also ends the list above, so that list
 * takes drops even when it's empty.
 */
export function SectionsNav({ tab, children }: { tab: SectionTab; children: (section: Section, at: { drag: DragProps | undefined; first: boolean }) => React.ReactNode }) {
	const { sections } = useSections(tab);
	const { sorted, drag } = useSortable("sectionOrder", sections, sectionKey, "y", undefined, { group: `${itemsGroup(tab)}:sections` });
	return <>{sorted.map((s, i) => <Fragment key={s._id}>{children(s, { drag: drag(s._id), first: i === 0 })}</Fragment>)}</>;
}

/** Where a deleted section's things go back to, by tab. */
const homeOf: Record<SectionTab, string> = { chat: "Its channels move back above the sections.", drive: "What it holds moves back to All files.", databases: "Its databases move back to All databases." };

/**
 * One section people added: `rows` (the ids it holds that this tab draws, in order; `render` draws one
 * with its drag). Each person folds it; folded, only the rows `keep` passes stay. With
 * `sidebar.arrange`, rows drag in, out and within it, and its header has `add` (a new thing in it) and
 * ⋯ (Rename, Delete section) on hover. Without, an empty one isn't shown. `children` follow its rows
 * (uploads in flight into it). `rowDrag`: what its rows say to the group's drags (Drive's folders take
 * rows in).
 */
export function SectionGroup({ tab, section, drag, first, rows, keep, render, rowDrag, add, children }: {
	tab: SectionTab;
	section: Section;
	drag: DragProps | undefined;
	first: boolean;
	rows: readonly string[];
	keep: (id: string) => boolean;
	render: (id: string, drag: RowDrag | undefined) => React.ReactNode;
	rowDrag?: DragListOptions;
	add?: React.ReactNode;
	children?: React.ReactNode;
}) {
	const { place, writable } = useSections(tab);
	const [folded, changeFolded] = useStoredIds("folded");
	const collapsed = folded.includes(section._id);
	const rename = useMutation(api.sidebarSections.rename);
	const remove = useMutation(api.sidebarSections.remove);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const { row, key } = useDragList({
		...rowDrag,
		group: itemsGroup(tab),
		enabled: writable,
		onDrop: (from, index) => {
			if (from.list === key && rows.indexOf(from.id) === index) return;
			place(from.id, section._id, rows.filter((id) => id !== from.id)[index] ?? null);
		},
	});
	const divider = useDragStatic(itemsGroup(tab), { startOf: key, endOf: first ? unsectionedList(tab) : undefined });
	if (!writable && !rows.length) return null;
	return (
		<Group
			title={section.name}
			section={{ collapsed, onToggle: () => changeFolded({ op: collapsed ? "remove" : "add", id: section._id }) }}
			drag={drag}
			divider={divider}
			add={writable && add}
			rename={writable ? { value: section.name, onSave: (name) => run(rename({ sectionId: section._id, name })) } : undefined}
			menu={writable ? (close) => (
				<MenuItem onClick={() => (close(), confirm({ title: `Delete “${section.name}”?`, action: "Delete section", body: `${homeOf[tab]} Nothing in it is deleted.`, onConfirm: () => remove({ sectionId: section._id }) }))}>
					<TrashIcon /> Delete section
				</MenuItem>
			) : undefined}
		>
			{(collapsed ? rows.filter(keep) : rows).map((id) => render(id, row(id)))}
			{children}
			<Notice>{error}</Notice>
			{dialog}
		</Group>
	);
}

/** New section, from the + beside the tab's name: it goes after the tab's others, empty. */
export function NewSection({ tab, onClose }: { tab: SectionTab; onClose: () => void }) {
	const create = useMutation(api.sidebarSections.create);
	const [name, setName] = useState("");
	const { error, run } = useRun();
	return (
		<Modal title="New section" size="md" onClose={onClose}>
			<Form onSubmit={() => run(create({ tab, name }), onClose)}>
				<input aria-label="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={tab === "chat" ? "e.g. Sales" : tab === "drive" ? "e.g. Clients" : "e.g. Pipeline"} className={fullControlClass} />
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={!name.trim()} className={primaryButton}>
						Create
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/**
 * The open tab's sidebar list. ⌥1–9 (Alt+1–9 off a Mac) open its Nth top-level row as shown,
 * unless you're typing (`shortcuts.ts`).
 */
export function SidebarList({ children }: { children: React.ReactNode }) {
	const list = useRef<HTMLDivElement>(null);
	useJump("item", (n) => {
		const row = sidebarRow(list.current, n);
		if (!row) return false;
		blurActiveEditable();
		row.click();
	});
	return (
		<div ref={list} className="flex flex-col gap-4 px-3 pb-2">
			{children}
		</div>
	);
}

/** The + beside a tab's name: one action is a button, more are a menu. */
export function AddMenu({ label, actions }: { label: string; actions: { label: string; onClick: () => void }[] }) {
	const [only] = actions;
	if (actions.length < 2) return only ? <AddButton label={only.label} onClick={only.onClick} /> : null;
	return (
		<Popover trigger={<PlusIcon />} label={label} className={trailingAction} panelClassName="w-48 p-1">
			{(close) => actions.map((a) => <MenuItem key={a.label} onClick={() => (close(), a.onClick())}>{a.label}</MenuItem>)}
		</Popover>
	);
}

/** A + on a section header or beside the tab's name. */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} title={label} aria-label={label} className={trailingAction}>
			<PlusIcon />
		</button>
	);
}

/**
 * A sidebar row. The row is the only hover surface; its controls show on hover at its right end.
 * `menu` gives it a ⋯ button and a right-click menu, the same items either way. `rename` makes
 * its name editable in place: double-click it, press F2 on it, or pick Rename (first in its menu).
 */
export function Item({
	icon,
	label,
	active,
	unread,
	mentioned,
	draft,
	muted,
	create,
	title,
	guides = [],
	expanded,
	onToggle,
	menu,
	actions,
	rename,
	drag,
	over,
	pin,
	onClick,
	children,
}: {
	/** Before the label: an icon or avatar, in a fixed-width slot so labels line up. */
	icon?: React.ReactNode;
	/** What the row is, for its menu button's accessible name ("#sales", a page's title). */
	label?: string;
	active?: boolean;
	unread?: boolean;
	mentioned?: boolean;
	/** Something typed in it and not sent; shown unless the chat is open, where the composer has it. */
	draft?: boolean;
	muted?: boolean;
	/** A "New …" row: not one of the list's things, so ⌥1–9 skip it. */
	create?: boolean;
	title?: string;
	/**
	 * A nested row: one entry per level above it, true where that level's line continues below
	 * this row (an ancestor, or this row itself, has siblings after it). Each level is a `Guide`
	 * cell before the icon, so that's also the indent.
	 */
	guides?: boolean[];
	/** A row with rows nested under it: hover swaps its icon for a chevron that folds them. */
	expanded?: boolean;
	onToggle?: () => void;
	/** The row's menu items (`MenuItem`s); `close` shuts the menu. */
	menu?: (close: () => void) => React.ReactNode;
	/** Other controls after the menu button. Controls in the icon slot need `relative z-10` to sit above the row's click area. */
	actions?: React.ReactNode;
	/** The name as edited (without a channel's #), and what saves a new one. */
	rename?: { value: string; onSave: (name: string) => Promise<unknown> };
	/** From `useSortable`: makes the row draggable within its list. */
	drag?: DragProps;
	/** A dragged row would go into this one if let go now (a Drive folder): it lights as if hovered. */
	over?: boolean;
	/**
	 * What it is as a pin: its menu gets Pin to rail / Unpin from rail. A function makes the thing
	 * first (an agent you haven't written to has no DM yet) and returns its key.
	 */
	pin?: PinKey | (() => Promise<PinKey>);
	onClick: () => void;
	children: React.ReactNode;
}) {
	const pins = usePins();
	const pinned = typeof pin === "string" && pins.pins.includes(pin);
	const togglePin = (key: PinKey | (() => Promise<PinKey>)) => (typeof key === "string" ? pins.toggle(key) : void key().then(pins.toggle, () => {}));
	// Open from its ⋯ button, or at the point you right-clicked.
	const [menuAt, setMenuAt] = useState<"button" | { x: number; y: number }>();
	const [renaming, setRenaming] = useState(false);
	const closeMenu = () => setMenuAt(undefined);
	const row = useRef<HTMLButtonElement>(null);
	const items =
		menu || rename || pin
			? (close: () => void) => (
					<>
						{rename && <MenuItem onClick={() => (close(), setRenaming(true))}><EditIcon /> Rename</MenuItem>}
						{pin && <MenuItem onClick={() => (close(), togglePin(pin))}>{pinned ? <><UnpinIcon /> Unpin from rail</> : <><PinIcon /> Pin to rail</>}</MenuItem>}
						{menu?.(close)}
					</>
				)
			: undefined;
	return (
		<div
			{...drag}
			// While renaming, a drag would take the text selection, and right-click is the input's own.
			onPointerDown={renaming ? undefined : drag?.onPointerDown}
			onContextMenu={items && !renaming ? (e) => (e.preventDefault(), setMenuAt({ x: e.clientX, y: e.clientY })) : undefined}
			className={`group/item relative flex items-stretch text-sm ${drag?.className ?? ""}`}
		>
			{/* Tree guides sit in a gutter before the pill, so hover and active backgrounds never paint over them. */}
			{guides.map((continues, level) => (
				<Guide key={level} continues={continues} elbow={level === guides.length - 1} />
			))}
			<div className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 ${itemTone({ active, unread, muted, open: !!menuAt, over })}`}>
			{icon && (
				<span className="flex size-[22px] shrink-0 items-center justify-center text-lg text-neutral-500">
					{onToggle ? (
						<>
							<span className="contents group-hover/item:hidden">{icon}</span>
							<button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${label ?? ""}`.trim()} aria-expanded={expanded} onClick={onToggle} className={`relative z-10 hidden group-hover/item:flex ${chevronButton}`}>
								<CaretRightIcon className={expanded ? "rotate-90" : ""} />
							</button>
						</>
					) : (
						icon
					)}
				</span>
			)}
			{renaming && rename ? (
				<RenameInput value={rename.value} onSave={rename.onSave} onDone={() => setRenaming(false)} className="-my-0.5 -ml-1.5 flex-1 px-1.5 py-0.5" />
			) : (
				<button
					ref={row}
					type="button"
					title={title}
					// ⌥1–9 count the list's top-level rows (`sidebarRow`).
					data-sidebar-item={!guides.length && !create ? "" : undefined}
					// A sidebar click is a choice too: the rail's tab lights, not a pin you came through.
					onClick={() => (setRailVia(undefined), onClick())}
					onDoubleClick={rename && (() => setRenaming(true))}
					onKeyDown={rename && ((e) => e.key === "F2" && (e.preventDefault(), setRenaming(true)))}
					className={`${surfaceButton} flex flex-1 items-center gap-2 after:absolute after:inset-0 after:rounded-lg`}
				>
					{/* A plain label ellipsizes like the others; richer children truncate their own text. */}
					{typeof children === "string" ? <span className="truncate">{children}</span> : children}
					{draft && !active && <span className="ml-auto shrink-0 text-xs font-normal text-neutral-400">Draft</span>}
					{mentioned && !active && (
						<CountBadge count="@" dark className="ml-auto" />
					)}
					{/* Unread, besides the bold name: a dot at the row's end, as on the rail. */}
					{unread && !mentioned && !active && <span aria-hidden className="ml-auto size-2 shrink-0 rounded-full bg-sky-500" />}
				</button>
			)}
			{(items || actions) && !renaming && (
				<span className={`relative z-10 items-center gap-0.5 ${menuAt ? "flex" : "hidden group-focus-within/item:flex group-hover/item:flex has-[[aria-expanded=true]]:flex"}`}>
					{items && (
						<PopoverPanel
							opened={menuAt === "button"}
							onClose={closeMenu}
							className="w-52 p-1"
							target={
								<button type="button" title="More" aria-label={label ? `Actions for ${label}` : "Actions"} onClick={() => setMenuAt(menuAt === "button" ? undefined : "button")} className={trailingAction}>
									<MoreIcon weight="bold" />
								</button>
							}
						>
							{items(closeMenu)}
						</PopoverPanel>
					)}
					{actions}
				</span>
			)}
			{items && typeof menuAt === "object" && (
				<PopoverPanel opened at={menuAt} returnFocus={row} onClose={closeMenu} className="w-52 p-1">
					{items(closeMenu)}
				</PopoverPanel>
			)}
			</div>
		</div>
	);
}

/**
 * One tree level's gutter: a 28px cell before the row's pill, so it's also the indent. Its line
 * hangs from the ancestor's icon center (19px in: the pill's 8px padding plus half the 22px icon
 * slot, the same at every depth) and runs the row's full height plus the 1px gap below, so a
 * curve branching off it never breaks it. The elbow stops just short of the pill.
 */
/** A guide's width: one level of the tree, for where a drag's line starts (sortable.ts). */
export const GUIDE_WIDTH = 28;
function Guide({ continues, elbow }: { continues: boolean; elbow: boolean }) {
	return (
		<span aria-hidden className="relative w-7 shrink-0">
			{/* A border, like the elbow's: a 1.5px fill and a 1.5px border round to different device pixels, so
			    where they overlapped the line read as double thick. Same stroke, so the overlap is exact. */}
			{continues && <span className="absolute -top-px bottom-0 left-[18.25px] tree-line" />}
			{elbow && <span className="absolute -top-px left-[18.25px] h-[calc(50%+1px)] w-2 tree-elbow rounded-bl-lg" />}
		</span>
	);
}

/** The pill's colors. Hover paints it when the pointer is anywhere on the row, gutter included; `over` (a drop would go into it) paints it darker. */
function itemTone({ active, unread, muted, open, over }: { active?: boolean; unread?: boolean; muted?: boolean; open?: boolean; over?: boolean }) {
	if (over) return "bg-neutral-200 text-neutral-900";
	if (active) return "bg-neutral-200/70 font-medium text-neutral-900";
	const hover = open ? "bg-neutral-100" : "group-hover/item:bg-neutral-100";
	if (unread) return `font-semibold text-neutral-900 ${hover}`;
	if (muted) return `text-neutral-400 group-hover/item:text-neutral-700 ${hover}`;
	return `text-neutral-600 ${hover}`;
}
