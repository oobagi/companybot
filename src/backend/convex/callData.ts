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
