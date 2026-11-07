import { TOPIC_MAX } from "@companybot/core/chat";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { type ReplyMode, replyModeLabels, replyModes } from "@companybot/core/router";
import { Checkbox, Select } from "../../controls";
import { useMutation, useQuery } from "../../convex";
import { Form, Loading, Notice, Section, Setting, Settings, actionButton, compactButton, compactControlClass, compactPrimaryButton, descriptionClass, iconDangerButton, listClass, primaryButton, secondaryButton, useRun, wideControlClass } from "../../ui";
import { ArchiveIcon, PlusIcon, SignOutIcon, UserMinusIcon } from "../../icons";
import { AgentBadge, Avatar, DialogButtons, MenuItem, Modal, archiveQuestion, useConfirm } from "./common";
import { navigate } from "../../router";
import { ProfileLink } from "./Profile";
import { type ChatDetails, type Participant, chatTitle, useDirectory } from "./data";
import { WhoCanAccess } from "../access";

export function CreateChannel({ onClose, onOpen }: { onClose: () => void; onOpen: (chatId: Id<"chats">) => void }) {
	const create = useMutation(api.chats.createChannel);
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const { error, run } = useRun();
	return (
		<Modal title="New channel" onClose={onClose}>
			<Form onSubmit={() => run(create({ name, topic: topic.trim() || undefined, private: isPrivate }).then((id) => (onOpen(id), onClose())))}>
				<Settings>
					<Setting label="Name">
						<input aria-label="Name" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. sales" className={wideControlClass} />
					</Setting>
					<Setting label="Topic" hint="Optional. What's this channel about?">
						<input aria-label="Topic" value={topic} maxLength={TOPIC_MAX} onChange={(e) => setTopic(e.target.value)} placeholder="What's it about?" className={wideControlClass} />
					</Setting>
					<Setting label="Private" hint="Only people added can see it.">
						<Checkbox checked={isPrivate} onChange={setPrivate} label="Private" />
					</Setting>
				</Settings>
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

export function BrowseChannels({ onClose, onOpen }: { onClose: () => void; onOpen: (chatId: Id<"chats">) => void }) {
	const channels = useQuery(api.chats.browse);
	const join = useMutation(api.chats.join);
	const { error, run } = useRun();
	return (
		<Modal title="Browse channels" onClose={onClose}>
			<Notice>{error}</Notice>
			{!channels ? (
				<Loading />
			) : channels.length === 0 ? (
				<p className={descriptionClass}>You're in every public channel.</p>
			) : (
				<ul className="-mx-2 flex flex-col">
					{channels.map((c) => (
						<li key={c._id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-neutral-50">
							<div className="min-w-0 flex-1">
								<p className="font-medium">#{c.name}</p>
								<p className="truncate text-sm text-neutral-500">
									{c.memberCount} {c.memberCount === 1 ? "member" : "members"}
									{c.topic && ` · ${c.topic}`}
								</p>
							</div>
							<button
								type="button"
								onClick={() => run(join({ chatId: c._id }), () => (onOpen(c._id), onClose()))}
								className={actionButton}
							>
								Join
							</button>
						</li>
					))}
				</ul>
			)}
		</Modal>
	);
}

/** Pick from a list of people or agents. */
function Picker({ options, picked, onChange }: { options: Participant[]; picked: string[]; onChange: (ids: string[]) => void }) {
	const [filter, setFilter] = useState("");
	const shown = options.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase()));
	return (
		<div className="flex flex-col gap-2">
			<input value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} placeholder="Search" aria-label="Search" className={`${compactControlClass} w-full`} />
			<ul className="-mx-2 flex max-h-72 flex-col overflow-y-auto">
				{shown.map((o) => (
					<li key={o.id}>
						<label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-neutral-50">
							<Checkbox checked={picked.includes(o.id)} onChange={(on) => onChange(on ? [...picked, o.id] : picked.filter((id) => id !== o.id))} />
							<Avatar name={o.name} image={o.image} agent={o.type === "agent"} size="sm" />
							<span className="flex-1 truncate text-sm">{o.name}</span>
							{o.type === "agent" && <AgentBadge />}
						</label>
					</li>
				))}
				{shown.length === 0 && <li className="px-2 py-1.5 text-sm text-neutral-400">Nobody found.</li>}
			</ul>
		</div>
	);
}

/**
 * A DM with one or more people, and agents if you like (they answer when @mentioned).
 * If you already have that conversation, it just opens it, as Slack and Discord do.
 */
export function NewMessage({ onClose, onOpen }: { onClose: () => void; onOpen: (chatId: Id<"chats">) => void }) {
	const openDm = useMutation(api.chats.openDm);
	const chats = useQuery(api.chats.list);
	const { people, agents } = useDirectory();
	const [picked, setPicked] = useState<string[]>([]);
	const { error, run } = useRun();
	const of = (list: Participant[]) => list.filter((p) => picked.includes(p.id)).map((p) => p.id);
	// The DM whose other members are exactly who's picked.
	const sameAs = (ids: string[]) => ids.length === picked.length && ids.every((id) => picked.includes(id));
	const existing = chats?.dms.find((d) => !d.parentId && sameAs(d.members.filter((m) => m.id !== chats.me).map((m) => m.id)));
	const open = () =>
		existing
			? (onOpen(existing._id), onClose())
			: run(openDm({ userIds: of(people) as Id<"users">[], agentIds: of(agents) as Id<"agents">[] }).then((id) => (onOpen(id), onClose())));
	return (
		<Modal title="New message" onClose={onClose}>
			{people.length === 0 && (
				<p className={descriptionClass}>
					Invite teammates in{" "}
					<button type="button" onClick={() => (onClose(), navigate("settings", "members"))} className="underline hover:text-neutral-900">
						Settings → Members
					</button>{" "}
					to message them.
				</p>
			)}
			<Picker options={[...people, ...agents]} picked={picked} onChange={setPicked} />
			<Notice>{error}</Notice>
			<DialogButtons>
				<button type="button" onClick={onClose} className={secondaryButton}>
					Cancel
				</button>
				<button type="button" disabled={picked.length === 0} onClick={() => void open()} className={primaryButton}>
					Message
				</button>
			</DialogButtons>
		</Modal>
	);
}

/** `ChannelDetails` for a chat the sidebar knows only by id. */
export function ChannelDetailsFor({ chatId, onClose, onLeft }: { chatId: Id<"chats">; onClose: () => void; onLeft: () => void }) {
	const chat = useQuery(api.chats.get, { chatId });
	return chat ? <ChannelDetails chat={chat} onClose={onClose} onLeft={onLeft} /> : null;
}

export function ChannelDetails({ chat, onClose, onLeft }: { chat: ChatDetails; onClose: () => void; onLeft: () => void }) {
	const [adding, setAdding] = useState(false);
	const isChannel = chat.kind === "channel";
	const me = useQuery(api.workspace.me);
	const removeMember = useMutation(api.chats.removeMember);
	const leave = useMutation(api.chats.leave);
	const archive = useMutation(api.trash.move);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const left = () => (onClose(), onLeft());
	// Managers remove others (you leave instead); everyone stays in the default channel. The server checks the same.
	const removable = (m: Participant) => isChannel && chat.canManage && m.id !== me?.userId && !(chat.isDefault && m.type === "user");
	const people = chat.members.filter((m) => m.type === "user").length;
	const agents = chat.members.length - people;
	const count = [people && `${people} ${people === 1 ? "person" : "people"}`, agents && `${agents} ${agents === 1 ? "agent" : "agents"}`].filter(Boolean).join(", ");
	return (
		<Modal
			title={chatTitle(chat)}
			size={isChannel ? "lg" : "md"}
			onClose={onClose}
			menu={
				isChannel && !chat.isDefault
					? (close) => (
							<>
								{chat.canManage && !chat.trash && (
									<MenuItem onClick={() => (close(), confirm(archiveQuestion(`#${chat.name}`, () => archive({ kind: "channel", id: chat._id }).then(left), "The channel will close to new messages. Its messages and files are kept.")))}>
										<ArchiveIcon /> Archive channel
									</MenuItem>
								)}
								<MenuItem danger onClick={() => (close(), run(leave({ chatId: chat._id }), left))}>
									<SignOutIcon /> Leave channel
								</MenuItem>
							</>
						)
					: undefined
			}
		>
			{dialog}
			<Notice>{error}</Notice>
			{isChannel && (chat.canManage ? <EditChannel chat={chat} /> : <AboutChannel chat={chat} />)}
			{isChannel && chat.access && <ChannelAccess chat={chat} access={chat.access} />}
			<Section
				title={count ? `Members · ${count}` : "Members"}
				action={
					isChannel && (
						<button type="button" onClick={() => setAdding(true)} className={compactButton}>
							<PlusIcon /> Add
						</button>
					)
				}
			>
				<ul className={listClass}>
					{chat.members.map((m) => (
						<li key={`${m.type}:${m.id}`} className="flex min-h-12 items-center gap-3 px-4 py-2">
							<Avatar name={m.name} image={m.image} agent={m.type === "agent"} size="sm" />
							<span className="flex-1 truncate text-sm">
								<ProfileLink who={m} className="hover:underline">{m.name}</ProfileLink>
							</span>
							{m.type === "agent" && <AgentBadge />}
							{removable(m) && (
								<button
									type="button"
									onClick={() =>
										confirm({
											title: `Remove ${m.name} from #${chat.name}?`,
											action: "Remove",
											onConfirm: () => removeMember({ chatId: chat._id, ...(m.type === "user" ? { userId: m.id as Id<"users"> } : { agentId: m.id as Id<"agents"> }) }),
										})
									}
									aria-label={`Remove ${m.name} from the channel`}
									title="Remove from channel"
									className={iconDangerButton}
								>
									<UserMinusIcon size={16} />
								</button>
							)}
						</li>
					))}
				</ul>
			</Section>
			{adding && <AddMembers chat={chat} onClose={() => setAdding(false)} />}
		</Modal>
	);
}

/** Who can see and post in a channel. People who manage it change it; everyone sees who's on it. */
function ChannelAccess({ chat, access }: { chat: ChatDetails; access: NonNullable<ChatDetails["access"]> }) {
	const setAccess = useMutation(api.chats.setAccess);
	return <WhoCanAccess kind="channel" access={access} onSave={chat.canManage ? (next) => setAccess({ chatId: chat._id, access: next }) : undefined} />;
}

const replyHints: Record<ReplyMode, string> = {
	mentions: "Agents here answer only when @mentioned.",
	relevant: "Agents here also answer, or react, when a message looks meant for them.",
};

/** The channel's settings, for people who can't change them. */
function AboutChannel({ chat }: { chat: ChatDetails }) {
	return (
		<Settings title="Channel">
			{chat.topic && <Setting label="Topic" hint={chat.topic}>{null}</Setting>}
			<Setting label="Agents reply" hint={replyHints[chat.replyMode]}>
				<span className="text-neutral-500">{replyModeLabels[chat.replyMode]}</span>
			</Setting>
		</Settings>
	);
}

/** Name, topic and how agents reply: they save together, with Save under them. */
function EditChannel({ chat }: { chat: ChatDetails }) {
	const update = useMutation(api.chats.updateChannel);
	const saved = { name: chat.name ?? "", topic: chat.topic ?? "", replyMode: chat.replyMode };
	const [value, setValue] = useState(saved);
	const { error, busy, run } = useRun();
	const dirty = value.name !== saved.name || value.topic !== saved.topic || value.replyMode !== saved.replyMode;
	return (
		<Form className="flex flex-col gap-3" onSubmit={() => run(update({ chatId: chat._id, ...value }))}>
			<Settings title="Channel">
				<Setting label="Name">
					<input aria-label="Name" value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} className={wideControlClass} />
				</Setting>
				<Setting label="Topic">
					<input aria-label="Topic" value={value.topic} maxLength={TOPIC_MAX} placeholder="What's it about?" onChange={(e) => setValue({ ...value, topic: e.target.value })} className={wideControlClass} />
				</Setting>
				<Setting label="Agents reply" hint={replyHints[value.replyMode]}>
					<Select label="Agents reply" className={wideControlClass} value={value.replyMode} options={replyModes.map((m) => ({ value: m, label: replyModeLabels[m] }))} onChange={(replyMode) => setValue({ ...value, replyMode })} />
				</Setting>
			</Settings>
			<Notice>{error}</Notice>
			{dirty && (
				<DialogButtons>
					<button type="button" onClick={() => setValue(saved)} className={compactButton}>
						Discard
					</button>
					<button type="submit" disabled={busy || !value.name.trim()} className={compactPrimaryButton}>
						Save
					</button>
				</DialogButtons>
			)}
		</Form>
	);
}

function AddMembers({ chat, onClose }: { chat: ChatDetails; onClose: () => void }) {
	const addMembers = useMutation(api.chats.addMembers);
	const { people, agents } = useDirectory();
	const inChat = new Set(chat.members.map((m) => `${m.type}:${m.id}`));
	const options = [...people, ...agents].filter((p) => !inChat.has(`${p.type}:${p.id}`));
	const [picked, setPicked] = useState<string[]>([]);
	const { error, busy, run } = useRun();
	const of = (type: Participant["type"]) => options.filter((o) => o.type === type && picked.includes(o.id)).map((o) => o.id);
	return (
		<Modal title={`Add to #${chat.name}`} onClose={onClose}>
			{options.length === 0 ? <p className={descriptionClass}>Everyone's already here.</p> : <Picker options={options} picked={picked} onChange={setPicked} />}
			<Notice>{error}</Notice>
			<DialogButtons>
				<button type="button" onClick={onClose} className={secondaryButton}>
					Cancel
				</button>
				<button
					type="button"
					disabled={busy || picked.length === 0}
					onClick={() => run(addMembers({ chatId: chat._id, userIds: of("user") as Id<"users">[], agentIds: of("agent") as Id<"agents">[] }), onClose)}
					className={primaryButton}
				>
					Add
				</button>
			</DialogButtons>
		</Modal>
	);
}
