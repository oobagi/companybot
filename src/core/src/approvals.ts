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
 * What a call can do outside the workspace, which decides whether it asks first:
 * - "none": runs right away (reads, and built-ins that stay inside the workspace).
 * - "outside": asks first (sends, calls, connector writes). A person can set it to Always.
 * - "locked": always asks; "Always allow" isn't offered (payments, deleting records, bulk sends).
 *   Owners can lift the lock (see `permissionFor`).
 */
export type Risk = "none" | "outside" | "locked";

/**
 * A tool's risk. Tools can say so themselves (`risk`); otherwise connector tools are
 * "outside" unless marked read-only, since they reach outside services. Built-ins only
 * touch this workspace. A connector's labels are the server's claim: unlabeled tools ask.
 */
export function toolRisk(tool: { risk?: Risk; readOnly?: boolean; source: { type: string } }): Risk {
	return tool.risk ?? (tool.source.type === "connector" && tool.readOnly !== true ? "outside" : "none");
}

/** Whether a call to this tool asks by default, before anyone's rules. */
export const needsApproval = (tool: Parameters<typeof toolRisk>[0]) => toolRisk(tool) !== "none";

/**
 * A person's rule for one action: Always (runs without asking) or Never (blocked).
 * No rule means Ask, the default.
 */
export type RuleSetting = "always" | "never";

/**
 * An owner's lock on one action, for everyone: "ask" (always asks, no Always), "block"
 * (never runs), or "none" (lifts the default lock on a "locked" tool).
 */
export type LockSetting = "ask" | "block" | "none";

export type PermissionDecision =
	/** `via` says why a call that would ask ran anyway. */
	| { type: "run"; via?: "always" | "automation" }
	/** Hold it for the person; `canAlways` offers "Always allow". */
	| { type: "ask"; canAlways: boolean }
	| { type: "deny"; by: "owner" | "person" };

/**
 * Whether a call runs, asks, or is blocked. Strictest wins: an owner's lock beats a
 * person's rule, and Never beats Ask, which beats Always. `rule` is the person's own; `automation`
 * is set when the person allowed this action for the automation this run belongs to.
 * Read fresh for every call: never cache it into a session.
 */
export function permissionFor({
	risk,
	lock,
	rule,
	automation,
}: {
	risk: Risk;
	lock?: LockSetting;
	rule?: RuleSetting;
	automation?: boolean;
}): PermissionDecision {
	if (lock === "block") return { type: "deny", by: "owner" };
	if (rule === "never") return { type: "deny", by: "person" };
	if (lock === "ask" || (risk === "locked" && lock !== "none")) return { type: "ask", canAlways: false };
	if (risk === "none") return { type: "run" };
	if (rule === "always") return { type: "run", via: "always" };
	if (automation) return { type: "run", via: "automation" };
	return { type: "ask", canAlways: true };
}

/** What the agent hears when a call is blocked. */
export const deniedReason = (by: "owner" | "person", tool: string) =>
	by === "owner"
		? `A workspace owner blocked ${tool}, so it didn't run. Tell the person; don't try it again.`
		: `The person you act for set ${tool} to Never, so it didn't run. Tell them; they can change it in Settings.`;

/** How a call that ran was allowed, for the activity log ("Always allowed by Ada, Oct 25"). */
export interface AllowedHow {
	/** "once": approved on the card. "always": a person's Always rule (or Always allow on the card). "automation": allowed when they turned on the automation. */
	how: "once" | "always" | "automation";
	/** The person who allowed it. */
	by: string;
	/** When they allowed it. */
	at: number;
	/** "automation" only: its name. */
	automation?: string;
}

/** "Always allowed by Ada, Oct 25", "Allowed by Ada for Morning brief, Oct 25", "Approved by Ada, Oct 25". */
export function describeAllowed({ how, by, at, automation }: AllowedHow, name: string, timeZone?: string) {
	const date = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
	if (how === "always") return `Always allowed by ${name}, ${date}`;
	if (how === "automation") return `Allowed by ${name} for ${automation ?? "an automation"}, ${date}`;
	return `Approved by ${name}, ${date}`;
}

/** "send_email" → "send email". A tool's name as words, for plain-language prompts. */
export const actionWords = (tool: string) => tool.slice(tool.indexOf(".") + 1).replace(/[_-]+/g, " ").trim();

/** Where an action happens, in words: "from your Gmail", "with the workspace's Stripe", "in Companybot". */
export function serviceWords(service: { name: string; connection: "workspace" | "personal" } | null) {
	if (!service) return "in Companybot";
	return service.connection === "personal" ? `from your ${service.name}` : `with the workspace's ${service.name}`;
}

/** The ask, in the agent's voice: "I'd like to send email to dana@acme.com from your Gmail." */
export function askText(tool: string, service: Parameters<typeof serviceWords>[0], input: unknown) {
	const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const to = [fields.to, fields.recipient, fields.email].flat().filter((x): x is string => typeof x === "string");
	return `I'd like to ${actionWords(tool)}${to.length ? ` to ${to.join(", ")}` : ""} ${serviceWords(service)}.`;
}

/**
 * Exactly what "Always allow" covers, said the same way on the card and in Settings.
 * Plain on purpose: people read "always" as "still ask me at key steps" unless told otherwise.
 */
export function alwaysAllowText(tool: string, service: Parameters<typeof serviceWords>[0], automation?: string) {
	const when = automation ? ` when running ${automation}` : "";
	return `Always allow: agents can ${actionWords(tool)} ${serviceWords(service)}${when} without asking you first. Only when acting for you. Change it anytime in Settings → Your preferences.`;
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
