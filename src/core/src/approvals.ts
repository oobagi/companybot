import type { AllowedHow } from "./action-rules";
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

/** "Always allowed by Ada, Oct 25", "Allowed by Ada for Morning brief, Oct 25", "Approved by Ada, Oct 25". */
export function describeAllowed({ how, by, at, automation }: AllowedHow, name: string, timeZone?: string) {
	const date = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
	if (how === "always") return `Always allowed by ${name}, ${date}`;
	if (how === "automation") return `Allowed by ${name} for ${automation ?? "an automation"}, ${date}`;
	return `Approved by ${name}, ${date}`;
}

/** Short words people expect in capitals: "send_sms" → "Send SMS", not "Send sms". */
const ACRONYMS = new Set(["ai", "api", "crm", "csv", "dm", "dns", "faq", "html", "id", "ip", "json", "mms", "otp", "pdf", "sms", "sql", "sso", "ui", "url", "vip"]);

/** An action as words: the server's title when it gives one, else the tool's name ("crm.send_sms" → "Send SMS"). */
export function actionLabel(tool: string, title?: string) {
	if (title?.trim()) return title.trim();
	const words = tool
		.slice(tool.indexOf(".") + 1)
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.split(/[\s_.-]+/)
		.filter(Boolean)
		.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
	const label = words.join(" ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A label inside a sentence: "Send SMS" → "send SMS". Leaves acronyms alone. */
const inSentence = (label: string) => (/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

/** Nouns that read wrong with "a": "send a money". */
const UNCOUNTED = new Set(["money", "data", "mail", "information", "info", "feedback", "memory", "time", "stuff", "content", "text"]);

/** "send SMS" → "send an SMS", "charge card" → "charge a card": for one-off asks, so they read as a single action. */
function withArticle(phrase: string) {
	const [verb, noun, ...rest] = phrase.split(" ");
	if (!verb || !noun || rest.length || /[a-z]s$/.test(noun) || UNCOUNTED.has(noun.toLowerCase())) return phrase;
	const an = /^[A-Z]{2,}$/.test(noun) ? /^[AEFHILMNORSX]/.test(noun) : /^[aeiou]/i.test(noun);
	return `${verb} ${an ? "an" : "a"} ${noun}`;
}

/** Where an action happens, in words: "from your Gmail", "with the workspace's Stripe", "in Companybot". */
export function serviceWords(service: { name: string; connection: "workspace" | "personal" } | null, from = "from") {
	if (!service) return "in Companybot";
	return service.connection === "personal" ? `${from} your ${service.name}` : `with the workspace's ${service.name}`;
}

/**
 * A phone number, laid out for reading: "+15550100100" → "+1 (555) 010-0100". Display only:
 * what's sent and hashed stays as the agent wrote it. Anything else comes back unchanged.
 */
export function readableValue(value: string) {
	const v = value.trim();
	// Bare digit strings are more often ids than phones; only "+" or separators mark a phone.
	if (!/^\+?[\d\s().-]+$/.test(v) || !/^\+|[\s().-]/.test(v)) return value;
	const digits = v.replace(/\D/g, "");
	const us = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
	if (digits.length === 11 && digits.startsWith("1") && v.startsWith("+")) return `+1 ${us(digits.slice(1))}`;
	if (digits.length === 10 && !v.startsWith("+")) return us(digits);
	return value;
}

/** The ask, in the agent's voice: "I'd like to send an email to dana@acme.com from your Gmail." */
export function askText(tool: string, service: Parameters<typeof serviceWords>[0], input: unknown, title?: string) {
	const fields = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const to = [fields.to, fields.recipient, fields.email, fields.phone]
		.flat()
		.filter((x): x is string => typeof x === "string")
		.map(readableValue);
	const action = withArticle(inSentence(actionLabel(tool, title)));
	return to.length
		? `I'd like to ${action} to ${to.join(", ")} ${serviceWords(service)}.`
		: `I'd like to ${action} ${serviceWords(service, "in")}.`;
}

/**
 * Exactly what "Always allow" covers, said the same way on the card and in Settings.
 * Plain on purpose: people read "always" as "still ask me at key steps" unless told otherwise.
 * `whereToChange`: point to Settings; leave it off on the Settings page itself.
 */
export function alwaysAllowText(
	tool: string,
	service: Parameters<typeof serviceWords>[0],
	{ automation, title, whereToChange = true }: { automation?: string; title?: string; whereToChange?: boolean } = {},
) {
	const when = automation ? ` when running ${automation}` : "";
	const change = whereToChange ? " Change it anytime in Settings → Your preferences." : "";
	return `Always allow: agents can ${inSentence(actionLabel(tool, title))} ${serviceWords(service)}${when} without asking you first. Only when acting for you.${change}`;
}

/** Verbs a tool line can put in the past or present: [past, -ing]. Others read "Used …". */
const VERBS: Record<string, [string, string]> = {
	send: ["Sent", "Sending"],
	get: ["Got", "Getting"],
	find: ["Found", "Finding"],
	read: ["Read", "Reading"],
	write: ["Wrote", "Writing"],
	forget: ["Forgot", "Forgetting"],
	make: ["Made", "Making"],
	set: ["Set", "Setting"],
	pay: ["Paid", "Paying"],
	run: ["Ran", "Running"],
	stop: ["Stopped", "Stopping"],
	submit: ["Submitted", "Submitting"],
	undo: ["Undid", "Undoing"],
	...Object.fromEntries(
		(
			"add archive assign book call cancel charge check create delete draft edit email export fetch forward import invite list load look " +
			"mark move open post react refund remember remove reply restore save schedule search share start sync text turn update upload"
		)
			.split(" ")
			.map((v) => {
				const stem = v.endsWith("e") ? v.slice(0, -1) : v;
				const past = v.endsWith("e") ? `${v}d` : v.endsWith("y") && !/[aeiou]y$/.test(v) ? `${v.slice(0, -1)}ied` : `${v}ed`;
				return [v, [past.charAt(0).toUpperCase() + past.slice(1), `${stem.charAt(0).toUpperCase()}${stem.slice(1)}ing`]];
			}),
	),
};

/**
 * A tool line under an agent's message, from what it did ("Send SMS with Fake CRM"):
 * "Sending SMS with Fake CRM…", "Sent SMS with Fake CRM", "Couldn't send SMS with Fake CRM".
 */
export function toolLine(label: string, status: "running" | "done" | "error") {
	const [first = "", ...rest] = label.split(" ");
	const verb = VERBS[first.toLowerCase()];
	const tail = rest.length ? ` ${rest.join(" ")}` : "";
	if (status === "error") return verb ? `Couldn't ${inSentence(label)}` : `Failed: ${label}`;
	if (!verb) return status === "running" ? `Using ${label}…` : `Used ${label}`;
	return status === "running" ? `${verb[1]}${tail}…` : `${verb[0]}${tail}`;
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
