import type { Actor } from "./types";

/**
 * Approvals: an agent's call to a tool with outside impact waits in the chat until
 * the person it acts for approves it. Dependency-free so the app can import it.
 *
 * An approval is locked to a hash of the exact tool and input. The approver sends back
 * the hash they were shown, and the runner re-checks it before running the call, so
 * what runs is byte-for-byte what was approved. Nothing else is compared: unrelated
 * changes (new messages, edited agents, other approvals) never block or void one.
 */

/** A pending approval expires after this long. Stale actions shouldn't fire days later. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalStatus = "pending" | "approved" | "running" | "done" | "failed" | "denied" | "expired";

/**
 * Whether a call to this tool waits for approval. Tools can say so themselves
 * (`needsApproval`); otherwise connector tools do unless marked read-only, since
 * they reach outside services. Built-ins only touch this workspace.
 */
export function needsApproval(tool: { needsApproval?: boolean; readOnly?: boolean; source: { type: string } }): boolean {
	return tool.needsApproval ?? (tool.source.type === "connector" && tool.readOnly !== true);
}

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

/** SHA-256 (hex) of the exact tool id and input. The approval lock. */
export async function approvalHash(tool: string, input: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson({ tool, input }));
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
	tool: string;
	/** Who decided: the person the agent acted for. */
	by: string;
	decision: "approved" | "denied";
	/** Approved calls: what the tool returned (JSON, clipped), or why it failed. */
	result?: string;
	error?: string;
}
