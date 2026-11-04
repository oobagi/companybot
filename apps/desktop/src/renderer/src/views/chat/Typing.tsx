import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { TYPING_MS, TYPING_PING_MS } from "@companybot/core/typing";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { Avatar, AvatarStack, MenuItem, PopoverPanel } from "./common";

/**
 * An agent working here, and its step ("Searching records for Acme…"; null while it writes). `canStop`:
 * you may stop it (the person it works for, or anyone with `turns.stopAny`); `stopping`: someone did, and it's ending.
 */
type Working = { id: string; name: string; image?: string | null; step: string | null; turnId: Id<"agentTurns">; canStop: boolean; stopping: boolean };

/** Tells others you're typing: call `ping` on each keystroke (it throttles itself) and `sent` on send. */
export function useTypingPing(chatId: Id<"chats">, threadId?: Id<"chatMessages">) {
	const send = useMutation(api.typing.ping);
	const last = useRef(0);
	const ping = useCallback(() => {
		if (Date.now() - last.current < TYPING_PING_MS) return;
		last.current = Date.now();
		send({ chatId, threadId }).catch(() => {});
	}, [send, chatId, threadId]);
	// Sending ends typing on the server; let the next keystroke ping again at once.
	const sent = useCallback(() => void (last.current = 0), []);
	return { ping, sent };
}

/**
 * "Companybot: Searching records for Acme… · Ada is typing…". Its own component, so its timer
 * re-renders only this line. Pings expire by when this app saw them, not the server's clock, so a
 * computer whose clock is off still shows the right people. Agents' steps come from their turns
 * (backend typing.list), so a run that posts nothing still shows here.
 */
export function TypingLine({ chatId, threadId }: { chatId: Id<"chats">; threadId?: Id<"chatMessages"> }) {
	const typing = useQuery(api.typing.list, { chatId, threadId });
	const seen = useRef(new Map<string, { at: number; seen: number }>());
	const [, tick] = useReducer((n: number) => n + 1, 0);

	const now = Date.now();
	for (const p of typing?.people ?? []) {
		if (seen.current.get(p.id)?.at !== p.at) seen.current.set(p.id, { at: p.at, seen: now });
	}
	const people = (typing?.people ?? []).filter((p) => now - seen.current.get(p.id)!.seen < TYPING_MS);

	// Re-render when the next shown ping runs out.
	const next = Math.min(...people.map((p) => seen.current.get(p.id)!.seen + TYPING_MS));
	useEffect(() => {
		if (!Number.isFinite(next)) return;
		const timer = setTimeout(tick, next - Date.now());
		return () => clearTimeout(timer);
	}, [next]);

	const agents = typing?.agents ?? [];
	const line = statusLine(agents, people.map((p) => p.name));
	if (!line.working && !line.typing) return null;
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			{agents.length > 0 && <AvatarStack people={agents.map((a) => ({ ...a, type: "agent" }))} size="line" />}
			<span className="min-w-0 truncate">
				{line.working && (agents.length > 1 ? <WorkingList agents={agents} label={line.working} /> : line.working)}
				{line.working && line.typing && " · "}
				{line.typing}
			</span>
			{agents.length === 1 && <StopButton agent={agents[0]!} />}
		</span>
	);
}

/**
 * Ends an agent's reply early (turns.stop). A control, never a word in the chat: a message saying
 * "stop" is just a message. The agent finishes a tool call it's running, then stops; what it wrote stays.
 */
function StopButton({ agent }: { agent: Working }) {
	const stop = useMutation(api.turns.stop);
	if (!agent.canStop) return null;
	return (
		<button
			type="button"
			disabled={agent.stopping}
			onClick={() => stop({ turnId: agent.turnId }).catch(() => {})}
			title={`Stop ${agent.name}`}
			className="shrink-0 rounded px-1.5 font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-60 disabled:hover:bg-transparent"
		>
			{agent.stopping ? "Stopping…" : "Stop"}
		</button>
	);
}

/**
 * The line's two halves. One agent shows its step ("Companybot: Searching records for Acme…"),
 * or types like a person while it writes; several are "2 agents working", each listed on hover.
 */
export function statusLine(agents: Pick<Working, "name" | "step">[], people: string[]): { working?: string; typing?: string } {
	const [only] = agents;
	if (agents.length > 1) return { working: `${agents.length} agents working`, typing: typingLine(people) };
	if (only?.step) return { working: `${only.name}: ${only.step}`, typing: typingLine(people) };
	return { typing: typingLine([...agents.map((a) => a.name), ...people]) };
}

function typingLine(names: string[]) {
	if (names.length === 0) return undefined;
	if (names.length === 1) return `${names[0]} is typing…`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
	if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
	return "Several people are typing…";
}

/** "2 agents working": hover (or click) lists each one's step, with a way to their activity. */
function WorkingList({ agents, label }: { agents: Working[]; label: string }) {
	const [opened, setOpened] = useState(false);
	// Closes a moment after the mouse leaves, so it can cross the gap to the panel.
	const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
	const stay = () => clearTimeout(leaving.current);
	const leave = () => {
		stay();
		leaving.current = setTimeout(() => setOpened(false), 150);
	};
	useEffect(() => stay, []);
	const open = () => (stay(), setOpened(true));
	return (
		<PopoverPanel
			opened={opened}
			onClose={() => setOpened(false)}
			trapFocus={false}
			target={
				<button
					type="button"
					onMouseEnter={open}
					onMouseLeave={leave}
					onClick={() => (opened ? setOpened(false) : open())}
					className="underline decoration-dotted underline-offset-2 hover:text-neutral-600"
				>
					{label}
				</button>
			}
		>
			<div onMouseEnter={stay} onMouseLeave={leave} className="p-1">
				{agents.map((a) => (
					<div key={a.id} className="flex gap-2 px-2 py-1.5">
						<Avatar name={a.name} image={a.image} agent size="xs" />
						<div className="min-w-0 flex-1">
							<div className="font-medium">{a.name}</div>
							<div className="truncate text-neutral-500">{a.step ?? "Writing a reply…"}</div>
						</div>
						<StopButton agent={a} />
					</div>
				))}
				<div className="mt-1 border-t border-neutral-100 pt-1">
					<MenuItem onClick={() => navigate("settings", "activity")}>See what they did in Activity</MenuItem>
				</div>
			</div>
		</PopoverPanel>
	);
}
