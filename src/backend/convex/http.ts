import { audio as callRecordingAudio } from "./callRecordings";
import { MAX_WEBHOOK_BYTES, isAutomated, parseAddress, splitQuoted, senderVerified, verifySvix, verifyTwilio } from "@companybot/core";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { emailProvider, smsWebhookUrl } from "./channelProviders";
import { upload as uploadFile } from "./files";
import { upload, uploadOptions } from "./images";
import { callback } from "./oauth";

const http = httpRouter();
http.route({ path: "/phone/recording", method: "GET", handler: callRecordingAudio });
auth.addHttpRoutes(http);
http.route({ path: "/oauth/callback", method: "GET", handler: callback });
/** Pictures from the app (images.ts), signed in. */
http.route({ path: "/images/upload", method: "POST", handler: upload });
http.route({ path: "/images/upload", method: "OPTIONS", handler: uploadOptions });
/** Files for messages (files.ts), signed in. */
http.route({ path: "/files/upload", method: "POST", handler: uploadFile });
http.route({ path: "/files/upload", method: "OPTIONS", handler: uploadOptions });

/** Webhook automations' URLs: POST /automations/<token> (automationRuns.receive). */
http.route({
	pathPrefix: "/automations/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const reply = (status: number, ok: boolean, message: string) =>
			new Response(JSON.stringify({ ok, message }), { status, headers: { "Content-Type": "application/json" } });
		const tooBig = () => reply(413, false, `Body is over ${MAX_WEBHOOK_BYTES / 1000} KB.`);
		if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return tooBig();
		const body = await request.text();
		if (new TextEncoder().encode(body).length > MAX_WEBHOOK_BYTES) return tooBig();
		const token = new URL(request.url).pathname.slice("/automations/".length);
		const result = await ctx.runMutation(internal.automationRuns.receive, { token, body });
		return reply(result.status, result.ok, result.message);
	}),
});

/** Biggest inbound webhook body read: an email's metadata, or a text. Bodies of emails are fetched separately. */
const INBOUND_MAX_BYTES = 256_000;

async function readCapped(request: Request) {
	if (Number(request.headers.get("content-length") ?? 0) > INBOUND_MAX_BYTES) return null;
	const body = await request.text();
	return new TextEncoder().encode(body).length > INBOUND_MAX_BYTES ? null : body;
}

/**
 * Email to agents' addresses (Resend's `email.received` webhook, signed by Svix with RESEND_WEBHOOK_SECRET).
 * A request whose signature doesn't check out is refused before anything is read or stored. The body is
 * fetched from Resend by the email's id; each of our addresses it went to gets it in Inbox (inbox.receive),
 * its new part apart from the history it quotes. The same webhook brings what happened to emails we sent
 * (`email.delivered`, `email.bounced`, `email.complained`: inbox.delivered), when it's set to send them.
 */
http.route({
	path: "/email/inbound",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const body = await readCapped(request);
		if (body === null) return new Response("Too big.", { status: 413 });
		const header = (name: string) => request.headers.get(name);
		const signed = await verifySvix({ id: header("svix-id"), timestamp: header("svix-timestamp"), signature: header("svix-signature"), body, secret: process.env.RESEND_WEBHOOK_SECRET });
		if (!signed) return new Response("Bad signature.", { status: 401 });
		let event: { type?: string; data?: { email_id?: string; from?: string; to?: string[]; cc?: string[]; subject?: string; message_id?: string; bounce?: { message?: string } } };
		try {
			event = JSON.parse(body);
		} catch {
			return new Response("Bad body.", { status: 400 });
		}
		const data = event.data;
		const outcome = ({ "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "spam" } as const)[event.type ?? ""];
		if (outcome && data?.email_id) {
			await ctx.runMutation(internal.inbox.delivered, { providerId: data.email_id, event: outcome, ...(data.bounce?.message && { reason: data.bounce.message }) });
			return new Response("OK", { status: 200 });
		}
		if (event.type !== "email.received" || !data?.email_id || !data.from) return new Response("Ignored.", { status: 200 });
		const from = parseAddress(data.from);
		if (!from) return new Response("No sender.", { status: 200 });
		const provider = emailProvider();
		if (!provider) return new Response("Email isn't set up.", { status: 503 });
		// A failed fetch answers 500, so Resend sends the webhook again.
		const content = await provider.received(data.email_id);
		const recipients = [...new Set([...(data.to ?? []), ...(data.cc ?? [])].flatMap((r) => parseAddress(r)?.address ?? []))];
		const { text, quoted } = splitQuoted(content.text);
		for (const to of recipients) {
			const cc = recipients.filter((r) => r !== to);
			await ctx.runMutation(internal.inbox.receive, {
				kind: "email",
				to,
				from: from.address,
				...(from.name && { fromName: from.name }),
				...(data.subject && { subject: data.subject }),
				text,
				...(quoted && { quoted }),
				...(cc.length && { cc }),
				providerId: `${data.email_id}:${to}`,
				...(data.message_id && { messageId: data.message_id }),
				automated: isAutomated(content.headers),
				unverified: !senderVerified(content.headers, from.address),
			});
		}
		return new Response("OK", { status: 200 });
	}),
});

/**
 * Texts to agents' numbers (Twilio's messaging webhook, signed with TWILIO_AUTH_TOKEN over the URL it
 * was set to call). Unsigned or forged requests are refused. Answers with empty TwiML: the agent's reply
 * goes out on its own, once it's written (inboxAgent.ts).
 */
http.route({
	path: "/sms/inbound",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const body = await readCapped(request);
		if (body === null) return new Response("Too big.", { status: 413 });
		const params = Object.fromEntries(new URLSearchParams(body));
		const signed = await verifyTwilio({ url: smsWebhookUrl(), params, signature: request.headers.get("x-twilio-signature"), authToken: process.env.TWILIO_AUTH_TOKEN });
		if (!signed) return new Response("Bad signature.", { status: 403 });
		if (params.To && params.From && params.MessageSid)
			await ctx.runMutation(internal.inbox.receive, { kind: "phone", to: params.To, from: params.From, text: params.Body ?? "", providerId: params.MessageSid });
		return new Response("<Response/>", { status: 200, headers: { "Content-Type": "text/xml" } });
	}),
});

/** Delivery receipts are separate from inbound messages: they never wake an agent or start a conversation. */
http.route({
	path: "/sms/status",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const body = await readCapped(request);
		if (body === null) return new Response("Too big.", { status: 413 });
		const url = new URL(request.url);
		const params = Object.fromEntries(new URLSearchParams(body));
		const signed = await verifyTwilio({ url: `${process.env.CONVEX_SITE_URL ?? ""}/sms/status${url.search}`, params, signature: request.headers.get("x-twilio-signature"), authToken: process.env.TWILIO_AUTH_TOKEN });
		if (!signed || !process.env.TWILIO_ACCOUNT_SID || params.AccountSid !== process.env.TWILIO_ACCOUNT_SID) return new Response("Bad signature or account.", { status: 403 });
		const messageId = url.searchParams.get("messageId");
		const token = url.searchParams.get("token");
		if (!messageId || !token || !/^(SM|MM)[0-9a-f]{32}$/i.test(params.MessageSid ?? "") || !params.From || !params.To || !params.MessageStatus) return new Response("Bad receipt.", { status: 400 });
		await ctx.runMutation(internal.inbox.smsReceipt, { messageId, token, providerId: params.MessageSid!, from: params.From, to: params.To, state: params.MessageStatus, ...(params.ErrorCode && { errorCode: params.ErrorCode }) });
		return new Response(null, { status: 204 });
	}),
});

http.route({
	path: "/phone/events", method: "POST",
	handler: httpAction(async (ctx, request) => {
		const body = await readCapped(request);
		if (body === null) return new Response("Too big.", { status: 413 });
		const ok = await ctx.runAction(internal.phoneProvider.event, { body, authorization: request.headers.get("authorization") ?? "" });
		return new Response(null, { status: ok ? 204 : 403 });
	}),
});

export default http;
