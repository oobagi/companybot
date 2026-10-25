import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../../api";
import { navigate } from "../../router";
import { Notice, secondaryButton, useRun } from "../../ui";
import { AgentBadge, Avatar, useDismiss } from "./common";
import type { Participant } from "./data";

/** Their local time, e.g. "9:41 AM". */
const localTime = (timeZone: string) => new Date().toLocaleTimeString([], { timeZone, hour: "numeric", minute: "2-digit" });
const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

const CARD_HEIGHT = 240;

/** Wraps a name or avatar: click it for their profile card. */
export function ProfileLink({ who, children, className = "" }: { who: Participant; children: React.ReactNode; className?: string }) {
	const [at, setAt] = useState<React.CSSProperties>();
	const ref = useDismiss<HTMLSpanElement>(() => setAt(undefined), !!at);
	// Fixed, so scrolling lists don't clip it; opens upward when there's no room below.
	const toggle = (e: React.MouseEvent) => {
		if (at) return setAt(undefined);
		const r = e.currentTarget.getBoundingClientRect();
		setAt(r.bottom + CARD_HEIGHT > window.innerHeight ? { left: r.left, bottom: window.innerHeight - r.top + 4 } : { left: r.left, top: r.bottom + 4 });
	};
	return (
		<span ref={ref}>
			<button type="button" onClick={toggle} className={`cursor-pointer ${className}`}>
				{children}
			</button>
			{at && <ProfileCard who={who} style={at} onClose={() => setAt(undefined)} />}
		</span>
	);
}

/** Name, email, role, and local time for people; description for agents. "Message" opens your DM. */
function ProfileCard({ who, style, onClose }: { who: Participant; style: React.CSSProperties; onClose: () => void }) {
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
		<div style={style} className="fixed z-50 flex w-72 flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 text-left text-sm font-normal shadow-lg">
			<div className="flex items-center gap-3">
				<Avatar name={who.name} agent={who.type === "agent"} />
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
					<dt className="text-neutral-500">Role</dt>
					<dd className="capitalize">{person.role}</dd>
					<dt className="text-neutral-500">Local time</dt>
					<dd>
						{localTime(person.timeZone)} <span className="text-neutral-500">· {zoneLabel(person.timeZone)}</span>
					</dd>
				</dl>
			)}
			{agent?.description && <p className="text-neutral-600">{agent.description}</p>}
			{gone && <p className="text-neutral-500">No longer in this workspace.</p>}
			{error && <Notice>{error}</Notice>}
			{!gone && !person?.isYou && (
				<button type="button" onClick={message} className={`${secondaryButton} self-start`}>
					Message
				</button>
			)}
		</div>
	);
}
