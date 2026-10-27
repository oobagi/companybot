import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { TYPING_MS, TYPING_PING_MS } from "@companybot/core/typing";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";

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
 * "Ada and Companybot are typing…". Its own component, so its timer re-renders only this line.
 * Pings expire by when this app saw them, not the server's clock, so a computer whose clock is
 * off still shows the right people.
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

	return typingLine([...(typing?.agents ?? []), ...people].map((p) => p.name)) ?? null;
}

function typingLine(names: string[]) {
	if (names.length === 0) return undefined;
	if (names.length === 1) return `${names[0]} is typing…`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
	if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
	return "Several people are typing…";
}
