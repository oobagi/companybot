import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { textOfHtml } from "../convex/channelProviders";
import { type As, agentsOf, newTest, ownerAndMember, signIn } from "./helpers";

// Inbox: the workspace's addresses and numbers take messages from outside (signed webhooks only), which land
// as conversations linked to matching records, and the agent picked on the address answers as the Public
// role, whose ceiling holds whatever owners switch on. The network is stubbed: no Resend or Twilio key exists here.

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
async function emailWebhook(t: ReturnType<typeof newTest>, data: Record<string, unknown>, { secret = SECRET_BYTES, id = crypto.randomUUID(), type = "email.received" } = {}) {
	const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
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

/** An address for the workspace, answered by Companybot. */
async function withAddress(owner: As) {
	const { companybot } = await agentsOf(owner);
	const address = await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "email", name: "frontdesk" });
	const general = (await owner.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
	return { agentId: companybot._id as Id<"agents">, address: address as string, generalId: general._id };
}

describe("the Public role", () => {
	it("is no member's role, and how an agent answers customers is set on the agent, by those who manage agents", async () => {
		const { owner, member } = await ownerAndMember();
		expect((await owner.query(api.roles.list))!.map((r) => r.name)).not.toContain("Public");
		const agentId = (await owner.query(api.agents.list))[0]!._id as Id<"agents">;
		await owner.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "send", handOffTopics: [" Refunds ", "refunds", ""] });
		const agent = (await owner.query(api.agents.list)).find((a) => a._id === agentId)!;
		expect([agent.customerReplies, agent.handOffTopics]).toEqual(["send", ["Refunds"]]);
		// A new version, so it shows in the agent's history and can be restored.
		expect((await owner.query(api.agents.history, { agentId }))[0]!.config.customerReplies).toBe("send");
		await expect(member.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "check" })).rejects.toThrow();
	});

	it("keeps replies as drafts unless the agent sends right away, and stops once staff take the conversation", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "Dana <dana@acme.com>", to: [address], subject: "Roof", message_id: "<m1@acme.com>" });
		const [c] = await conversations(t);
		const act = (name: "reply" | "take_message" | "hand_off", text: string) => t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name, text });

		// Set to check each reply (the default), the reply waits for staff as a draft and nothing is sent.
		expect(await act("reply", "Happy to help!")).toMatch(/staff/);
		expect((await inboxMessages(t)).find((m) => m.direction === "out")!.status).toBe("draft");
		expect((await conversations(t))[0]!.needsStaff).toBe("draft");

		await owner.mutation(api.inbox.assign, { id: c!._id, to: (await owner.query(api.workspace.team))!.members[0]!.userId });
		expect(await act("take_message", "Call me back")).toMatch(/taken/);
		// The assignment shows as a line; the agent, stopped, took no message.
		expect((await inboxMessages(t)).filter((m) => m.direction === "event").map((m) => m.assignedTo)).toEqual([(await owner.query(api.workspace.team))!.members[0]!.userId]);
		expect(await t.run((ctx) => ctx.db.query("inboxComments").collect())).toEqual([]);
	});

	it("sends at once only when the agent is set to send replies right away", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address, agentId } = await withAddress(owner);
		await owner.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "send" });
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

describe("notifications", () => {
	it("tells whoever it's assigned to (not whoever assigned it), again when the customer writes, and opening it clears them", async () => {
		const { t, owner, member } = await ownerAndMember();
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "Dana <dana@acme.com>", to: [address], subject: "Roof" });
		const [c] = await conversations(t);
		// The agent answers it: nobody's told yet.
		expect(await member.query(api.notifications.list)).toEqual([]);

		await owner.mutation(api.inbox.assign, { id: c!._id, to: member.userId });
		expect(await owner.query(api.notifications.list)).toEqual([]);
		const [assigned] = (await member.query(api.notifications.list))!;
		expect(assigned).toMatchObject({ kind: "assigned", text: "owner@co.com assigned it to you", conversationId: c!._id, popUp: true });

		// The customer writes again: one notification for the conversation, now the message.
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Re: Roof" });
		const after = (await member.query(api.notifications.list))!;
		expect(after.map((n) => n.kind)).toEqual(["message"]);

		await member.mutation(api.notifications.clearConversation, { conversationId: c!._id });
		expect(await member.query(api.notifications.list)).toEqual([]);
		// Nobody else's to clear.
		await owner.mutation(api.inbox.assign, { id: c!._id, to: member.userId });
		const [again] = (await member.query(api.notifications.list))!;
		await owner.mutation(api.notifications.clear, { id: again!.id });
		expect(await member.query(api.notifications.list)).toHaveLength(1);
		await member.mutation(api.notifications.clearAll, {});
		expect(await member.query(api.notifications.list)).toEqual([]);
	});

	it("tells everyone who can use Inbox when the agent hands one off", async () => {
		const { t, owner, member } = await ownerAndMember();
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Roof" });
		const [c] = await conversations(t);
		await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "hand_off", text: "Wants a site visit" });
		for (const as of [owner, member]) expect((await as.query(api.notifications.list))!.map((n) => [n.kind, n.text])).toEqual([["handoff", "Companybot handed it to staff: Wants a site visit"]]);
	});
});

describe("comments", () => {
	it("are staff's, on a message: authors alone change them, mentions and the assignee are told, and they go with their conversation", async () => {
		const { t, owner, member } = await ownerAndMember();
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "Dana <dana@acme.com>", to: [address], subject: "Roof" });
		const [c] = await conversations(t);
		const [message] = await inboxMessages(t);
		await owner.mutation(api.inbox.assign, { id: c!._id, to: owner.userId });

		// The member mentions the owner, who's also the assignee: told once, as mentioned.
		const id = await member.mutation(api.inboxComments.add, { messageId: message!._id, text: "  Wants it by Friday  ", mentions: [owner.userId] });
		const [told] = (await owner.query(api.notifications.list))!;
		expect(told).toMatchObject({ kind: "comment", text: "member@co.com mentioned you: Wants it by Friday", popUp: true });
		expect(await member.query(api.notifications.list)).toEqual([]);

		const shown = (await owner.query(api.inbox.get, { id: c!._id }))!.messages[0]!.comments;
		expect(shown).toEqual([expect.objectContaining({ text: "Wants it by Friday", edited: false, mine: false, author: expect.objectContaining({ name: "member@co.com" }), mentions: [expect.objectContaining({ id: owner.userId })] })]);
		expect((await member.query(api.inbox.get, { id: c!._id }))!.messages[0]!.comments[0]!.mine).toBe(true);

		// Only its author edits or deletes it, whatever their role.
		await expect(owner.mutation(api.inboxComments.edit, { id, text: "Mine now" })).rejects.toThrow("Only whoever wrote a comment");
		await expect(owner.mutation(api.inboxComments.remove, { id })).rejects.toThrow("Only whoever wrote a comment");
		await member.mutation(api.inboxComments.edit, { id, text: "By Thursday" });
		expect((await owner.query(api.inbox.get, { id: c!._id }))!.messages[0]!.comments[0]).toMatchObject({ text: "By Thursday", edited: true });
		await expect(member.mutation(api.inboxComments.add, { messageId: message!._id, text: "   " })).rejects.toThrow("Write something");

		// The owner comments on their own conversation: nobody's told.
		await owner.mutation(api.notifications.clearAll, {});
		await owner.mutation(api.inboxComments.add, { messageId: message!._id, text: "On it" });
		expect(await owner.query(api.notifications.list)).toEqual([]);
		expect(await member.query(api.notifications.list)).toEqual([]);

		await member.mutation(api.inboxComments.remove, { id });
		expect((await owner.query(api.inbox.get, { id: c!._id }))!.messages[0]!.comments.map((k) => k.text)).toEqual(["On it"]);
	});

	it("are where the agent notes a message for staff, on the customer's latest message", async () => {
		const { t, owner } = await ownerAndMember();
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Roof" });
		const [c] = await conversations(t);
		await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "hand_off", text: "Wants a site visit" });
		const [message] = (await owner.query(api.inbox.get, { id: c!._id }))!.messages;
		expect(message!.direction).toBe("in");
		expect(message!.comments).toEqual([expect.objectContaining({ text: "Handed off: Wants a site visit", mine: false, author: expect.objectContaining({ type: "agent", name: "Companybot" }) })]);
	});
});

describe("routing to Inbox", () => {
	it("puts a signed email in one conversation per contact, and asks the agent to answer without posting in chat", async () => {
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
		// The agent's reply is queued; nothing goes to chat (posting about it is an automation's job).
		expect((await conversations(t))[0]!.replyingSince).toBeDefined();
		const posted = await t.run((ctx) => ctx.db.query("chatMessages").filter((q) => q.eq(q.field("chatId"), generalId)).collect());
		expect(posted).toEqual([]);
	});

	it("stores nothing for an address no workspace has, and never answers auto-replies", async () => {
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

	it("gets the workspace a number, takes its texts in, and releases the number when it's removed", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const calls = stubProviders();
		const { companybot } = await agentsOf(owner);
		vi.useFakeTimers();
		await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "phone", areaCode: "512" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();
		expect(await owner.query(api.contactPoints.forAgent, { agentId: companybot._id })).toEqual([{ kind: "phone", address: "+15125550100" }]);
		expect(calls.find((c) => c.url.endsWith("/IncomingPhoneNumbers.json"))!.body).toContain(encodeURIComponent(`${SITE}/sms/inbound`));

		const res = await smsWebhook(t, { From: "+15125550199", To: "+15125550100", Body: "Are you open Saturday?", MessageSid: "SM1" });
		expect(res.status).toBe(200);
		expect((await owner.query(api.inbox.list))![0]).toMatchObject({ channel: "sms", contact: "+15125550199", preview: "Are you open Saturday?" });

		vi.useFakeTimers();
		const [number] = (await owner.query(api.contactPoints.list))!.points;
		await owner.mutation(api.contactPoints.remove, { id: number!.id });
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

describe("shared addresses", () => {
	it("leave an address nobody answers to staff, and a new answerer takes only new conversations", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const address = (await owner.mutation(api.contactPoints.add, { kind: "email", name: "hello" })) as string;
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		const [first] = await conversations(t);
		expect(first).toMatchObject({ via: address, mode: "staff" });
		expect(first!.agentId).toBeUndefined();
		expect(first!.replyingSince).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toEqual([expect.objectContaining({ conversationId: first!._id, kind: "message" })]);

		const { companybot } = await agentsOf(owner);
		const [point] = (await owner.query(api.contactPoints.list))!.points;
		await owner.mutation(api.contactPoints.setAgent, { id: point!.id, agentId: companybot._id });
		expect((await owner.query(api.contactPoints.list))!.points[0]!.agent).toEqual({ id: companybot._id, name: "Companybot" });
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Hi again" });
		await emailWebhook(t, { email_id: "e3", from: "sam@acme.com", to: [address], subject: "Quote" });
		const byContact = (contact: string) => conversations(t).then((all) => all.find((c) => c.contact === contact)!);
		expect(await byContact("dana@acme.com")).toMatchObject({ mode: "staff" });
		expect(await byContact("sam@acme.com")).toMatchObject({ mode: "agent", agentId: companybot._id });
		expect((await byContact("sam@acme.com")).replyingSince).toBeDefined();
	});

	it("send what staff write under their own name, from the address it came to, until that's removed", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const calls = stubProviders();
		const { address } = await withAddress(owner);
		vi.useFakeTimers();
		const { conversationId } = await owner.mutation(api.inbox.start, { from: address, channel: "email", to: "Dana@Acme.com", subject: "Your roof", text: "Hi Dana" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();
		const sent = JSON.parse(calls.find((x) => x.url === "https://api.resend.com/emails")!.body);
		const business = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!.name);
		expect(sent.from).toMatch(new RegExp(`^"(?!Companybot).+ from ${business}" <${address}>$`));
		expect((await conversations(t))[0]).toMatchObject({ via: address, mode: "staff", takenBy: owner.userId });

		const [point] = (await owner.query(api.contactPoints.list))!.points;
		await owner.mutation(api.contactPoints.remove, { id: point!.id });
		expect((await owner.query(api.inbox.get, { id: conversationId }))!.via).toEqual({ address, status: "removed", error: null });
		vi.useFakeTimers();
		const { messageId } = await owner.mutation(api.inbox.reply, { id: conversationId, text: "Still there?" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await inboxMessages(t)).find((m) => m._id === messageId)).toMatchObject({ status: "failed", error: "This conversation's email address isn't the workspace's anymore." });
	});

	it("assign a conversation to any agent, which then answers it", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const address = (await owner.mutation(api.contactPoints.add, { kind: "email", name: "hello" })) as string;
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		const [c] = await conversations(t);
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.inbox.assign, { id: c!._id, to: companybot._id });
		const opened = (await owner.query(api.inbox.get, { id: c!._id }))!;
		expect(opened).toMatchObject({ mode: "agent", agent: expect.objectContaining({ name: "Companybot" }) });
		expect(opened.messages.at(-1)!.assignedTo).toMatchObject({ type: "agent", name: "Companybot" });
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Re: Hi" });
		expect((await conversations(t))[0]!.replyingSince).toBeDefined();
	});
});

describe("customers", () => {
	it("links a conversation to the record in the customers database whose email or phone field matches", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await owner.mutation(api.fields.create, { typeId, label: "Email", kind: "email" });
		await owner.mutation(api.fields.create, { typeId, label: "Phone", kind: "phone" });
		await owner.mutation(api.records.create, { typeId, values: { name: "Someone else", email: "other@acme.com" } });
		await owner.mutation(api.records.create, { typeId, values: { name: "Dana Ruiz", email: "Dana@Acme.com" } });
		await owner.mutation(api.records.create, { typeId, values: { name: "Sam Lee", phone: "(512) 555-0199" } });
		// A match in another database doesn't count: only the customers database's records are customers.
		const otherId = await owner.mutation(api.recordTypes.create, { plural: "Vendors" });
		await owner.mutation(api.fields.create, { typeId: otherId, label: "Email", kind: "email" });
		await owner.mutation(api.records.create, { typeId: otherId, values: { name: "Stranger Inc", email: "stranger@else.com" } });
		await owner.mutation(api.customers.set, { typeId, addNew: false });
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

	it("links nothing without a customers database, and relinks every conversation when one is picked", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await owner.mutation(api.fields.create, { typeId, label: "Email", kind: "email" });
		await owner.mutation(api.records.create, { typeId, values: { name: "Dana Ruiz", email: "dana@acme.com" } });
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		const recordOf = async () => (await owner.query(api.inbox.list))![0]!.record?.title ?? null;
		expect(await recordOf()).toBeNull();
		vi.useFakeTimers();
		await owner.mutation(api.customers.set, { typeId, addNew: false });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await recordOf()).toBe("Dana Ruiz");
		await owner.mutation(api.customers.set, { typeId: null, addNew: false });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await recordOf()).toBeNull();
	});

	it("makes a record for someone new when the setting says so, from them, and finds it next time", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await owner.mutation(api.fields.create, { typeId, label: "Email", kind: "email" });
		await owner.mutation(api.customers.set, { typeId, addNew: true });
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "Dana Ruiz <dana@acme.com>", to: [address], subject: "Hi" });
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Again" });
		const records = await t.run((ctx) => ctx.db.query("records").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect());
		expect(records.map((r) => [r.title, r.values.email])).toEqual([["Dana Ruiz", "dana@acme.com"]]);
		expect((await owner.query(api.inbox.list))![0]!.record?.title).toBe("Dana Ruiz");
		const history = await t.run((ctx) => ctx.db.query("recordHistory").withIndex("by_record", (q) => q.eq("recordId", records[0]!._id)).collect());
		expect(history).toMatchObject([{ action: "created", contact: "dana@acme.com" }]);
		// Only Inbox setup changes it.
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		const member = await signIn(t, "member@co.com");
		await expect(member.mutation(api.customers.set, { typeId: null, addNew: false })).rejects.toThrow();
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
		const business = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!.name);
		expect(sent).toMatchObject({ from: `"Companybot from ${business}" <${address}>`, to: ["dana@acme.com"], subject: "Re: Roof", text: "Happy to help! — Companybot" });
		expect(sent.headers).toMatchObject({ "In-Reply-To": "<m1@acme.com>", References: "<m1@acme.com>" });
		expect((await inboxMessages(t)).find((m) => m._id === draft._id)!.status).toBe("sent");
		expect((await conversations(t))[0]!.needsStaff).toBeUndefined();
	});

	it("keep an email's quoted history apart, who else it went to, and what happened to a reply after it left", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address, "sam@acme.com"], cc: ["Lee <lee@acme.com>"], subject: "Roof", message_id: "<m1@acme.com>" });
		const [received] = await inboxMessages(t);
		expect(received).toMatchObject({ text: "Hi, can you quote a new roof?", quoted: "On Tue, Nov 4 Bob wrote:\n> old stuff", cc: ["sam@acme.com", "lee@acme.com"] });
		const [c] = await conversations(t);
		await t.mutation(internal.inboxAgent.act, { conversationId: c!._id, name: "reply", text: "Happy to help." });
		const draft = (await inboxMessages(t)).find((m) => m.status === "draft")!;
		vi.useFakeTimers();
		await owner.mutation(api.inbox.sendDraft, { messageId: draft._id, text: "Happy to help." });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const reply = async () => (await inboxMessages(t)).find((m) => m._id === draft._id)!;
		await emailWebhook(t, { email_id: "sent-1" }, { type: "email.delivered" });
		expect((await reply()).delivery).toBe("delivered");
		await emailWebhook(t, { email_id: "sent-1", bounce: { message: "Mailbox does not exist." } }, { type: "email.bounced" });
		expect(await reply()).toMatchObject({ delivery: "bounced", error: "Their mail server didn't take it (Mailbox does not exist). Check the address." });
	});

	it("read an HTML-only email's quotes as \">\" lines, so they fold like a text one's", () => {
		expect(textOfHtml('<div>Sure &amp; thanks</div><blockquote type="cite">On Nov 4 Bob &lt;b@x.com&gt; wrote:<br><blockquote>older</blockquote></blockquote>')).toBe("Sure & thanks\n\n> On Nov 4 Bob <b@x.com> wrote:\n>\n> > older");
	});

	it("reply to an earlier email they pick, threaded on that one", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const calls = stubProviders();
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Roof", message_id: "<m1@acme.com>" });
		await emailWebhook(t, { email_id: "e2", from: "dana@acme.com", to: [address], subject: "Re: Roof", message_id: "<m2@acme.com>" });
		const [c] = await conversations(t);
		const first = (await inboxMessages(t)).find((m) => m.messageId === "<m1@acme.com>")!;
		vi.useFakeTimers();
		await owner.mutation(api.inbox.reply, { id: c!._id, text: "About your first email…", answers: first._id });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const sent = JSON.parse(calls.findLast((x) => x.url === "https://api.resend.com/emails")!.body);
		expect(sent.headers).toMatchObject({ "In-Reply-To": "<m1@acme.com>" });
		await expect(owner.mutation(api.inbox.reply, { id: c!._id, text: "x", answers: c!._id as never })).rejects.toThrow();
	});
});

describe("field AI", () => {
	/** A customers database with fields AI fills, a record, and its conversation (no model runs here: tests call the write step). */
	async function setup() {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		stubProviders();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await owner.mutation(api.fields.create, { typeId, label: "Email", kind: "email" });
		const notes = await owner.mutation(api.fields.create, { typeId, label: "Notes", kind: "text", ai: { instruction: "A line on what they asked", when: "message", mode: "append" } });
		const budget = await owner.mutation(api.fields.create, { typeId, label: "Budget", kind: "number", ai: { instruction: "Their budget", when: "message", mode: "empty" } });
		const source = await owner.mutation(api.fields.create, { typeId, label: "Source", kind: "text", ai: { instruction: "How they found us", when: "message", mode: "replace" } });
		const stage = await owner.mutation(api.fields.create, { typeId, label: "Stage", kind: "choice", options: [{ label: "Lead" }, { label: "Won" }], ai: { instruction: "Where they are", when: "message", mode: "suggest" } });
		const recordId = await owner.mutation(api.records.create, { typeId, values: { name: "Dana Ruiz", email: "dana@acme.com", notes: "Wants a quote.", budget: 500, source: "Google" } });
		await owner.mutation(api.customers.set, { typeId, addNew: false });
		const { address } = await withAddress(owner);
		await emailWebhook(t, { email_id: "e1", from: "dana@acme.com", to: [address], subject: "Hi" });
		const c = (await t.run((ctx) => ctx.db.query("inboxConversations").collect()))[0]!;
		return { t, owner, typeId, recordId: recordId as Id<"records">, c, keys: { notes: notes.key, budget: budget.key, source: source.key, stage: stage.key } };
	}

	it("checks the setting: an instruction, and a mode that fits the field", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Clients" });
		await expect(owner.mutation(api.fields.create, { typeId, label: "A", kind: "text", ai: { instruction: " ", when: "message", mode: "replace" } })).rejects.toThrow("Say what");
		await expect(owner.mutation(api.fields.create, { typeId, label: "B", kind: "number", ai: { instruction: "x", when: "message", mode: "append" } })).rejects.toThrow("how it writes");
		await expect(owner.mutation(api.fields.create, { typeId, label: "C", kind: "user", ai: { instruction: "x", when: "message", mode: "replace" } })).rejects.toThrow("can't fill");
		// "Add to it" becomes "Replace it" when the field stops being text; a kind it can't fill turns it off.
		const f = await owner.mutation(api.fields.create, { typeId, label: "D", kind: "text", ai: { instruction: "x", when: "quiet", mode: "append" } });
		vi.useFakeTimers();
		await owner.mutation(api.fields.update, { fieldId: f._id, kind: "number" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await t.run((ctx) => ctx.db.get(f._id)))!.ai).toEqual({ instruction: "x", when: "quiet", mode: "replace" });
		await owner.mutation(api.fields.update, { fieldId: f._id, kind: "user" });
		expect((await t.run((ctx) => ctx.db.get(f._id)))!.ai).toBeUndefined();
		const history = await t.run((ctx) => ctx.db.query("recordHistory").collect());
		expect(history.some((h) => h.changes.some((ch) => ch.key === "ai" && ch.new === "Off"))).toBe(true);
	});

	it("schedules a run when a linked customer writes, and only for triggers with fields", async () => {
		const { c } = await setup();
		expect(c.fillAt?.message).toBeGreaterThan(Date.now());
		expect(c.fillAt?.quiet).toBeUndefined();
	});

	it("writes each field by its mode, as AI, and suggests where it should", async () => {
		const { t, owner, recordId, c, keys } = await setup();
		const at = c.fillAt!.message!;
		await t.mutation(internal.fieldAi.apply, {
			conversationId: c._id,
			when: "message",
			at,
			recordId,
			values: { [keys.notes]: "Asked about gutters.", [keys.budget]: 900, [keys.source]: "A friend", [keys.stage]: "Won", email: "evil@x.com" },
			model: "test",
			costUsd: 0.001,
		});
		const record = (await t.run((ctx) => ctx.db.get(recordId)))!;
		// Only if empty: budget had a value, so it stays. Add to it, replace it. Email has no AI: untouched.
		expect(record.values).toMatchObject({ [keys.notes]: "Wants a quote.\n\nAsked about gutters.", [keys.budget]: 500, [keys.source]: "A friend", email: "dana@acme.com" });
		expect(Object.keys(record.ai ?? {}).sort()).toEqual([keys.notes, keys.source].sort());
		const history = await t.run((ctx) => ctx.db.query("recordHistory").withIndex("by_record", (q) => q.eq("recordId", recordId)).collect());
		expect(history.at(-1)).toMatchObject({ ai: { conversationId: c._id } });
		expect((await t.run((ctx) => ctx.db.get(c._id)))!.fillAt?.message).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.query("usage").collect())).some((u) => u.kind === "fields")).toBe(true);

		// Suggest it: kept for someone to accept; accepting writes it, as them.
		const [suggestion] = (await owner.query(api.fieldAi.suggestions, { recordId }))!;
		expect(suggestion).toMatchObject({ label: "Stage", value: "Won" });
		await owner.mutation(api.fieldAi.decide, { id: suggestion!.id, accept: true });
		expect(await owner.query(api.fieldAi.suggestions, { recordId })).toEqual([]);
		const after = (await t.run((ctx) => ctx.db.get(recordId)))!;
		expect(after.values[keys.stage]).toBeTruthy();
		expect(after.ai?.[keys.stage]).toBeUndefined();

		// A person changing a value clears its AI mark.
		await owner.mutation(api.records.update, { recordId, values: { [keys.source]: "Yelp" } });
		expect((await t.run((ctx) => ctx.db.get(recordId)))!.ai?.[keys.source]).toBeUndefined();
	});

	it("skips values that don't fit, and runs a later message replaced", async () => {
		const { t, recordId, c, keys } = await setup();
		await t.mutation(internal.fieldAi.apply, { conversationId: c._id, when: "message", at: c.fillAt!.message!, recordId, values: { [keys.stage]: "Nope", [keys.source]: null }, model: "test", costUsd: 0 });
		expect(await t.run((ctx) => ctx.db.query("fieldSuggestions").collect())).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get(recordId)))!.values[keys.source]).toBe("Google");
		// A run whose time a later message moved finds nothing to do.
		expect(await t.query(internal.fieldAi.context, { conversationId: c._id, when: "message", at: 1 })).toBeNull();
	});
});
