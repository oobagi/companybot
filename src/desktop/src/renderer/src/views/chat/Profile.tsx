import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { Notice, compactButton, useRun } from "../../ui";
import { AgentBadge, Avatar, Popover, clock, zoneLabel } from "./common";
import type { Participant } from "./data";
import { roleNames } from "../Members";
import { ChatIcon } from "../../icons";


/**
 * Wraps a name or avatar: click it for their profile card. An agent that sent as a person
 * (`who.for`) has a "Sent for" line that turns the card into that person's.
 */
export function ProfileLink({ who, children, className = "" }: { who: Participant; children: React.ReactNode; className?: string }) {
	return (
		<Popover trigger={children} className={`cursor-pointer ${className}`}>
			{(close) => <ProfileCards who={who} onClose={close} />}
		</Popover>
	);
}

function ProfileCards({ who, onClose }: { who: Participant; onClose: () => void }) {
	const [shown, setShown] = useState(who);
	return <ProfileCard key={`${shown.type}:${shown.id}`} who={shown} onClose={onClose} onFor={shown.for && (() => setShown(shown.for!))} />;
}

/** Name, email, role, and local time for people; description for agents. "Message" opens your DM. */
function ProfileCard({ who, onClose, onFor }: { who: Participant; onClose: () => void; onFor?: () => void }) {
	const team = useQuery(api.workspace.team);
	const roles = useQuery(api.roles.list);
	const chats = useQuery(api.chats.list);
	const openDm = useMutation(api.chats.openDm);
	const { error, run } = useRun();
	const person = who.type === "user" ? team?.members.find((m) => m.userId === who.id) : undefined;
	const agent = who.type === "agent" ? chats?.agents.find((a) => a._id === who.id) : undefined;
	const gone = who.type === "user" ? team && !person : chats && !agent;
	const dm = who.type === "user" ? { userIds: [who.id], agentIds: [] } : { userIds: [], agentIds: [who.id] };
	const message = () => run(openDm(dm).then((id) => (onClose(), navigate("chat", id))));

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-3">
				<Avatar name={who.name} image={who.image} agent={who.type === "agent"} />
				<div className="min-w-0">
					<p className="flex items-center gap-2 truncate font-semibold">
						{who.name}
						{who.type === "agent" && <AgentBadge />}
					</p>
					{person && person.name !== person.email && <p className="truncate text-neutral-500">{person.email}</p>}
				</div>
			</div>
			{person && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					<dt className="text-neutral-500">Roles</dt>
					<dd>{roleNames(roles, person.roles).join(", ") || "No role"}</dd>
					<dt className="text-neutral-500">Local time</dt>
					<dd>
						{clock(Date.now(), person.timeZone)} <span className="text-neutral-500">· {zoneLabel(person.timeZone)}</span>
					</dd>
				</dl>
			)}
			{agent?.description && <p className="text-neutral-600">{agent.description}</p>}
			{who.for && onFor && (
				<p className="text-neutral-600">
					Sent for{" "}
					<button type="button" onClick={onFor} className="inline-flex items-center gap-1.5 align-middle hover:underline">
						<Avatar name={who.for.name} image={who.for.image} size="xs" /> {who.for.name}
					</button>
				</p>
			)}
			{gone && <p className="text-neutral-500">No longer in this workspace.</p>}
			<Notice>{error}</Notice>
			{!gone && !person?.isYou && (
				<div className="flex">
					<button type="button" onClick={message} className={compactButton}>
						<ChatIcon /> Message
					</button>
				</div>
			)}
		</div>
	);
}
