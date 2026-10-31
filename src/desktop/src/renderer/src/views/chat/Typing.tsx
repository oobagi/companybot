import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { TYPING_MS, TYPING_PING_MS } from "@companybot/core/typing";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { Avatar, AvatarStack, MenuItem, PopoverPanel } from "./common";

/** An agent working here, and its step ("Searching records for Acme…"; null while it writes). */
type Working = { id: string; name: string; image?: string | null; step: string | null };

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
	return (
		<>
			{agents.length > 0 && (
				<span aria-hidden className="mr-1.5 inline-flex align-[-4px]">
					<AvatarStack people={agents.map((a) => ({ ...a, type: "agent" }))} size="line" />
				</span>
			)}
			{line.working && (agents.length > 1 ? <WorkingList agents={agents} label={line.working} /> : line.working)}
			{line.working && line.typing && " · "}
			{line.typing}
		</>
	);
}

/**
 * The line's two halves. One agent shows its step ("Companybot: Searching records for Acme…"),
 * or types like a person while it writes; several are "2 agents working", each listed on hover.
 */
export function statusLine(agents: Working[], people: string[]): { working?: string; typing?: string } {
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
	const [anchor, setAnchor] = useState<DOMRect>();
	const button = useRef<HTMLButtonElement>(null);
	// Closes a moment after the mouse leaves, so it can cross the gap to the panel.
	const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
	const stay = () => clearTimeout(leaving.current);
	const leave = () => {
		stay();
		leaving.current = setTimeout(() => setAnchor(undefined), 150);
	};
	useEffect(() => stay, []);
	const open = () => {
		stay();
		if (button.current) setAnchor(button.current.getBoundingClientRect());
	};
	return (
		<>
			<button
				ref={button}
				type="button"
				aria-expanded={!!anchor}
				onMouseEnter={open}
				onMouseLeave={leave}
				onClick={() => (anchor ? setAnchor(undefined) : open())}
				className="underline decoration-dotted underline-offset-2 hover:text-neutral-600"
			>
				{label}
			</button>
			{anchor && (
				<PopoverPanel anchor={anchor} ignore={button} className="w-72" onClose={() => setAnchor(undefined)}>
					<div onMouseEnter={stay} onMouseLeave={leave} className="p-1">
						{agents.map((a) => (
							<div key={a.id} className="flex gap-2 px-2 py-1.5">
								<Avatar name={a.name} image={a.image} agent size="xs" />
								<div className="min-w-0">
									<div className="font-medium">{a.name}</div>
									<div className="truncate text-neutral-500">{a.step ?? "Writing a reply…"}</div>
								</div>
							</div>
						))}
						<div className="mt-1 border-t border-neutral-100 pt-1">
							<MenuItem onClick={() => navigate("settings", "activity")}>See what they did in Activity</MenuItem>
						</div>
					</div>
				</PopoverPanel>
			)}
		</>
	);
}
