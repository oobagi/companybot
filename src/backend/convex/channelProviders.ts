import { isLocalBackend } from "@companybot/core";

// The outside services behind an agent's email address and phone number, each behind a small adapter so
// a self-hoster can swap it: Resend for email (already sends sign-in codes, auth.ts), Twilio for texts.
// Server config only (Convex env), never per-workspace keys:
//   Email: RESEND_API_KEY, EMAIL_DOMAIN (a Resend domain with receiving on), RESEND_WEBHOOK_SECRET.
//   Texts: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
// Email has a local logging stand-in. Phone features always require a configured account; tests mock the network.

export interface OutgoingEmail {
	from: string;
	to: string;
	subject: string;
	text: string;
	/** Message-ID, In-Reply-To and References, so replies thread in the customer's mail app. */
	headers: Record<string, string>;
}

export interface EmailProvider {
	send(email: OutgoingEmail): Promise<{ id: string }>;
	/** A received email's body and headers, by the id its webhook gave. */
	received(id: string): Promise<{ text: string; headers: Record<string, string> }>;
}

export interface SmsProvider {
	/** Buys a number that can send and receive texts, pointing its texts at `smsUrl`. */
	buy(input: { areaCode?: string; smsUrl: string }): Promise<{ id: string; number: string }>;
	release(id: string): Promise<void>;
	send(input: { from: string; to: string; text: string; statusUrl: string }): Promise<{ id: string; status: string }>;
}

const local = () => isLocalBackend(process.env.CONVEX_CLOUD_URL);

/** The domain agents' addresses are on, or null when email isn't set up on this server. */
export function emailDomain(): string | null {
	const domain = process.env.EMAIL_DOMAIN?.trim().toLowerCase();
	if (domain) return domain;
	return local() ? "agents.localhost" : null;
}

export function emailProvider(): EmailProvider | null {
	const key = process.env.RESEND_API_KEY;
	if (key) return resend(key);
	return local() ? loggedEmail : null;
}

export function smsProvider(): SmsProvider | null {
	const sid = process.env.TWILIO_ACCOUNT_SID;
	const token = process.env.TWILIO_AUTH_TOKEN;
	if (sid && token) return twilio(sid, token);
	return null;
}

/** Where Twilio posts a number's texts (http.ts). */
export const smsWebhookUrl = () => `${process.env.CONVEX_SITE_URL ?? ""}/sms/inbound`;
export const smsStatusUrl = (messageId: string, token: string) => `${process.env.CONVEX_SITE_URL ?? ""}/sms/status?${new URLSearchParams({ messageId, token })}`;

async function ok(response: Response, what: string) {
	if (response.ok) return response;
	const body = await response.text().catch(() => "");
	throw new Error(`${what} failed (${response.status}): ${body.slice(0, 300)}`);
}

function resend(key: string): EmailProvider {
	const auth = { Authorization: `Bearer ${key}` };
	return {
		async send(email) {
			const response = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ from: email.from, to: [email.to], subject: email.subject, text: email.text, headers: email.headers }),
			});
			const { id } = (await (await ok(response, "Sending email")).json()) as { id: string };
			return { id };
		},
		async received(id) {
			const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: auth });
			const email = (await (await ok(response, "Reading the email")).json()) as { text?: string | null; html?: string | null; headers?: Record<string, string> | null };
			return { text: email.text?.trim() || textOfHtml(email.html ?? ""), headers: email.headers ?? {} };
		},
	};
}

/**
 * An HTML-only email's words: tags dropped, entities for the common characters read. What it quotes
 * (`<blockquote>`, as iPhones send replies) becomes ">" lines, so it's split off like a text one's.
 */
export function textOfHtml(html: string): string {
	let quoted = html;
	// Innermost first, so a quote in a quote gets ">>".
	for (let i = 0; i < 20; i++) {
		const next = quoted.replace(/<blockquote[^>]*>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/i, (_, inner: string) => `<br>${textOfHtml(inner).split("\n").map((l) => `> ${l}`.trimEnd().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("<br>")}<br>`);
		if (next === quoted) break;
		quoted = next;
	}
	return quoted
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function twilio(sid: string, token: string): SmsProvider {
	const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
	const headers = { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" };
	const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
	return {
		async buy({ areaCode, smsUrl }) {
			const search = new URLSearchParams({ SmsEnabled: "true", VoiceEnabled: "true", PageSize: "1", ...(areaCode && { AreaCode: areaCode }) });
			const found = (await (await ok(await fetch(`${base}/AvailablePhoneNumbers/US/Local.json?${search}`, { headers }), "Finding a number")).json()) as {
				available_phone_numbers: { phone_number: string }[];
			};
			const number = found.available_phone_numbers[0]?.phone_number;
			if (!number) throw new Error(areaCode ? `No numbers are free in area code ${areaCode}. Try another.` : "No numbers are free right now. Try again later.");
			const bought = (await (await ok(await fetch(`${base}/IncomingPhoneNumbers.json`, { method: "POST", headers, body: form({ PhoneNumber: number, SmsUrl: smsUrl, SmsMethod: "POST", ...(process.env.TWILIO_SIP_TRUNK_SID && { TrunkSid: process.env.TWILIO_SIP_TRUNK_SID }) }) }), "Buying the number")).json()) as {
				sid: string;
				phone_number: string;
			};
			return { id: bought.sid, number: bought.phone_number };
		},
		async release(id) {
			const response = await fetch(`${base}/IncomingPhoneNumbers/${encodeURIComponent(id)}.json`, { method: "DELETE", headers });
			// Already gone counts as released.
			if (response.status !== 404) await ok(response, "Releasing the number");
		},
		async send({ from, to, text, statusUrl }) {
			const response = await fetch(`${base}/Messages.json`, { method: "POST", headers, body: form({ From: from, To: to, Body: text, StatusCallback: statusUrl }), signal: AbortSignal.timeout(15_000) });
			// A 4xx is a definite refusal. A timeout, 5xx or unreadable response may have sent it:
			// the caller keeps that uncertain and never automatically repeats the paid POST.
			if (response.status >= 400 && response.status < 500) throw new SmsRejectedError(`The phone company refused the text (${response.status}). Check the number and the account's texting registration.`);
			const sent = (await (await ok(response, "Sending the text")).json()) as { sid?: string; status?: string };
			if (!sent.sid) throw new Error("The phone company didn't return a message id.");
			return { id: sent.sid, status: sent.status ?? "queued" };
		},
	};
}

export class SmsRejectedError extends Error {}

const fakeId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;

const loggedEmail: EmailProvider = {
	async send(email) {
		console.log(`Email from ${email.from} to ${email.to}: ${email.subject}\n\n${email.text}`);
		return { id: fakeId("local-") };
	},
	async received() {
		return { text: "", headers: {} };
	},
};
