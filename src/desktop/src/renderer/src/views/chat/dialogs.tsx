import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Field, Form, Loading, Notice, descriptionClass, inputClass, primaryButton, secondaryButton, useRun, useSynced } from "../../ui";
import { AgentBadge, Avatar, Modal } from "./common";
import { navigate } from "../../router";
import { ProfileLink } from "./Profile";
import { type ChatDetails, type Participant, chatTitle, useDirectory } from "./data";

export function CreateChannel({ onClose, onOpen }: { onClose: () => void; onOpen: (chatId: Id<"chats">) => void }) {
	const create = useMutation(api.chats.createChannel);
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [isPrivate, setPrivate] = useState(false);
	const { error, run } = useRun();
	return (
		<Modal title="Create a channel" onClose={onClose}>
			<Form onSubmit={() => run(create({ name, topic: topic.trim() || undefined, private: isPrivate }).then((id) => (onOpen(id), onClose())))}>
				<Field label="Name">
					<input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. sales" className={inputClass} />
				</Field>
				<Field label="Topic" hint="Optional. What's this channel about?">
					<input value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass} />
				</Field>
				<label className="flex items-start gap-2 text-sm">
					<input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="mt-0.5" />
					<span>
						<span className="font-medium">Private</span>
						<span className="block text-neutral-500">Only people added can see it.</span>
					</span>
				</label>
				<Notice>{error}</Notice>
				<button type="submit" disabled={!name.trim()} className={`${primaryButton} self-end`}>
					Create
				</button>
			</Form>
		</Modal>
	);
}

export function BrowseChannels({ onClose, onOpen }: { onClose: () => void; onOpen: (chatId: Id<"chats">) => void }) {
	const channels = useQuery(api.chats.browse, { withCounts: true });
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
								className={secondaryButton}
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
			<input value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} placeholder="Search" className={inputClass} />
			<ul className="-mx-2 flex max-h-72 flex-col overflow-y-auto">
				{shown.map((o) => (
					<li key={o.id}>
						<label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-neutral-50">
							<input
								type="checkbox"
								checked={picked.includes(o.id)}
								onChange={(e) => onChange(e.target.checked ? [...picked, o.id] : picked.filter((id) => id !== o.id))}
							/>
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
 * If you already have that conversation, it opens it rather than starting another.
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
	const existing = chats?.dms.find((d) => sameAs(d.members.filter((m) => m.id !== chats.me).map((m) => m.id)));
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
			<div className="flex items-center justify-end gap-3">
				{existing && <p className="flex-1 text-sm text-neutral-500">You already have this conversation.</p>}
				<button type="button" disabled={picked.length === 0} onClick={() => void open()} className={primaryButton}>
					{existing ? "Go to conversation" : "Start conversation"}
				</button>
			</div>
		</Modal>
	);
}

export function ChannelDetails({ chat, onClose, onLeft }: { chat: ChatDetails; onClose: () => void; onLeft: () => void }) {
	const [adding, setAdding] = useState(false);
	const isChannel = chat.kind === "channel";
	const me = useQuery(api.workspace.me);
	const removeMember = useMutation(api.chats.removeMember);
	const { error, run } = useRun();
	// Managers remove others (you leave instead); everyone stays in the default channel. The server checks the same.
	const removable = (m: Participant) => isChannel && chat.canManage && m.id !== me?.userId && !(chat.isDefault && m.type === "user");
	return (
		<Modal title={chatTitle(chat)} onClose={onClose}>
			{adding ? (
				<AddMembers chat={chat} onDone={() => setAdding(false)} />
			) : (
				<>
					{isChannel && chat.canManage && <EditChannel chat={chat} />}
					{isChannel && !chat.canManage && chat.topic && <p className="text-sm text-neutral-600">{chat.topic}</p>}
					<section className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">{chat.members.length} members</h3>
							{isChannel && (
								<button type="button" onClick={() => setAdding(true)} className="text-sm text-neutral-500 hover:text-neutral-900">
									Add people or agents
								</button>
							)}
						</div>
						<ul className="flex flex-col gap-1">
							{chat.members.map((m) => (
								<li key={`${m.type}:${m.id}`} className="flex items-center gap-3 py-1">
									<Avatar name={m.name} image={m.image} agent={m.type === "agent"} size="sm" />
									<span className="flex-1 truncate text-sm">
										<ProfileLink who={m} className="hover:underline">{m.name}</ProfileLink>
									</span>
									{m.type === "agent" && <AgentBadge />}
									{removable(m) && (
										<button
											type="button"
											onClick={() =>
												confirm(`Remove ${m.name} from #${chat.name}?`) &&
												run(removeMember({ chatId: chat._id, ...(m.type === "user" ? { userId: m.id as Id<"users"> } : { agentId: m.id as Id<"agents"> }) }))
											}
											className="text-xs text-neutral-400 hover:text-red-700"
										>
											Remove from channel
										</button>
									)}
								</li>
							))}
						</ul>
						<Notice>{error}</Notice>
					</section>
					{isChannel && !chat.isDefault && <LeaveButton chat={chat} onLeft={() => (onClose(), onLeft())} />}
				</>
			)}
		</Modal>
	);
}

function EditChannel({ chat }: { chat: ChatDetails }) {
	const update = useMutation(api.chats.updateChannel);
	// Live: a teammate's rename shows here instead of being overwritten by a stale draft.
	const [name, setName] = useSynced(chat.name ?? "");
	const [topic, setTopic] = useSynced(chat.topic ?? "");
	const { error, run } = useRun();
	const dirty = name !== (chat.name ?? "") || topic !== (chat.topic ?? "");
	return (
		<Form className="flex flex-col gap-3" onSubmit={() => run(update({ chatId: chat._id, name: chat.isDefault ? undefined : name, topic }))}>
			<Field label="Name" hint={chat.isDefault ? "The default channel can't be renamed." : undefined}>
				<input value={name} disabled={!!chat.isDefault} onChange={(e) => setName(e.target.value)} className={inputClass} />
			</Field>
			<Field label="Topic">
				<input value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass} />
			</Field>
			<Notice>{error}</Notice>
			{dirty && (
				<button type="submit" className={`${primaryButton} self-end`}>
					Save
				</button>
			)}
		</Form>
	);
}

function AddMembers({ chat, onDone }: { chat: ChatDetails; onDone: () => void }) {
	const addMembers = useMutation(api.chats.addMembers);
	const { people, agents } = useDirectory();
	const inChat = new Set(chat.members.map((m) => `${m.type}:${m.id}`));
	const options = [...people, ...agents].filter((p) => !inChat.has(`${p.type}:${p.id}`));
	const [picked, setPicked] = useState<string[]>([]);
	const { error, run } = useRun();
	const of = (type: Participant["type"]) => options.filter((o) => o.type === type && picked.includes(o.id)).map((o) => o.id);
	return (
		<>
			{options.length === 0 ? (
				<p className={descriptionClass}>Everyone's already here.</p>
			) : (
				<Picker options={options} picked={picked} onChange={setPicked} />
			)}
			<Notice>{error}</Notice>
			<div className="flex justify-end gap-2">
				<button type="button" onClick={onDone} className={secondaryButton}>
					Back
				</button>
				<button
					type="button"
					disabled={picked.length === 0}
					onClick={() =>
						run(
							addMembers({ chatId: chat._id, userIds: of("user") as Id<"users">[], agentIds: of("agent") as Id<"agents">[] }),
							onDone,
						)
					}
					className={primaryButton}
				>
					Add
				</button>
			</div>
		</>
	);
}

/** Leave, and for its managers, delete (to Trash). */
function LeaveButton({ chat, onLeft }: { chat: ChatDetails; onLeft: () => void }) {
	const leave = useMutation(api.chats.leave);
	const remove = useMutation(api.trash.move);
	const { error, run } = useRun();
	return (
		<>
			<Notice>{error}</Notice>
			<div className="flex gap-4 text-sm">
				<button type="button" onClick={() => run(leave({ chatId: chat._id }), onLeft)} className="text-red-600 hover:text-red-800">
					Leave channel
				</button>
				{chat.canManage && !chat.trash && (
					<button
						type="button"
						onClick={() => confirm(`Delete #${chat.name}? It goes to Trash with its messages, and can be restored for 30 days.`) && run(remove({ kind: "channel", id: chat._id }), onLeft)}
						className="text-red-600 hover:text-red-800"
					>
						Delete channel
					</button>
				)}
			</div>
		</>
	);
}
