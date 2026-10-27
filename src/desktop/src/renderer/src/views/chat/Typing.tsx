import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";

// Same as backend typing.ts: ping at most this often while typing; a ping counts this long.
const PING_MS = 4_000;
const TYPING_MS = 6_000;

/** Who's typing in a place, as one line ("Ada and Scribe are typing…"), and `ping` to call on each keystroke. */
export function useTyping(chatId: Id<"chats">, threadId?: Id<"chatMessages">) {
	const typing = useQuery(api.typing.list, { chatId, threadId });
	const send = useMutation(api.typing.ping);
	const last = useRef(0);
	const ping = useCallback(() => {
		if (Date.now() - last.current < PING_MS) return;
		last.current = Date.now();
		send({ chatId, threadId }).catch(() => {});
	}, [send, chatId, threadId]);
	// Sending ends typing on the server; let the next keystroke ping again at once.
	const sent = useCallback(() => (last.current = 0), []);

	// Pings go stale as time passes, which no query re-run will notice: tick while anyone is shown.
	const [now, setNow] = useState(Date.now);
	const pending = typing?.people.some((p) => now - p.at < TYPING_MS);
	useEffect(() => {
		if (!pending) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [pending]);
	useEffect(() => setNow(Date.now()), [typing]);

	const names = [...(typing?.agents ?? []), ...(typing?.people.filter((p) => now - p.at < TYPING_MS) ?? [])].map((p) => p.name);
	return { ping, sent, line: typingLine(names) };
}

export function typingLine(names: string[]) {
	if (names.length === 0) return undefined;
	if (names.length === 1) return `${names[0]} is typing…`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
	if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
	return "Several people are typing…";
}
