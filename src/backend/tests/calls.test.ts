import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, ownerAndMember, signIn, workspaceOf } from "./helpers";

const FROM = "+15125550100";
const TO = "+15125550199";
const KEY = "test-livekit-key";
const SECRET = "test-livekit-secret-at-least-32-characters";
type Test = Awaited<ReturnType<typeof ownerAndMember>>["t"];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("LIVEKIT_URL", "wss://livekit.example");
	vi.stubEnv("LIVEKIT_API_KEY", KEY);
	vi.stubEnv("LIVEKIT_API_SECRET", SECRET);
	vi.stubEnv("LIVEKIT_SIP_INBOUND_TRUNK", "STin");
	vi.stubEnv("LIVEKIT_SIP_OUTBOUND_TRUNK", "STout");
	vi.stubEnv("TWILIO_ACCOUNT_SID", "ACphone");
	vi.stubEnv("PHONE_RATE_USD_PER_MINUTE", "0.05");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(budget = 20) {
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const workspaceId = await workspaceOf(owner);
	await t.run((ctx) => ctx.db.insert("contactPoints", { workspaceId, agentId: companybot._id, kind: "phone", address: FROM, status: "active", createdBy: owner.userId }));
	const settings = (await owner.query(api.workspace.settings))!;
	await owner.mutation(api.workspace.updateSettings, { name: settings.name, expectedVersion: settings.version, phoneBudgetUsd: budget });
	const requests: { path: string; body: Record<string, unknown> }[] = [];
	let failDial = false;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const path = new URL(request.url).pathname;
		const body = JSON.parse(await request.text()) as Record<string, unknown>;
		requests.push({ path, body });
		if (path.endsWith("/CreateSIPParticipant")) {
			if (failDial) throw new Error("Connection lost after create");
			return Response.json({ participantIdentity: "caller", roomName: body.roomName, sipCallId: "SCtest" });
		}
		if (path.endsWith("/DeleteRoom")) return Response.json({});
		throw new Error(`Unexpected provider request ${path}`);
	});
	return { t, owner, member, workspaceId, agentId: companybot._id, requests, loseDialResponse: () => { failDial = true; } };
}

async function event(t: Test, kind: string, room: string, { sip = true, identity = "caller", attributes = {}, secret = SECRET }: { sip?: boolean; identity?: string; attributes?: Record<string, string>; secret?: string } = {}) {
	const body = JSON.stringify({ event: kind, id: crypto.randomUUID(), room: { name: room }, participant: { identity, kind: sip ? "SIP" : "STANDARD", attributes: { "sip.trunkID": "STin", "sip.trunkPhoneNumber": FROM, "sip.phoneNumber": TO, "sip.twilio.accountSid": "ACphone", ...attributes } } });
	const token = new AccessToken(KEY, secret, { ttl: 60 });
	token.sha256 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))));
	return t.fetch("/phone/events", { method: "POST", body, headers: { authorization: await token.toJwt() } });
}

const row = (t: Test, id: Id<"inboxMessages">) => t.run((ctx) => ctx.db.get(id));

describe("staff calls in Inbox", () => {
	it("dials once from the selected agent after microphone consent and uses the ordinary conversation history", async () => {
		const { t, owner, agentId, requests } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		expect(requests).toHaveLength(0);
		const token = await owner.action(api.phoneProvider.join, { id });
		const claims = await new TokenVerifier(KEY, SECRET).verify(token.token);
		expect(claims.video).toMatchObject({ room: (await row(t, id))!.call!.room, roomJoin: true, canPublishSources: ["microphone"] });
		expect(claims.video?.roomAdmin).not.toBe(true);
		await owner.mutation(api.calls.ready, { id });
		await owner.mutation(api.calls.ready, { id });
		await t.action(internal.phoneProvider.dial, { id });
		await t.action(internal.phoneProvider.dial, { id });
		expect(requests.filter((r) => r.path.endsWith("/CreateSIPParticipant"))).toHaveLength(1);
		expect(requests[0]!.body).toMatchObject({ sipTrunkId: "STout", sipCallTo: TO, sipNumber: FROM });
		expect((await row(t, id))!.call!.state).toBe("connected");
		const c = (await owner.query(api.inbox.list))![0]!;
		expect(c.channel).toBe("call");
		expect((await owner.query(api.inbox.get, { id: c.id }))!.messages).toHaveLength(1);
		vi.setSystemTime(Date.now() + 120_000);
		await owner.mutation(api.calls.end, { id });
		await t.action(internal.phoneProvider.close, { id, room: (await row(t, id))!.call!.room });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await row(t, id))!.call).toMatchObject({ state: "completed", active: false });
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 0.1 });
	});

	it("rings authorized staff, has one pickup winner, and does not wake a Public agent", async () => {
		const { t, owner, member } = await fixture();
		const room = "cb-call-incoming";
		expect((await event(t, "participant_joined", room)).status).toBe(204);
		await event(t, "participant_joined", room);
		const ring = (await member.query(api.calls.current))!.calls[0]!;
		expect((await owner.query(api.inbox.get, { id: ring.conversationId }))!.messages).toHaveLength(1);
		await expect(owner.mutation(api.inbox.assign, { id: ring.conversationId, to: "agent" })).rejects.toThrow();
		expect(ring.mine).toBe(false);
		expect((await owner.query(api.inbox.list))).toHaveLength(1);
		await member.mutation(api.calls.join, { id: ring.id });
		await expect(owner.mutation(api.calls.join, { id: ring.id })).rejects.toThrow();
		await member.mutation(api.calls.ready, { id: ring.id });
		expect((await row(t, ring.id))!.authorUserId).toBe(member.userId);
		expect(await t.run((ctx) => ctx.db.query("agentTurns").collect())).toHaveLength(0);
		await event(t, "participant_left", room);
		expect((await row(t, ring.id))!.call!.state).toBe("completed");
	});

	it("a personal decline leaves the call ringing for teammates, then logs one missed call", async () => {
		const { t, owner, member } = await fixture();
		await event(t, "participant_joined", "cb-call-declined");
		const ring = (await member.query(api.calls.current))!.calls[0]!;
		await member.mutation(api.calls.decline, { id: ring.id });
		expect((await member.query(api.calls.current))!.calls).toHaveLength(0);
		expect((await owner.query(api.calls.current))!.calls).toHaveLength(1);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await row(t, ring.id))!.call).toMatchObject({ state: "missed", active: false });
		expect((await owner.query(api.inbox.get, { id: ring.conversationId }))!.messages).toHaveLength(1);
	});

	it("refuses unsigned, forged and tampered events and rejects foreign trunks and accounts", async () => {
		const { t, owner } = await fixture();
		expect((await t.fetch("/phone/events", { method: "POST", body: "{}" })).status).toBe(403);
		expect((await event(t, "participant_joined", "cb-call-forged", { secret: "wrong-signing-secret-32-characters" })).status).toBe(403);
		await event(t, "participant_joined", "cb-call-trunk", { attributes: { "sip.trunkID": "STforeign" } });
		await event(t, "participant_joined", "cb-call-account", { attributes: { "sip.twilio.accountSid": "ACforeign" } });
		expect(await owner.query(api.inbox.list)).toHaveLength(0);
	});

	it("checks workspace, record visibility and current Inbox access before giving media credentials", async () => {
		const { t, owner, member, agentId } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		const other = await signIn(t, "outsider@phone.test");
		await expect(other.action(api.phoneProvider.join, { id })).rejects.toThrow();
		await expect(other.mutation(api.calls.start, { agentId, to: TO })).rejects.toThrow();
		const role = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "inbox.use", on: false });
		expect(await member.query(api.calls.current)).toBeNull();
		await expect(member.action(api.phoneProvider.join, { id })).rejects.toThrow();
	});

	it("holds concurrent calls against the existing monthly spend pattern and keeps zero-budget calling off", async () => {
		const { owner, member, agentId } = await fixture(0);
		await expect(owner.mutation(api.calls.start, { agentId, to: TO })).rejects.toThrow();
		const s = (await owner.query(api.workspace.settings))!;
		await owner.mutation(api.workspace.updateSettings, { name: s.name, expectedVersion: s.version, phoneBudgetUsd: 2.17 });
		await expect(member.mutation(api.workspace.updateSettings, { name: s.name, expectedVersion: s.version, phoneBudgetUsd: 50 })).rejects.toThrow();
		vi.stubEnv("PHONE_RATE_USD_PER_MINUTE", "0.07");
		await owner.mutation(api.calls.start, { agentId, to: TO });
		await expect(member.mutation(api.calls.start, { agentId, to: "+15125550200" })).rejects.toThrow();
	});

	it("a lost dial response stays uncertain, spends the hold conservatively, and is never dialed twice", async () => {
		const { t, owner, agentId, loseDialResponse, requests } = await fixture();
		loseDialResponse();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		await owner.mutation(api.calls.join, { id });
		await owner.mutation(api.calls.ready, { id });
		await t.action(internal.phoneProvider.dial, { id });
		await t.action(internal.phoneProvider.dial, { id });
		expect(requests.filter((r) => r.path.endsWith("/CreateSIPParticipant"))).toHaveLength(1);
		expect((await row(t, id))!.call!.state).toBe("unknown");
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 1.55 });
	});

	it("keeps a claimed dial from repeating after an action crashes", async () => {
		const { t, owner, agentId, requests } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		await owner.mutation(api.calls.join, { id });
		await owner.mutation(api.calls.ready, { id });
		expect(await t.mutation(internal.calls.claimDial, { id })).not.toBeNull();
		await t.action(internal.phoneProvider.dial, { id });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(requests.some((r) => r.path.endsWith("/CreateSIPParticipant"))).toBe(false);
		expect((await row(t, id))!.call!.active).toBe(false);
	});

	it("logs a budget-rejected incoming call as missed without offering pickup", async () => {
		const { t, owner } = await fixture(0);
		await event(t, "participant_joined", "cb-call-no-budget");
		expect((await owner.query(api.calls.current))!.calls).toHaveLength(0);
		const c = (await owner.query(api.inbox.list))![0]!;
		expect((await owner.query(api.inbox.get, { id: c.id }))!.messages[0]!.call!.state).toBe("missed");
	});

	it("does not dial a number released after the call was prepared", async () => {
		const { t, owner, agentId, requests } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		await owner.mutation(api.calls.join, { id });
		await owner.mutation(api.calls.ready, { id });
		await owner.mutation(api.contactPoints.remove, { agentId, kind: "phone" });
		await t.action(internal.phoneProvider.dial, { id });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(requests.some((r) => r.path.endsWith("/CreateSIPParticipant"))).toBe(false);
		expect((await row(t, id))!.call!.active).toBe(false);
	});

	it("ends when the staff participant disconnects and does not double-count repeated end events", async () => {
		const { t, owner, agentId } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		await owner.mutation(api.calls.join, { id });
		await owner.mutation(api.calls.ready, { id });
		await t.action(internal.phoneProvider.dial, { id });
		const room = (await row(t, id))!.call!.room;
		await event(t, "participant_left", room, { sip: false, identity: "someone-else" });
		expect((await row(t, id))!.call!.active).toBe(true);
		await event(t, "participant_left", room, { sip: false, identity: `staff-${owner.userId}` });
		const used = (await owner.query(api.usage.report, {}))!.total;
		await event(t, "room_finished", room);
		await event(t, "participant_left", room);
		expect((await row(t, id))!.call!.active).toBe(false);
		expect((await owner.query(api.usage.report, {}))!.total).toBe(used);
	});

	it("revocation and removing a number close active media rather than letting it continue indefinitely", async () => {
		const { t, owner, member, agentId, requests } = await fixture();
		const id = await member.mutation(api.calls.start, { agentId, to: TO });
		await member.mutation(api.calls.join, { id });
		await member.mutation(api.calls.ready, { id });
		await t.action(internal.phoneProvider.dial, { id });
		const role = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "inbox.use", on: false });
		await t.mutation(internal.calls.watch, { id, room: (await row(t, id))!.call!.room });
		expect((await row(t, id))!.call!.state).toBe("ending");
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await row(t, id))!.call!.active).toBe(false);
		expect(requests.some((r) => r.path.endsWith("/DeleteRoom"))).toBe(true);
	});

	it("closes the provider room after workspace deletion and ignores late completion", async () => {
		const { t, owner, agentId, requests } = await fixture();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO });
		const room = (await row(t, id))!.call!.room;
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await row(t, id)).toBeNull();
		expect(requests.some((r) => r.path.endsWith("/DeleteRoom") && r.body.room === room)).toBe(true);
		await event(t, "room_finished", room);
		expect(await t.run((ctx) => ctx.db.query("inboxMessages").collect())).toHaveLength(0);
	});

	it("links the call to the person's existing record and keeps call history behind both access gates", async () => {
		const { t, owner, agentId } = await fixture();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "People" });
		await owner.mutation(api.fields.create, { typeId, label: "Phone", kind: "phone" });
		const person = await owner.mutation(api.records.create, { typeId, values: { name: "Dana", phone: TO } });
		await expect(owner.mutation(api.calls.start, { agentId, to: "+15125550999", recordId: person })).rejects.toThrow();
		const id = await owner.mutation(api.calls.start, { agentId, to: TO, recordId: person });
		expect((await owner.query(api.calls.forRecord, { recordId: person })).calls[0]).toMatchObject({ id, direction: "out", state: "ringing" });
		const stranger = await signIn(t, "elsewhere@phone.test");
		await expect(stranger.query(api.calls.forRecord, { recordId: person })).rejects.toThrow();
	});

	it("agent-requested calls use Inbox management, reserve once, and wait for the person's microphone", async () => {
		const { t, owner, agentId, requests } = await fixture();
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
		const turnId = await agentTurn(t, owner, dm, agentId);
		const result = await t.mutation(internal.manageTools.runFor, { turnId, tool: "inbox.manage", input: { request: { action: "call", agentId, to: TO } } });
		expect(result).toHaveProperty("callId");
		expect(requests).toHaveLength(0);
		expect((await owner.query(api.calls.current))!.calls).toHaveLength(1);
	});
});
