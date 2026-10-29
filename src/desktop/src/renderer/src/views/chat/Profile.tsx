import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { Facts, Notice, secondaryButton, useRun } from "../../ui";
import { AgentBadge, Avatar, Popover, clock, zoneLabel } from "./common";
import type { Participant } from "./data";


/** Wraps a name or avatar: click it for their profile card. */
export function ProfileLink({ who, children, className = "" }: { who: Participant; children: React.ReactNode; className?: string }) {
	return (
		<Popover trigger={children} className={`cursor-pointer ${className}`}>
			{(close) => <ProfileCard who={who} onClose={close} />}
		</Popover>
	);
}

/** Name, email, role, and local time for people; description for agents. "Message" opens your DM. */
function ProfileCard({ who, onClose }: { who: Participant; onClose: () => void }) {
	const team = useQuery(api.workspace.team);
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
				<Facts
					className="gap-x-3 gap-y-1"
					rows={[
						["Role", <span className="capitalize">{person.role}</span>],
						["Local time", <>{clock(Date.now(), person.timeZone)} <span className="text-neutral-500">· {zoneLabel(person.timeZone)}</span></>],
					]}
				/>
			)}
			{agent?.description && <p className="text-neutral-600">{agent.description}</p>}
			{gone && <p className="text-neutral-500">No longer in this workspace.</p>}
			<Notice>{error}</Notice>
			{!gone && !person?.isYou && (
				<button type="button" onClick={message} className={`${secondaryButton} self-start`}>
					Message
				</button>
			)}
		</div>
	);
}
