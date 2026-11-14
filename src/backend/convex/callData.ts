import { formatPhone } from "@companybot/core";
import type { Doc } from "./_generated/dataModel";

/** Shared by the dock, Inbox and record history. The caller supplies only a visible record. */
export function callContact(c: Doc<"inboxConversations">, record: { title: string } | null) {
	const number = c.contact;
	const formattedNumber = formatPhone(number);
	const recordName = record?.title.trim() || null;
	return { number, formattedNumber, recordName, displayName: recordName ?? formattedNumber };
}

export function callData(m: Doc<"inboxMessages">) {
	const call = m.call!;
	const answeredAt = call.connectedAt ?? null;
	const endedAt = call.endedAt ?? null;
	const status = call.active
		? answeredAt !== null ? "in-progress" as const : "ringing" as const
		: call.state === "unknown" || call.state === "ending" || call.state === "connected" || call.state === "ringing" ? "failed" as const : call.state;
	return {
		id: m._id,
		recording: call.recording ? { status: call.recording.status, error: call.recording.error ?? null } : null,
		transcript: call.transcript ? { status: call.transcript.status, text: null, error: call.transcript.error ?? null } : null,
		summary: call.summary ? { status: call.summary.status, text: call.summary.text ?? null, error: call.summary.error ?? null } : null,
		direction: m.direction === "in" ? "in" as const : "out" as const,
		status,
		startedAt: m._creationTime,
		answeredAt,
		endedAt,
		/** Connected seconds. Live queries are snapshots; clients tick from answeredAt. */
		duration: answeredAt === null ? null : Math.max(0, Math.floor(((endedAt ?? Date.now()) - answeredAt) / 1000)),
		active: call.active,
		ending: call.state === "ending",
		/** Kept for existing clients; new cards use status and answeredAt. */
		state: call.state,
		connectedAt: answeredAt,
	};
}

/** Plain call history for the Inbox list, including calls saved by older clients. */
export function callPreview(m: Doc<"inboxMessages">) {
	const call = callData(m);
	const direction = call.direction === "in" ? "Incoming call" : "Outgoing call";
	if (call.active) return direction;
	if (call.state === "unknown") return `${direction} · Outcome unknown`;
	if (call.status === "completed") {
		const seconds = call.duration;
		return seconds === null ? direction : `${direction} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	}
	if (call.status === "missed") return "Missed call";
	if (call.status === "no-answer") return `${direction} · No answer`;
	if (call.status === "declined") return `${direction} · Declined`;
	return `${direction} · Failed`;
}
