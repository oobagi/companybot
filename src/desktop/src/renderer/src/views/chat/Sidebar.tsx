import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery, useWorkspace } from "../../convex";
import { AgentIcon, ArchiveIcon, CaretRightIcon, ChannelIcon, ChatIcon, CheckIcon, CloseIcon, EditIcon, MembersIcon, MoreIcon, PlusIcon, PrivateIcon, SignOutIcon, ThreadIcon } from "../../icons";
import { navigate } from "../../router";
import { type DragProps, useSortable, useStoredIds } from "../../sortable";
import { Notice, RenameInput, useClock, useRun } from "../../ui";
import { AgentBadge, Avatar, MenuItem, Popover, PopoverPanel, archiveQuestion, useConfirm } from "./common";
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
	section: SectionProps;
};

/**
 * Channels, in your own order (drag to change), each with its active threads nested under it
 * (replied to lately, by the workspace's setting; `chats.activeThreads`). Collapsed, it keeps
 * only the open one and unread ones, like Slack.
 */
export function ChannelsNav({ chats, openId, openThread, onOpen, section }: ChatNavProps) {
	const workspace = useWorkspace();
	const now = useClock();
	const threads = useQuery(api.chats.activeThreads, section.collapsed ? "skip" : { now }) ?? [];
	const [folded, setFolded] = useStoredIds(`sidebar.channels.folded:${workspace?.id}`);
	const [dialog, setDialog] = useState<Dialog>();
	const [details, setDetails] = useState<Id<"chats">>();
	const markRead = useMutation(api.chats.markRead);
	const updateChannel = useMutation(api.chats.updateChannel);
	const leave = useMutation(api.chats.leave);
	const remove = useMutation(api.trash.move);
	const { error, run } = useRun();
	const { confirm, dialog: confirming } = useConfirm();
	const drafts = useDraftChats(chats.me, workspace?.id);
	const { sorted, drag } = useSortable(`sidebar.channels:${workspace?.id}`, chats.channels, chatKey);
	const shown = section.collapsed ? sorted.filter((c) => c._id === openId || c.unread || c.mentioned) : sorted;
	/** Leaving or deleting the open channel: nothing to show there anymore. */
	const left = (chatId: Id<"chats">) => chatId === openId && navigate("chat");
	return (
		<Group
			title="Channels"
			section={section}
			add={
				<Popover trigger={<PlusIcon />} label="Add channels" className={trailingAction} panelClassName="w-48 p-1">
					{(close) => (
						<>
							<MenuItem onClick={() => (close(), setDialog("create"))}>New channel</MenuItem>
							<MenuItem onClick={() => (close(), setDialog("browse"))}>Browse channels</MenuItem>
						</>
					)}
				</Popover>
			}
		>
			{shown.map((c) => {
				const own = threads.filter((t) => t.chatId === c._id);
				const open = !folded.includes(c._id);
				return (
					<Fragment key={c._id}>
				<Item
					drag={drag(c._id)}
					icon={c.private ? <PrivateIcon /> : <ChannelIcon />}
					label={`#${c.name}`}
					expanded={open}
					onToggle={own.length ? () => setFolded(open ? [...folded, c._id] : folded.filter((id) => id !== c._id)) : undefined}
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
				</Item>
				{open && own.map((t, i) => (
					<Item key={t.messageId} icon={<ThreadIcon />} guides={[i < own.length - 1]} title={t.title} active={c._id === openId && t.messageId === openThread} onClick={() => navigate("chat", c._id, "thread", t.messageId)}>
						<span className="truncate">{t.title}</span>
					</Item>
				))}
					</Fragment>
				);
			})}
			<Notice>{error}</Notice>
			{confirming}
			{dialog === "create" && <CreateChannel onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{dialog === "browse" && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={onOpen} />}
			{details && <ChannelDetailsFor chatId={details} onClose={() => setDetails(undefined)} onLeft={() => left(details)} />}
		</Group>
	);
}

/**
 * Direct messages: agents sit with people (labeled Bot), and each one is listed even before you've
 * written to it. Most recent first until you drag one; then your order, with new ones after.
 * An agent's side chats nest under it, like a channel's threads.
 */
export function DmsNav({ chats, openId, onOpen, onError, canManageAgents, section }: ChatNavProps) {
	const workspace = useWorkspace();
	const openDm = useMutation(api.chats.openDm);
	const createSide = useMutation(api.chats.createSideChat);
	const remove = useMutation(api.trash.move);
	const renameChat = useMutation(api.chats.renameChat);
	const renameAgent = useMutation(api.agents.rename);
	const [dialog, setDialog] = useState<Dialog>();
	const [folded, setFolded] = useStoredIds(`sidebar.dms.folded:${workspace?.id}`);
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
	const { sorted, drag } = useSortable(`sidebar.dms:${workspace?.id}`, dms, dmKey);
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
				return (
					<Fragment key={d.key}>
				<Item
					drag={drag(d.key)}
					icon={<Avatar name={d.name} image={d.image} agent={d.agent} size="row" />}
					label={d.name}
					active={!!d.dmId && d.dmId === openId}
					unread={d.unread}
					mentioned={d.mentioned}
					draft={!!d.dmId && drafts.has(d.dmId)}
					title={d.title}
					expanded={open}
					onToggle={sides.length ? () => setFolded(open ? [...folded, d.key] : folded.filter((id) => id !== d.key)) : undefined}
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
					</Fragment>
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

/** What the sidebar gives each section: whether it's folded, and its drag handle (the header) and drop area. */
export type SectionProps = { collapsed: boolean; onToggle: () => void; drag: DragProps };

/**
 * A sidebar section. With `section`, click its title to fold it and drag its title to move it.
 * `add` sits at the header's right end, showing on hover.
 */
export function Group({ title, section, add, children }: { title: string; section?: SectionProps; add?: React.ReactNode; children: React.ReactNode }) {
	const { draggable, onDragStart, onDragEnd, className = "", ...target } = section?.drag ?? {};
	return (
		<section {...target} className={`group/section relative flex flex-col gap-px ${className}`}>
			<div draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} className="flex items-center justify-between px-2 pb-1">
				<h2 className="min-w-0 truncate text-xs font-medium text-neutral-500">
					{section ? (
						<button type="button" onClick={section.onToggle} aria-expanded={!section.collapsed} className="flex max-w-full items-center gap-0.5 hover:text-neutral-900">
							<span className="truncate">{title}</span>
							<CaretRightIcon className={`shrink-0 ${section.collapsed ? "" : "rotate-90 opacity-0 group-hover/section:opacity-100"}`} />
						</button>
					) : (
						title
					)}
				</h2>
				{add && <span className="flex opacity-0 group-hover/section:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100">{add}</span>}
			</div>
			{children}
		</section>
	);
}

/** A section header's +. */
export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} title={label} aria-label={label} className={trailingAction}>
			<PlusIcon />
		</button>
	);
}

/** A row's or section header's trailing control: same size and right edge everywhere; a pill on hover and while its menu is open. */
export const trailingAction =
	"flex size-5 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200/80 hover:text-neutral-900 aria-expanded:bg-neutral-200/80 aria-expanded:text-neutral-900";

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
	title,
	guides = [],
	expanded,
	onToggle,
	menu,
	actions,
	rename,
	drag,
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
	onClick: () => void;
	children: React.ReactNode;
}) {
	const [menuAt, setMenuAt] = useState<DOMRect>();
	const [renaming, setRenaming] = useState(false);
	const more = useRef<HTMLButtonElement>(null);
	const closeMenu = () => setMenuAt(undefined);
	const items =
		menu || rename
			? (close: () => void) => (
					<>
						{rename && <MenuItem onClick={() => (close(), setRenaming(true))}><EditIcon /> Rename</MenuItem>}
						{menu?.(close)}
					</>
				)
			: undefined;
	return (
		<div
			{...drag}
			// While renaming, a drag would take the text selection, and right-click is the input's own.
			draggable={renaming ? false : drag?.draggable}
			onContextMenu={items && !renaming ? (e) => (e.preventDefault(), setMenuAt(new DOMRect(e.clientX, e.clientY, 0, 0))) : undefined}
			className={`group/item relative flex items-stretch text-sm ${drag?.className ?? ""}`}
		>
			{/* Tree guides sit in a gutter before the pill, so hover and active backgrounds never paint over them. */}
			{guides.map((continues, level) => (
				<Guide key={level} continues={continues} elbow={level === guides.length - 1} />
			))}
			<div className={`relative flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 ${itemTone({ active, unread, muted, open: !!menuAt })}`}>
			{icon && (
				<span className="flex size-[22px] shrink-0 items-center justify-center text-lg text-neutral-500">
					{onToggle ? (
						<>
							<span className="contents group-hover/item:hidden">{icon}</span>
							<button
								type="button"
								aria-label={`${expanded ? "Collapse" : "Expand"} ${label ?? ""}`.trim()}
								aria-expanded={expanded}
								onClick={onToggle}
								className="relative z-10 hidden size-5 items-center justify-center text-neutral-400 hover:text-neutral-800 group-hover/item:flex"
							>
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
					type="button"
					title={title}
					onClick={onClick}
					onDoubleClick={rename && (() => setRenaming(true))}
					onKeyDown={rename && ((e) => e.key === "F2" && (e.preventDefault(), setRenaming(true)))}
					className="flex min-w-0 flex-1 items-center gap-2 text-left after:absolute after:inset-0 after:rounded-lg"
				>
					{/* A plain label ellipsizes like the others; richer children truncate their own text. */}
					{typeof children === "string" ? <span className="truncate">{children}</span> : children}
					{draft && !active && <span className="ml-auto shrink-0 text-[10px] font-normal text-neutral-400">Draft</span>}
					{mentioned && !active && (
						<span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-medium text-white">
							@
						</span>
					)}
				</button>
			)}
			{(items || actions) && !renaming && (
				<span className={`relative z-10 items-center gap-0.5 ${menuAt ? "flex" : "hidden group-focus-within/item:flex group-hover/item:flex has-[[aria-expanded=true]]:flex"}`}>
					{items && (
						<button
							ref={more}
							type="button"
							title="More"
							aria-label={label ? `Actions for ${label}` : "Actions"}
							aria-expanded={!!menuAt}
							onClick={(e) => (menuAt ? closeMenu() : setMenuAt(e.currentTarget.getBoundingClientRect()))}
							className={trailingAction}
						>
							<MoreIcon weight="bold" />
						</button>
					)}
					{actions}
				</span>
			)}
			{items && menuAt && (
				<PopoverPanel anchor={menuAt} ignore={more} className="w-52 p-1" onClose={closeMenu}>
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
function Guide({ continues, elbow }: { continues: boolean; elbow: boolean }) {
	return (
		<span aria-hidden className="relative w-7 shrink-0">
			{continues && <span className="absolute -top-px bottom-0 left-[18.25px] w-[1.5px] bg-neutral-300" />}
			{elbow && <span className="absolute -top-px left-[18.25px] h-[calc(50%+1px)] w-2 rounded-bl-lg border-neutral-300 border-b-[1.5px] border-l-[1.5px]" />}
		</span>
	);
}

/** The pill's colors. Hover paints it when the pointer is anywhere on the row, gutter included. */
function itemTone({ active, unread, muted, open }: { active?: boolean; unread?: boolean; muted?: boolean; open?: boolean }) {
	if (active) return "bg-neutral-200/70 font-medium text-neutral-900";
	const hover = open ? "bg-neutral-100" : "group-hover/item:bg-neutral-100";
	if (unread) return `font-semibold text-neutral-900 ${hover}`;
	if (muted) return `text-neutral-400 group-hover/item:text-neutral-700 ${hover}`;
	return `text-neutral-600 ${hover}`;
}
