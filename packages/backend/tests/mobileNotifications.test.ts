import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, sideWorkspace } from "./helpers";

const transport = vi.hoisted(() => ({ send: vi.fn(), receipts: vi.fn() }));
vi.mock("expo-server-sdk", () => ({ Expo: class {
	sendPushNotificationsAsync = transport.send;
	getPushNotificationReceiptsAsync = transport.receipts;
} }));
vi.mock("undici", () => ({ Agent: class {} }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const installationId = "1a234567-1234-1234-1234-123456789012";
const token = "ExpoPushToken[example-token]";
const registration = { installationId, token, platform: "ios" as const };

async function fixture() {
	vi.useFakeTimers();
	const world = await ownerAndMember();
	const { t, member } = world;
	const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId: member.userId, expirationTime: Date.now() + 30 * 86_400_000 }));
	const mobile = t.withIdentity({ subject: `${member.userId}|${sessionId}` });
	await mobile.mutation(api.mobileNotifications.register, registration);
	vi.setSystemTime(Date.now() + 10);
	const chatId = await world.owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [] });
	vi.setSystemTime(Date.now() + 10);
	return { ...world, mobile, sessionId, chatId };
}
const deliveries = (t: Awaited<ReturnType<typeof fixture>>["t"]) => t.run((ctx) => ctx.db.query("mobilePushDeliveries").collect());
async function post(f: Awaited<ReturnType<typeof fixture>>, chatId = f.chatId, mentions: { userIds: Id<"users">[]; agentIds: Id<"agents">[] } = noMentions, threadId?: Id<"chatMessages">) {
	const messageId = await f.owner.mutation(api.messages.send, { chatId, text: "Private financial discussion", mentions, ...(threadId && { threadId }) });
	await f.t.mutation(internal.mobileNotifications.enqueue, { messageId });
	return messageId;
}

describe("native notification registration and privacy", () => {
	it("requires a live session and never exposes tokens through status", async () => {
		const f = await fixture();
		expect(await f.mobile.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: true });
		expect(await f.t.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: false });
		await expect(f.t.mutation(api.mobileNotifications.register, registration)).rejects.toThrow("Not signed in");
		await f.t.run((ctx) => ctx.db.delete(f.sessionId));
		expect(await f.mobile.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: false });
		await expect(f.mobile.mutation(api.mobileNotifications.register, registration)).rejects.toThrow("Sign in again");
	});

	it("bounds registration churn, validates input, and supports multiple installations", async () => {
		const f = await fixture();
		await expect(f.mobile.mutation(api.mobileNotifications.register, { ...registration, installationId: "guessable" })).rejects.toThrow("Invalid installation");
		await expect(f.mobile.mutation(api.mobileNotifications.register, { ...registration, token: "not-a-token" })).rejects.toThrow("Invalid push token");
		for (let i = 0; i < 11; i++) await f.mobile.mutation(api.mobileNotifications.register, { ...registration, installationId: `2a234567-1234-1234-1234-${String(i).padStart(12, "0")}`, token: `ExpoPushToken[device-${i}]` });
		expect((await f.t.run((ctx) => ctx.db.query("mobilePushDevices").collect())).length).toBe(10);
		for (let i = 0; i < 18; i++) await f.mobile.mutation(api.mobileNotifications.register, registration);
		await expect(f.mobile.mutation(api.mobileNotifications.register, registration)).rejects.toThrow("Too many notification changes");
	});

	it("enqueues once per device, respects read state and permits an authorized tap after reading", async () => {
		const f = await fixture();
		const messageId = await post(f);
		await f.t.mutation(internal.mobileNotifications.enqueue, { messageId });
		const [delivery] = await deliveries(f.t);
		expect((await deliveries(f.t)).length).toBe(1);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toMatchObject({ chatId: f.chatId, messageId });
		vi.setSystemTime(Date.now() + 10);
		await f.member.mutation(api.chats.markRead, { chatId: f.chatId });
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toMatchObject({ messageId });
	});

	it("matches desktop mentions-only and off settings, including thread links", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const prefs = await ctx.db.query("preferences").withIndex("by_user", (q) => q.eq("userId", f.member.userId)).first();
			if (prefs) await ctx.db.patch(prefs._id, { notify: "mentions" });
			else await ctx.db.insert("preferences", { userId: f.member.userId, notify: "mentions", displayName: "", sendWith: "enter" });
		});
		const parent = await post(f);
		expect(await deliveries(f.t)).toEqual([]);
		const general = (await generalOf(f.owner))._id;
		const root = await post(f, general);
		const reply = await post(f, general, { userIds: [f.member.userId], agentIds: [] }, root);
		const [delivery] = await deliveries(f.t);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toMatchObject({ messageId: reply, threadId: root, chatId: general });
		await f.t.run(async (ctx) => { const pref = (await ctx.db.query("preferences").withIndex("by_user", (q) => q.eq("userId", f.member.userId)).first())!; await ctx.db.patch(pref._id, { notify: "off" }); });
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
		await post(f, f.chatId, { userIds: [f.member.userId], agentIds: [] }, parent);
		expect((await deliveries(f.t)).length).toBe(1);
	});

	it.each(["session", "workspace", "chat", "message", "archived"] as const)("rechecks %s revocation at dispatch and tap", async (revocation) => {
		const f = await fixture();
		const messageId = await post(f);
		const [delivery] = await deliveries(f.t);
		await f.t.run(async (ctx) => {
			if (revocation === "session") await ctx.db.delete(f.sessionId);
			if (revocation === "workspace") { const row = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", f.member.userId)).first(); await ctx.db.delete(row!._id); }
			if (revocation === "chat") { const row = await ctx.db.query("chatMembers").withIndex("by_user", (q) => q.eq("userId", f.member.userId).eq("chatId", f.chatId)).first(); await ctx.db.delete(row!._id); }
			if (revocation === "message") await ctx.db.patch(messageId, { deleted: true });
			if (revocation === "archived") await ctx.db.patch(f.chatId, { archived: true });
		});
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
	});

	it.each(["channel access", "member roles", "artifact source"] as const)("rechecks %s for queued pushes, badges, alerts and taps", async (revocation) => {
		const f = await fixture();
		const office = await f.owner.mutation(api.roles.create, { name: "Office" });
		const basic = (await f.owner.query(api.roles.list))!.find((role) => role.name === "Member")!.id;
		const membership = (await f.owner.query(api.workspace.team))!.members.find((row) => row.userId === f.member.userId)!;
		await f.owner.mutation(api.workspace.setRoles, { id: membership.id, roles: [basic, office] });
		const channel = await f.owner.mutation(api.chats.createChannel, { name: "office", private: false });
		await f.owner.mutation(api.chats.join, { chatId: channel });
		await f.member.mutation(api.chats.join, { chatId: channel });
		await f.owner.mutation(api.chats.setAccess, { chatId: channel, access: [{ role: office, level: "view" }] });
		const chatId = revocation === "artifact source" ? f.chatId : channel;
		if (revocation === "artifact source") await f.t.run((ctx) => ctx.db.patch(chatId, { usedPlaces: [channel] }));
		vi.setSystemTime(Date.now() + 10);
		await post(f, chatId, { userIds: [f.member.userId], agentIds: [] });
		const [delivery] = await deliveries(f.t);
		expect(delivery).toBeDefined();
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(1);
		expect((await f.member.query(api.chats.alerts))!.some((alert) => alert.chatId === chatId)).toBe(true);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toMatchObject({ chatId });

		if (revocation === "member roles") await f.owner.mutation(api.workspace.setRoles, { id: membership.id, roles: [basic] });
		else await f.owner.mutation(api.chats.setAccess, { chatId: channel, access: [] });
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(0);
		expect((await f.member.query(api.chats.alerts))!.some((alert) => alert.chatId === chatId)).toBe(false);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
		await post(f, chatId, { userIds: [f.member.userId], agentIds: [] });
		expect(await deliveries(f.t)).toHaveLength(1);
	});

	it("does not retarget queued jobs after token rotation or an account switch", async () => {
		const f = await fixture();
		await post(f);
		await f.mobile.mutation(api.mobileNotifications.register, { ...registration, token: "ExpoPushToken[rotated]" });
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
		const ownerSession = await f.t.run((ctx) => ctx.db.insert("authSessions", { userId: f.owner.userId, expirationTime: Date.now() + 86_400_000 }));
		const other = f.t.withIdentity({ subject: `${f.owner.userId}|${ownerSession}` });
		await other.mutation(api.mobileNotifications.register, registration);
		expect(await f.mobile.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: false });
		await f.mobile.mutation(api.mobileNotifications.unregister, { installationId });
		expect(await other.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: true });
		const [delivery] = await deliveries(f.t);
		expect(await other.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
	});

	it("queues completed agent replies, never their streaming or unpublished quiet drafts", async () => {
		const f = await fixture();
		const { companybot } = await agentsOf(f.member);
		const dm = await f.member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const turnId: Id<"agentTurns"> = await agentTurn(f.t, f.member, dm, companybot._id);
		const turn = await f.t.run((ctx) => ctx.db.get(turnId));
		const replyId = turn!.replyId!;
		await f.t.mutation(internal.mobileNotifications.enqueue, { messageId: replyId });
		expect(await deliveries(f.t)).toEqual([]);
		await f.t.mutation(internal.turns.updateReply, { turnId, text: "Done", parts: [{ type: "text", text: "Done" }] });
		await f.t.mutation(internal.turns.finishReply, { turnId });
		const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(jobs.some((job) => job.name === "mobileNotifications:enqueue" && (job.args[0] as { messageId: string }).messageId === replyId)).toBe(true);
		await f.t.mutation(internal.mobileNotifications.enqueue, { messageId: replyId });
		expect((await deliveries(f.t)).map((d) => d.messageId)).toEqual([replyId]);
		// Hidden side work remains hidden even if its message is marked done.
		const quiet = await f.t.run(async (ctx) => {
			const reply = (await ctx.db.get(replyId))!;
			const { _id, _creationTime, ...fields } = reply;
			return ctx.db.insert("chatMessages", { ...fields, quiet: true });
		});
		await f.t.mutation(internal.mobileNotifications.enqueue, { messageId: quiet });
		expect((await deliveries(f.t)).length).toBe(1);
	});

	it("rejects stale routes after unregister and malformed delivery identifiers", async () => {
		const f = await fixture();
		await post(f);
		const [delivery] = await deliveries(f.t);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: "https://attacker.invalid" })).toBeNull();
		await f.mobile.mutation(api.mobileNotifications.unregister, { installationId });
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
		expect((await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" }))?.jobs).toEqual([]);
	});
});

describe("native notification transport", () => {
	it("sends generic text and an opaque route, then checks receipts after 15 minutes", async () => {
		const f = await fixture();
		const messageId = await post(f);
		transport.send.mockResolvedValue([{ status: "ok", id: "ticket-1" }]);
		await f.t.action(internal.mobilePush.send, {});
		const [delivery] = await deliveries(f.t);
		expect(transport.send).toHaveBeenCalledWith([{ to: token, title: "Companybot", body: "You have a new message.", data: { deliveryId: delivery!._id }, badge: 1, channelId: "messages", sound: "default", ttl: 3600, tag: delivery!._id, collapseId: delivery!._id }]);
		expect(JSON.stringify(transport.send.mock.calls)).not.toContain(messageId);
		expect(delivery).toMatchObject({ state: "receipt", ticketId: "ticket-1" });
		await f.t.action(internal.mobilePush.receipts, {});
		expect(transport.receipts).not.toHaveBeenCalled();
		vi.setSystemTime(Date.now() + 15 * 60_000 + 100);
		transport.receipts.mockResolvedValue({ "ticket-1": { status: "ok" } });
		await f.t.action(internal.mobilePush.receipts, {});
		expect(transport.receipts).toHaveBeenCalledWith(["ticket-1"]);
		expect((await deliveries(f.t))[0]?.state).toBe("done");
	});

	it("removes unregistered tokens but never removes a replacement token based on an old receipt", async () => {
		const f = await fixture();
		await post(f);
		transport.send.mockResolvedValue([{ status: "ok", id: "old-ticket" }]);
		await f.t.action(internal.mobilePush.send, {});
		await f.mobile.mutation(api.mobileNotifications.register, { ...registration, token: "ExpoPushToken[new-token]" });
		vi.setSystemTime(Date.now() + 15 * 60_000 + 100);
		transport.receipts.mockResolvedValue({ "old-ticket": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } });
		await f.t.action(internal.mobilePush.receipts, {});
		expect(await f.mobile.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: true });
		await post(f);
		transport.send.mockResolvedValue([{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }]);
		await f.t.action(internal.mobilePush.send, {});
		expect(await f.mobile.query(api.mobileNotifications.status, { installationId })).toEqual({ enabled: false });
	});

	it("bounds concurrent dispatch, recovers crashed leases, and retries transient errors", async () => {
		const f = await fixture();
		await post(f);
		const claimed = await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" });
		expect(claimed?.jobs.length).toBe(1);
		expect(await f.t.mutation(internal.mobileNotifications.claim, { kind: "send" })).toBeNull();
		vi.setSystemTime(Date.now() + 11 * 60_000 + 100);
		transport.send.mockRejectedValue({ statusCode: 503 });
		await f.t.action(internal.mobilePush.send, {});
		expect((await deliveries(f.t))[0]).toMatchObject({ state: "pending", attempts: 2 });
		vi.setSystemTime(Date.now() + 120_100);
		transport.send.mockResolvedValue([{ status: "ok", id: "retry-ticket" }]);
		await f.t.action(internal.mobilePush.send, {});
		expect((await deliveries(f.t))[0]).toMatchObject({ state: "receipt", attempts: 3 });
	});

	it("waits for missing receipts and retries a transient provider rejection as a new send", async () => {
		const f = await fixture();
		await post(f);
		transport.send.mockResolvedValue([{ status: "ok", id: "ticket" }]);
		await f.t.action(internal.mobilePush.send, {});
		vi.setSystemTime(Date.now() + 15 * 60_000 + 100);
		transport.receipts.mockResolvedValue({});
		await f.t.action(internal.mobilePush.receipts, {});
		expect((await deliveries(f.t))[0]?.state).toBe("receipt");
		vi.setSystemTime(Date.now() + 15 * 60_000 + 100);
		transport.receipts.mockResolvedValue({ ticket: { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } } });
		await f.t.action(internal.mobilePush.receipts, {});
		expect((await deliveries(f.t))[0]).toMatchObject({ state: "pending", attempts: 1 });
		expect((await deliveries(f.t))[0]?.ticketId).toBeUndefined();
	});

	it("expires delivery routes and prunes their token snapshots", async () => {
		const f = await fixture();
		await post(f);
		const [delivery] = await deliveries(f.t);
		vi.setSystemTime(Date.now() + 86_400_001);
		expect(await f.mobile.query(api.mobileNotifications.resolve, { deliveryId: delivery!._id })).toBeNull();
		await f.t.mutation(internal.mobileNotifications.sweep, {});
		expect(await deliveries(f.t)).toEqual([]);
	});
});

describe("shared desktop and native badge count", () => {
	it("counts chats once, respects mentions-only/off, and includes mentions in an otherwise read thread", async () => {
		const f = await fixture();
		await post(f);
		await post(f);
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(1);
		expect((await f.member.query(api.chats.alerts))?.length).toBe(1);
		await f.mobile.mutation(api.preferences.update, { notify: "mentions" });
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(0);
		const general = (await generalOf(f.owner))._id;
		const root = await post(f, general);
		vi.setSystemTime(Date.now() + 10);
		await f.member.mutation(api.chats.markRead, { chatId: general });
		vi.setSystemTime(Date.now() + 10);
		await post(f, general, { userIds: [f.member.userId], agentIds: [] }, root);
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(1);
		expect((await f.member.query(api.chats.alerts))?.length).toBe(1);
		vi.setSystemTime(Date.now() + 10);
		await f.member.mutation(api.chats.markRead, { chatId: general });
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(0);
		await f.mobile.mutation(api.preferences.update, { notify: "off" });
		vi.setSystemTime(Date.now() + 10);
		await post(f, f.chatId, { userIds: [f.member.userId], agentIds: [] });
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(0);
		expect((await f.member.query(api.chats.alerts))?.length).toBe(0);
	});

	it("adds visible workspaces and stops counting a retained chat seat after leaving", async () => {
		const f = await fixture();
		await post(f);
		const other = await sideWorkspace(f.t, "owner@co.com");
		const seat = await f.t.run(ctx => ctx.db.insert("members", { userId: f.member.userId, workspaceId: other.workspaceId, email: "member@co.com", role: "member" }));
		const chatId = await f.owner.in(other.workspaceId).mutation(api.chats.openDm, { userIds: [f.member.userId], agentIds: [] });
		vi.setSystemTime(Date.now() + 10);
		await f.owner.in(other.workspaceId).mutation(api.messages.send, { chatId, text: "Another workspace", mentions: noMentions });
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(2);
		expect((await f.member.query(api.chats.alerts))?.length).toBe(1);
		await f.t.run(ctx => ctx.db.delete(seat));
		expect(await f.mobile.query(api.mobileNotifications.badge, {})).toBe(1);
		expect(await f.t.query(api.mobileNotifications.badge, {})).toBe(0);
	});
});
