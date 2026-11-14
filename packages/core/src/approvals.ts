import type { Actor } from "./types";

/**
 * Approvals: an agent's call to a tool with outside impact waits in the chat until
 * the person it acts for approves it.
 *
 * An approval is locked to a hash of the exact tool and input. The approver sends back
 * the hash they were shown, and the runner re-checks it before running the call, so
 * what runs is byte-for-byte what was approved. Inputs name what they change by id, never by
 * a name that can change hands. A call whose effect depends on something as it is now (a page
 * it archives or overwrites: `ToolDef.binds`) also locks to that thing's revision, so a change
 * to it since stops the call. Nothing else is compared: unrelated changes (new messages,
 * edited agents, other approvals) never block or void one.
 */

/** A pending approval expires after this long. Stale actions shouldn't fire days later. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A call that may or may not have happened (an outside call cut off or failed in transit) is `failed` with
 * `outcome: "unknown"` beside it, so apps released before it still show its error. Built-in calls that commit
 * in one transaction never end there: their effect commits with their receipt, or not at all.
 */
export type ApprovalStatus = "pending" | "approved" | "running" | "done" | "failed" | "denied" | "expired";

/** JSON with object keys sorted at every level, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(obj)
				.filter((k) => obj[k] !== undefined)
				.sort()
				.map((k) => [k, sortKeys(obj[k])]),
		);
	}
	return value;
}

/** Longest card text an agent may write for a held call. */
export const WHY_MAX = 280;

/**
 * Asked of the agent right after it makes a call that's held: what goes at the top of the card,
 * in its words. The card shows the exact input under it, so this is the what and the why, not the details.
 */
export function whyPrompt(tool: string, input: string) {
	return [
		`Your ${tool} call is held: it won't run until the person you act for allows it on a card. The exact input:`,
		"```json",
		input,
		"```",
		"Write the top of that card: one or two short sentences to them, first person, saying what this will do (name the thing it touches) and why you want to do it.",
		"Plain words, no greeting, no IDs, no markdown. This is only for the card, not your answer: write only those sentences.",
	].join("\n");
}

/** The agent's card text, tidied and capped; undefined if it wrote nothing usable. */
export function cleanWhy(text: string) {
	const flat = text.replace(/\s+/g, " ").trim().replace(/^["“](.*)["”]$/, "$1").trim();
	// The conversation it's asked in ends with how to answer the chat; if it answered that way, the card keeps its plain ask.
	if (!flat || flat.startsWith("{")) return undefined;
	return flat.length > WHY_MAX ? `${flat.slice(0, WHY_MAX - 1).trimEnd()}…` : flat;
}

/**
 * SHA-256 (hex) of the exact tool id and input, and the revisions it's bound to (`bound`, canonical JSON
 * from the backend's `boundRevisions`), if any. The approval lock.
 */
export async function approvalHash(tool: string, input: unknown, bound?: string): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(bound === undefined ? { tool, input } : { tool, input, bound }));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Who can approve or deny: only the person the agent acts for. The call runs with
 * their access and accounts, so nobody else (owners included) can say yes for them.
 */
export const canDecideApproval = (who: Actor, approval: { actorId: string }) => who.userId === approval.actorId;

/** The stored status, with pending ones past `expiresAt` shown as expired. */
export const approvalStatus = (approval: { status: ApprovalStatus; expiresAt: number }, now = Date.now()): ApprovalStatus =>
	approval.status === "pending" && now >= approval.expiresAt ? "expired" : approval.status;

/** What the agent is told in the turn after a decision (see turn-input.ts). */
export interface ApprovalOutcome {
	/** Rich connector output for this approver's current turn only, never saved in the replay prompt. */
	rich?: { input: unknown; output: import("./mcp-content").McpContent };
	tool: string;
	/** Who decided: the person the agent acted for. */
	by: string;
	decision: "approved" | "denied";
	/** Approved calls: what the tool returned (JSON, clipped), or why it failed. */
	result?: string;
	error?: string;
}
