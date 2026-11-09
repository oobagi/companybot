import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentsOf, newTest, ownerAndMember, signIn } from "./helpers";

const SITE = "https://phone.example";
const TOKEN = "test-phone-token";
const FROM = "+15125550100";
const TO = "+15125550199";
const SID = `SM${"1".repeat(32)}`;
type Test = ReturnType<typeof newTest>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("CONVEX_SITE_URL", SITE);
	vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest");
	vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

/** Only the network is replaced. Provisioning, staff sends, webhooks and cleanup are real Convex paths. */
function phoneNetwork() {
	const sent: URLSearchParams[] = [];
	const released: string[] = [];
	const searches: URL[] = [];
	let sending = async (_body: URLSearchParams): Promise<Response> => Response.json({ sid: SID, status: "queued" });
	let buying = async (): Promise<Response> => Response.json({ sid: "PNtest", phone_number: FROM });
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.includes("/AvailablePhoneNumbers/")) {
			searches.push(url);
			return Response.json({ available_phone_numbers: [{ phone_number: FROM }] });
		}
		if (url.pathname.endsWith("/IncomingPhoneNumbers.json")) return buying();
		if (init?.method === "DELETE" && url.pathname.includes("/IncomingPhoneNumbers/")) {
			released.push(url.pathname);
			return new Response(null, { status: 204 });
		}
		if (url.pathname.endsWith("/Messages.json")) {
			const body = new URLSearchParams(String(init?.body));
			sent.push(body);
			return sending(body);
		}
		throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
	});
	return { sent, released, searches, sendWith: (f: typeof sending) => { sending = f; }, buyWith: (f: typeof buying) => { buying = f; } };
}

async function withPhone() {
	const t = newTest();
	const owner = await signIn(t, "owner@phone.test");
	const network = phoneNetwork();
	const { companybot } = await agentsOf(owner);
	await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "phone", areaCode: "512" });
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	return { t, owner, agentId: companybot._id, network };
}

async function webhook(t: Test, url: string, params: Record<string, string>, token = TOKEN) {
	const bytes = (s: string) => new TextEncoder().encode(s);
	const key = await crypto.subtle.importKey("raw", bytes(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
	const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(payload)))));
	return t.fetch(url.slice(SITE.length), { method: "POST", body: new URLSearchParams(params).toString(), headers: { "x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded" } });
}

const receipt = (t: Test, url: string, state: string, extra: Record<string, string> = {}) => webhook(t, url, { AccountSid: "ACtest", From: FROM, To: TO, MessageSid: SID, MessageStatus: state, ...extra });
const row = (t: Test, id: Id<"inboxMessages">) => t.run((ctx) => ctx.db.get(id));

describe("an agent's phone in Inbox", () => {
	it("provisions a voice-capable number, sends a staff text, tracks delivery, and files their reply on the same conversation", async () => {
		const { t, owner, agentId, network } = await withPhone();
		expect(network.searches[0]!.searchParams.get("VoiceEnabled")).toBe("true");
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Can we talk Thursday?" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		expect(network.sent[0]!.get("From")).toBe(FROM);
		expect(network.sent[0]!.get("To")).toBe(TO);
		expect((await owner.query(api.inbox.get, { id: sent.conversationId }))!.messages[0]).toMatchObject({ status: "sent", sms: "queued" });
		const callback = network.sent[0]!.get("StatusCallback")!;
		expect((await receipt(t, callback, "sent")).status).toBe(204);
		expect((await row(t, sent.messageId))!.sms!.state).toBe("sent");
		expect((await receipt(t, callback, "delivered")).status).toBe(204);
		await receipt(t, callback, "queued");
		await receipt(t, callback, "undelivered", { ErrorCode: "30003" });
		expect((await row(t, sent.messageId))!.sms!.state).toBe("delivered");
		await webhook(t, `${SITE}/sms/inbound`, { From: TO, To: FROM, Body: "Thursday works", MessageSid: `SM${"2".repeat(32)}` });
		const c = (await owner.query(api.inbox.get, { id: sent.conversationId }))!;
		expect(c.messages.map((m) => m.text)).toEqual(["Can we talk Thursday?", "Thursday works"]);
		expect(c.mode).toBe("staff");
		expect(await owner.query(api.inbox.list)).toHaveLength(1);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(1);
	});

	it("shows carrier refusal without treating an accepted text as delivered", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		await receipt(t, network.sent[0]!.get("StatusCallback")!, "undelivered", { ErrorCode: "21610" });
		await receipt(t, network.sent[0]!.get("StatusCallback")!, "sent");
		expect(await row(t, sent.messageId)).toMatchObject({ status: "failed", sms: { state: "undelivered" }, error: expect.stringContaining("21610") });
	});

	it("keeps an early delivery receipt when the create response arrives afterward", async () => {
		const { t, owner, agentId, network } = await withPhone();
		network.sendWith(async (body) => {
			expect((await receipt(t, body.get("StatusCallback")!, "delivered")).status).toBe(204);
			return Response.json({ sid: SID, status: "queued" });
		});
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		expect(await row(t, sent.messageId)).toMatchObject({ status: "sent", providerId: SID, sms: { state: "delivered" } });
	});

	it("refuses unsigned, forged, wrong-account and oversized receipts without changing a message", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		const url = network.sent[0]!.get("StatusCallback")!;
		expect((await t.fetch(url.slice(SITE.length), { method: "POST", body: "MessageStatus=delivered" })).status).toBe(403);
		expect((await webhook(t, url, { MessageStatus: "delivered" }, "wrong-token")).status).toBe(403);
		expect((await receipt(t, url, "delivered", { AccountSid: "ACother" })).status).toBe(403);
		expect((await t.fetch(url.slice(SITE.length), { method: "POST", body: "x".repeat(256_001) })).status).toBe(413);
		expect((await row(t, sent.messageId))!.sms!.state).toBe("queued");
	});

	it("binds receipts to the exact attempt and numbers, and keeps another workspace's messages private", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		const url = network.sent[0]!.get("StatusCallback")!;
		await receipt(t, url, "delivered", { From: "+15125550999" });
		await receipt(t, url, "delivered", { To: "+15125550999" });
		await receipt(t, url, "delivered", { MessageSid: `SM${"3".repeat(32)}` });
		await receipt(t, url.replace(/token=[^&]+/, "token=wrong-attempt"), "delivered");
		expect((await row(t, sent.messageId))!.sms!.state).toBe("queued");
		const other = await signIn(t, "other@phone.test");
		expect(await other.query(api.inbox.get, { id: sent.conversationId })).toBeNull();
		await expect(other.mutation(api.inbox.reply, { id: sent.conversationId, text: "Forged" })).rejects.toThrow();
		await expect(other.mutation(api.contactPoints.remove, { agentId, kind: "phone" })).rejects.toThrow();
	});

	it("does not automatically repeat an uncertain send, and lets a later receipt resolve it", async () => {
		const { t, owner, agentId, network } = await withPhone();
		network.sendWith(async () => { throw new Error("Connection lost after POST"); });
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(1);
		expect(await row(t, sent.messageId)).toMatchObject({ status: "failed", sms: { state: "unknown" } });
		await receipt(t, network.sent[0]!.get("StatusCallback")!, "delivered");
		expect(await row(t, sent.messageId)).toMatchObject({ status: "sent", sms: { state: "delivered" } });
		expect((await row(t, sent.messageId))!.error).toBeUndefined();
	});

	it("marks a crashed claimed action uncertain instead of leaving Sending forever or repeating it", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		expect(await t.mutation(internal.inbox.claimSms, { messageId: sent.messageId })).not.toBeNull();
		expect(await t.mutation(internal.inbox.claimSms, { messageId: sent.messageId })).toBeNull();
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(0);
		expect((await row(t, sent.messageId))!.sms!.state).toBe("unknown");
	});

	it("distinguishes a definite provider refusal and a local simulation from delivery", async () => {
		const { t, owner, agentId, network } = await withPhone();
		network.sendWith(async () => Response.json({ message: "not registered" }, { status: 400 }));
		const refused = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: refused.messageId });
		expect((await row(t, refused.messageId))!.sms!.state).toBe("failed");
		vi.stubEnv("TWILIO_ACCOUNT_SID", "");
		vi.stubEnv("TWILIO_AUTH_TOKEN", "");
		vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
		const local = await owner.mutation(api.inbox.reply, { id: refused.conversationId, text: "Local hello" });
		await t.action(internal.inbox.deliver, { messageId: local.messageId });
		expect((await row(t, local.messageId))!.sms!.state).toBe("simulated");
		expect(network.sent).toHaveLength(1);
	});

	it("does not switch a queued text to a newly provisioned number", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await owner.mutation(api.contactPoints.remove, { agentId, kind: "phone" });
		await owner.mutation(api.contactPoints.add, { agentId, kind: "phone" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(0);
		expect((await row(t, sent.messageId))!.status).toBe("failed");
	});

	it("rechecks the staff sender's Inbox permission before sending", async () => {
		const { t, owner, member } = await ownerAndMember();
		const network = phoneNetwork();
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "phone" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const sent = await member.mutation(api.inbox.start, { agentId: companybot._id, channel: "sms", to: TO, text: "Hello" });
		const role = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "inbox.use", on: false });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(0);
		expect((await row(t, sent.messageId))!.status).toBe("failed");
	});

	it("stops a queued Public reply when staff take over or turn off automatic replies", async () => {
		const { t, owner, agentId, network } = await withPhone();
		await owner.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "send" });
		await webhook(t, `${SITE}/sms/inbound`, { From: TO, To: FROM, Body: "Are you open?", MessageSid: `SM${"4".repeat(32)}` });
		const c = (await owner.query(api.inbox.list))![0]!;
		await t.mutation(internal.inboxAgent.act, { conversationId: c.id, name: "reply", text: "Hello" });
		await owner.mutation(api.inbox.assign, { id: c.id, to: owner.userId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(0);
		expect((await owner.query(api.inbox.get, { id: c.id }))!.messages.find((m) => m.direction === "out")!.status).toBe("failed");
	});

	it("does not release an active number on a repeated completion, and releases a late purchase for an archived agent", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const point = await t.run((ctx) => ctx.db.query("contactPoints").first());
		await t.mutation(internal.contactPoints.bought, { id: point!._id, providerId: "PNtest", number: FROM });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.released).toHaveLength(0);
		await owner.mutation(api.contactPoints.remove, { agentId, kind: "phone" });
		await owner.mutation(api.contactPoints.add, { agentId, kind: "phone" });
		network.buyWith(async () => {
			await t.run((ctx) => ctx.db.patch(agentId, { archived: true }));
			return Response.json({ sid: "PNlate", phone_number: FROM });
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.released).toHaveLength(2);
		expect((await owner.query(api.contactPoints.forAgent, { agentId }))!.phone!.status).toBe("failed");
	});

	it("sends an approved SMS draft once and stops automatic replies when its policy changes", async () => {
		const { t, owner, agentId, network } = await withPhone();
		await webhook(t, `${SITE}/sms/inbound`, { From: TO, To: FROM, Body: "Are you open?", MessageSid: `SM${"5".repeat(32)}` });
		const c = (await owner.query(api.inbox.list))![0]!;
		await t.mutation(internal.inboxAgent.act, { conversationId: c.id, name: "reply", text: "Draft reply" });
		const draft = (await owner.query(api.inbox.get, { id: c.id }))!.messages.find((m) => m.status === "draft")!;
		await owner.mutation(api.inbox.sendDraft, { messageId: draft.id, text: "Staff checked this" });
		await expect(owner.mutation(api.inbox.sendDraft, { messageId: draft.id, text: "Again" })).rejects.toThrow();
		await owner.mutation(api.inbox.assign, { id: c.id, to: owner.userId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(1);
		expect(network.sent[0]!.get("Body")).toBe("Staff checked this");

		await owner.mutation(api.inbox.assign, { id: c.id, to: "agent" });
		await owner.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "send" });
		vi.advanceTimersByTime(1);
		await webhook(t, `${SITE}/sms/inbound`, { From: TO, To: FROM, Body: "Another question", MessageSid: `SM${"6".repeat(32)}` });
		await t.mutation(internal.inboxAgent.act, { conversationId: c.id, name: "reply", text: "Automatic reply" });
		await owner.mutation(api.agents.setCustomerHandling, { agentId, customerReplies: "check" });
		// Dispatch just the queued text, so no model is run for the inbound event.
		const automatic = (await owner.query(api.inbox.get, { id: c.id }))!.messages.find((m) => m.text === "Automatic reply")!;
		await t.action(internal.inbox.deliver, { messageId: automatic.id });
		expect(network.sent).toHaveLength(1);
		expect((await row(t, automatic.id))!.status).toBe("failed");
		await owner.mutation(api.inbox.assign, { id: c.id, to: owner.userId });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	});

	it("ignores late receipts and releases the number when its workspace is deleted", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.action(internal.inbox.deliver, { messageId: sent.messageId });
		const url = network.sent[0]!.get("StatusCallback")!;
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		expect((await receipt(t, url, "delivered")).status).toBe(204);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await receipt(t, url, "delivered")).status).toBe(204);
		expect(await row(t, sent.messageId)).toBeNull();
		expect(await t.run((ctx) => ctx.db.query("inboxConversations").collect())).toHaveLength(0);
		expect(network.released).toHaveLength(1);
	});

	it("does not buy a number or send a queued text for an archived agent", async () => {
		const { t, owner, agentId, network } = await withPhone();
		const sent = await owner.mutation(api.inbox.start, { agentId, channel: "sms", to: TO, text: "Hello" });
		await t.run((ctx) => ctx.db.patch(agentId, { archived: true }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.sent).toHaveLength(0);
		expect((await row(t, sent.messageId))!.status).toBe("failed");
		await t.run((ctx) => ctx.db.patch(agentId, { archived: false }));
		await owner.mutation(api.contactPoints.remove, { agentId, kind: "phone" });
		await owner.mutation(api.contactPoints.add, { agentId, kind: "phone" });
		await t.run((ctx) => ctx.db.patch(agentId, { archived: true }));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.searches).toHaveLength(1);
	});

	it("does not buy a number after its number manager loses permission", async () => {
		const { t, owner, member } = await ownerAndMember();
		const network = phoneNetwork();
		const { companybot } = await agentsOf(owner);
		const role = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "agents.manage", on: true });
		await member.mutation(api.contactPoints.add, { agentId: companybot._id, kind: "phone" });
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "agents.manage", on: false });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(network.searches).toHaveLength(0);
		expect((await owner.query(api.contactPoints.forAgent, { agentId: companybot._id }))!.phone!.status).toBe("failed");
	});
});
