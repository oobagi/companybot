import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentsOf, newTest, ownerAndMember, signIn } from "./helpers";

// Inbox: an agent's address and number take messages from outside (signed webhooks only), which land as
// conversations linked to matching records, and the agent answers as the Public role, whose ceiling holds
// whatever owners switch on. The network is stubbed: no Resend or Twilio key exists here.

const SECRET_BYTES = "inbox-test-secret-32-bytes-long!";
const WEBHOOK_SECRET = `whsec_${btoa(SECRET_BYTES)}`;
const TWILIO_TOKEN = "twilio-test-token";
const SITE = "https://site.example";

const bytes = (s: string) => new TextEncoder().encode(s);
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
async function hmac(hash: "SHA-1" | "SHA-256", key: Uint8Array, data: string) {
	const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash }, false, ["sign"]);
	return b64(await crypto.subtle.sign("HMAC", k, bytes(data) as BufferSource));
}

/** Resend's webhook as Svix signs it. */
async function emailWebhook(t: ReturnType<typeof newTest>, data: Record<string, unknown>, { secret = SECRET_BYTES, id = crypto.randomUUID() } = {}) {
	const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data });
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = `v1,${await hmac("SHA-256", bytes(secret), `${id}.${timestamp}.${body}`)}`;
	return t.fetch("/email/inbound", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature } });
}

/** Twilio's texting webhook as it signs it: the URL it calls, then each param name and value, sorted. */
async function smsWebhook(t: ReturnType<typeof newTest>, params: Record<string, string>, token = TWILIO_TOKEN) {
	const data = `${SITE}/sms/inbound${Object.keys(params).sort().map((k) => k + params[k]).join("")}`;
	const signature = await hmac("SHA-1", bytes(token), data);
	return t.fetch("/sms/inbound", { method: "POST", body: new URLSearchParams(params).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": signature } });
}

/** The outside services, answering as they would. Each call is kept to check what went out. */
function stubProviders() {
	const calls: { url: string; method: string; body: string }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
		if (url.startsWith("https://api.resend.com/emails/receiving/")) return Response.json({ text: "Hi, can you quote a new roof?\n\nOn Tue, Nov 4 Bob wrote:\n> old stuff", headers: {} });
		if (url === "https://api.resend.com/emails") return Response.json({ id: "sent-1" });
		if (url.includes("/AvailablePhoneNumbers/")) return Response.json({ available_phone_numbers: [{ phone_number: "+15125550100" }] });
		if (url.endsWith("/IncomingPhoneNumbers.json")) return Response.json({ sid: "PN123", phone_number: "+15125550100" });
		if (url.includes("/IncomingPhoneNumbers/")) return new Response(null, { status: 204 });
		if (url.endsWith("/Messages.json")) return Response.json({ sid: "SM-out-1" });
		return new Response("not stubbed", { status: 500 });
	});
	return calls;
}

beforeEach(() => {
	vi.stubEnv("RESEND_API_KEY", "re_test");
	vi.stubEnv("EMAIL_DOMAIN", "agents.example");
	vi.stubEnv("RESEND_WEBHOOK_SECRET", WEBHOOK_SECRET);
	vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
	vi.stubEnv("TWILIO_AUTH_TOKEN", TWILIO_TOKEN);
	vi.stubEnv("CONVEX_SITE_URL", SITE);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const conversations = (t: ReturnType<typeof newTest>) => t.run((ctx) => ctx.db.query("inboxConversations").collect());
const inboxMessages = (t: ReturnType<typeof newTest>) => t.run((ctx) => ctx.db.query("inboxMessages").collect());

/** Companybot with its own address, announcing new conversations in #general. */
async function withAddress(owner: As) {
	const { companybot } = await agentsOf(owner);
	const address = await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "email", name: "frontdesk" });
	const general = (await owner.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
	await owner.mutation(api.contactPoints.setAnnounce, { agentId: companybot._id, chatId: general._id });
	return { agentId: companybot._id as Id<"agents">, address: address as string, generalId: general._id };
}

describe("the Public role", () => {
	it("can't be given staff powers: only its customer-safe abilities switch on", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(owner.mutation(api.roles.setPublicAbility, { ability: "records.edit", on: true })).rejects.toThrow("Public can't be given that");
		await expect(owner.mutation(api.roles.setPublicAbility, { ability: "workspace.manage", on: true })).rejects.toThrow("Public can't be given that");
		await owner.mutation(api.roles.setPublicAbility, { ability: "public.reply", on: true });
		const abilities = (await owner.query(api.roles.publicRole))!.abilities;
		expect(abilities.find((a) => a.id === "public.reply")!.on).toBe(true);
		expect(abilities.every((a) => a.id.startsWith("public."))).toBe(true);
		// Only owners shape it, as with any role.
		await expect(member.mutation(api.roles.setPublicAbility, { ability: "public.handoff", on: false })).rejects.toThrow();
		// It's no member's role: it isn't among the roles people are given.
		expect((await owner.query(api.roles.list))!.map((r) => r.name)).not.toContain("Public");
	});

	it("checks each ability when the agent uses it, and stops once staff take the conversation", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "Dana <dana@acme.com>", to: [address], subject: "Roof", message_id: "<m1@acme.com>" });
		const [c] = await conversations(t);
		const act = (name: "reply" | "take_message" | "hand_off", text: string) => t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name, text });

		// Without "reply on its own", the reply waits for staff as a draft and nothing is sent.
		expect(await act("reply", "Happy to help!")).toMatch(/staff/);
		expect((await inboxMessages(t)).find((m) => m.direction === "out")!.status).toBe("draft");
		expect((await conversations(t))[0]!.needsStaff).toBe("draft");

		await owner.mutation(api.roles.setPublicAbility, { ability: "public.handoff", on: false });
		expect(await act("hand_off", "Needs a person")).toMatch(/isn't allowed/);
		expect((await conversations(t))[0]!.mode).toBe("agent");

		await owner.mutation(api.inbox.takeOver, { id: c!._id });
		expect(await act("take_message", "Call me back")).toMatch(/taken/);
		expect((await inboxMessages(t)).filter((m) => m.direction === "note")).toHaveLength(0);
	});

	it("sends at once only when owners let agents reply on their own", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address } = await withAddress(owner);
		await owner.mutation(api.roles.setPublicAbility, { ability: "public.reply", on: true });
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Roof" });
		const [c] = await conversations(t);
		await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "reply", text: "We'll send a quote." });
		expect((await inboxMessages(t)).find((m) => m.direction === "out")!.status).toBe("sending");
		// One reply per run.
		expect(await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "reply", text: "Again" })).toMatch(/already replied/);
	});
});

describe("inbound webhooks", () => {
	it("refuse email whose signature doesn't check out, storing nothing", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const fetch = stubProviders();
		const { address } = await withAddress(owner);
		expect((await emailWebhook(t, { email_id: "e1", from: "x@evil.com", to: [address] }, { secret: "someone-else's-secret-0123456789" })).status).toBe(401);
		expect((await t.fetch("/email/inbound", { method: "POST", body: JSON.stringify({ type: "email.received", data: { email_id: "e2", from: "x@evil.com", to: [address] } }) })).status).toBe(401);
		expect(await conversations(t)).toHaveLength(0);
		// Refused before the email was read from Resend.
		expect(fetch.some((c) => c.url.includes("/receiving/"))).toBe(false);
	});

	it("refuse texts whose Twilio signature doesn't check out", async () => {
		const t = newTest();
		await signIn(t, "owner@co.com");
		stubProviders();
		const forged = await smsWebhook(t, { From: "+15125550199", To: "+15125550100", Body: "hi", MessageSid: "SM1" }, "not-the-token");
		expect(forged.status).toBe(403);
		const unsigned = await t.fetch("/sms/inbound", { method: "POST", body: "From=%2B15125550199&To=%2B15125550100&Body=hi&MessageSid=SM2" });
		expect(unsigned.status).toBe(403);
		expect(await inboxMessages(t)).toHaveLength(0);
	});
});

describe("routing to Inbox", () => {
	it("puts a signed email in one conversation per contact, announces it, and asks the agent to answer", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address, generalId } = await withAddress(owner);
		expect((await emailWebhook(t, { email_id: "e1", from: "Dana Ruiz <Dana@Acme.com>", to: [address], subject: "Roof quote", message_id: "<m1@acme.com>" })).status).toBe(200);
		// Delivered again (a retry), and a second email: still one conversation, each message once.
		await emailWebhook(t, { email_id: "e1", from: "Dana Ruiz <Dana@Acme.com>", to: [address], subject: "Roof quote" });
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Re: Roof quote" });

		const list = (await owner.query(api.inbox.list))!;
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ channel: "email", contact: "dana@acme.com", contactName: "Dana Ruiz", subject: "Roof quote", mode: "agent" });
		const opened = (await owner.query(api.inbox.get, { id: list[0]!.id }))!;
		expect(opened.messages.map((m) => m.text)).toEqual(["Hi, can you quote a new roof?", "Hi, can you quote a new roof?"]);
		// The agent's reply is queued, not posted in chat; chat only gets the one-line note.
		expect((await conversations(t))[0]!.replyingSince).toBeDefined();
		const posted = await t.run((ctx) => ctx.db.query("chatMessages").filter((q) => q.eq(q.field("chatId"), generalId)).collect());
		expect(posted.map((m) => m.text)).toEqual([expect.stringMatching(/^New conversation from Dana Ruiz \(dana@acme.com\) by email\. \[Open in Inbox\]\(#\/inbox\//)]);
		expect(posted[0]!.text).not.toContain("roof");
	});

	it("stores nothing for an address no agent has, and never answers auto-replies", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const fetch = stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: ["nobody@agents.example"] });
		expect(await conversations(t)).toHaveLength(0);
		fetch.length = 0;
		vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ text: "I'm out of the office.", headers: { "Auto-Submitted": "auto-replied" } }));
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address] });
		const [c] = await conversations(t);
		expect(c!.replyingSince).toBeUndefined();
	});

	it("gives an agent a number, takes its texts in, and releases the number when it's removed", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const calls = stubProviders();
		const { companybot } = await agentsOf(owner);
		vi.useFakeTimers();
		await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "phone", areaCode: "512" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();
		expect((await owner.query(api.contactPoints.forAgent, { agentId: companybot._id }))!.phone).toMatchObject({ status: "active", address: "+15125550100" });
		expect(calls.find((c) => c.url.endsWith("/IncomingPhoneNumbers.json"))!.body).toContain(encodeURIComponent(`${SITE}/sms/inbound`));

		const res = await smsWebhook(t, { From: "+15125550199", To: "+15125550100", Body: "Are you open Saturday?", MessageSid: "SM1" });
		expect(res.status).toBe(200);
		expect((await owner.query(api.inbox.list))![0]).toMatchObject({ channel: "sms", contact: "+15125550199", preview: "Are you open Saturday?" });

		vi.useFakeTimers();
		await owner.mutation(api.contactPoints.remove, { agentId: companybot._id, kind: "phone" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/IncomingPhoneNumbers/PN123.json"))).toBe(true);
	});

	it("is only for people whose role can see Inbox", async () => {
		const { t, owner, member } = await ownerAndMember();
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		const memberRole = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: memberRole.id, permission: "inbox.use", on: false });
		expect(await member.query(api.inbox.list)).toBeNull();
		const [c] = await conversations(t);
		await expect(member.mutation(api.inbox.reply, { id: c!._id, text: "Hi" })).rejects.toThrow();
		expect(await member.query(api.inbox.get, { id: c!._id })).toBeNull();
	});
});

describe("record matching", () => {
	it("links a conversation to the record whose email or phone field matches", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await owner.mutation(api.fields.create, { typeId, label: "Email", kind: "email" });
		await owner.mutation(api.fields.create, { typeId, label: "Phone", kind: "phone" });
		await owner.mutation(api.records.create, { typeId, values: { name: "Someone else", email: "other@acme.com" } });
		await owner.mutation(api.records.create, { typeId, values: { name: "Dana Ruiz", email: "Dana@Acme.com" } });
		await owner.mutation(api.records.create, { typeId, values: { name: "Sam Lee", phone: "(512) 555-0199" } });
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		await emailWebhook(t, { email_id: "e2", from: "stranger@else.com", to: [address], subject: "Hi" });
		const { companybot } = await agentsOf(owner);
		await t.run(async (ctx) => {
			await ctx.db.insert("contactPoints", { workspaceId: (await ctx.db.get(companybot._id))!.workspaceId, agentId: companybot._id, kind: "phone", address: "+15125550100", status: "active", createdBy: owner.userId });
		});
		await smsWebhook(t, { From: "+15125550199", To: "+15125550100", Body: "hi", MessageSid: "SM1" });

		const list = (await owner.query(api.inbox.list))!;
		const recordOf = (contact: string) => list.find((c) => c.contact === contact)!.record?.title ?? null;
		expect(recordOf("dana@acme.com")).toBe("Dana Ruiz");
		expect(recordOf("+15125550199")).toBe("Sam Lee");
		expect(recordOf("stranger@else.com")).toBeNull();
	});
});

describe("staff in Inbox", () => {
	it("send the agent's waiting reply from its address, threaded on the customer's email", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const calls = stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Roof", message_id: "<m1@acme.com>" });
		const [c] = await conversations(t);
		await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "reply", text: "Happy to help." });
		const draft = (await inboxMessages(t)).find((m) => m.status === "draft")!;
		vi.useFakeTimers();
		await owner.mutation(api.inbox.sendDraft, { messageId: draft._id, text: "Happy to help! — Companybot" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const sent = JSON.parse(calls.find((x) => x.url === "https://api.resend.com/emails")!.body);
		expect(sent).toMatchObject({ from: `"Companybot" <${address}>`, to: ["dana@acme.com"], subject: "Re: Roof", text: "Happy to help! — Companybot" });
		expect(sent.headers).toMatchObject({ "In-Reply-To": "<m1@acme.com>", References: "<m1@acme.com>" });
		expect((await inboxMessages(t)).find((m) => m._id === draft._id)!.status).toBe("sent");
		expect((await conversations(t))[0]!.needsStaff).toBeUndefined();
	});
});
