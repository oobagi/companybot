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

