import { getAuthSessionId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { alertCount } from "./alertOps";
import { membership, shownAt } from "./chatOps";
import { mutation, query } from "./functions";
import { authUserId, memberOf, preferencesOf, requireUserId } from "./lib";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LEASE = 11 * MINUTE; // Longer than Convex's maximum action duration; no overlapping dispatcher.
const BATCH = 50;
const MAX_ATTEMPTS = 5;
const installation = v.string();
const kind = v.union(v.literal("send"), v.literal("receipt"));
type Delivery = Doc<"mobilePushDeliveries">;

function checkInstallation(id: string) {
	if (id.length > 128 || !/^[a-zA-Z0-9_-]{32,128}$/.test(id.replaceAll("-", ""))) throw new ConvexError("Invalid installation id.");
}

async function sessionIsLive(ctx: QueryCtx, userId: Id<"users">, sessionId: Id<"authSessions">) {
	const session = await ctx.db.get(sessionId);
	const user = await ctx.db.get(userId);
	return !!user && !user.erasedAt && session?.userId === userId && session.expirationTime > Date.now();
}

async function rateLimit(ctx: MutationCtx, userId: Id<"users">) {
	const row = await ctx.db.query("mobilePushLimits").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
	const now = Date.now();
	if (row && now - row.windowAt < MINUTE) {
		if (row.count >= 30) throw new ConvexError("Too many notification changes. Try again in a minute.");
		await ctx.db.patch(row._id, { count: row.count + 1 });
	} else if (row) await ctx.db.patch(row._id, { windowAt: now, count: 1 });
	else await ctx.db.insert("mobilePushLimits", { userId, windowAt: now, count: 1 });
}

/** Account-scoped, despite accepting the app's normal optional workspace argument. */
export const register = mutation({
	args: { installationId: installation, token: v.string(), platform: v.union(v.literal("ios"), v.literal("android")) },
	handler: async (ctx, args) => {
		checkInstallation(args.installationId);
		// Equivalent to Expo's token form, with a length bound before any storage or network call.
		if (!/^(Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]|[a-fA-F0-9-]{36})$/.test(args.token) || args.token.length > 256) throw new ConvexError("Invalid push token.");
		const userId = await requireUserId(ctx);
		const sessionId = await getAuthSessionId(ctx);
		if (!sessionId || !(await sessionIsLive(ctx, userId, sessionId))) throw new ConvexError("Sign in again to enable notifications.");
		await rateLimit(ctx, userId);
		const existing = await ctx.db.query("mobilePushDevices").withIndex("by_installation", (q) => q.eq("installationId", args.installationId)).unique();
		const sameToken = await ctx.db.query("mobilePushDevices").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
		// Never leave a token attached to two accounts/installs. Old jobs keep their original user/session/token.
		if (sameToken && sameToken._id !== existing?._id) await ctx.db.delete(sameToken._id);
		const value = { ...args, userId, sessionId, updatedAt: Date.now() };
		const devices = (await ctx.db.query("mobilePushDevices").withIndex("by_user", (q) => q.eq("userId", userId)).take(11)).filter((device) => device._id !== existing?._id);
		if (devices.length >= 10) await ctx.db.delete(devices.toSorted((a, b) => a.updatedAt - b.updatedAt)[0]!._id);
		if (existing) await ctx.db.patch(existing._id, value);
		else await ctx.db.insert("mobilePushDevices", value);
		return null;
	},
});

export const unregister = mutation({
	args: { installationId: installation },
	handler: async (ctx, { installationId }) => {
		const userId = await requireUserId(ctx);
		const sessionId = await getAuthSessionId(ctx);
		const device = await ctx.db.query("mobilePushDevices").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique();
		if (device?.userId === userId && device.sessionId === sessionId) await ctx.db.delete(device._id);
		return null;
	},
});

export const status = query({
	args: { installationId: installation },
	handler: async (ctx, { installationId }) => {
		const userId = await authUserId(ctx);
		const sessionId = await getAuthSessionId(ctx);
		if (!userId || !sessionId || !(await sessionIsLive(ctx, userId, sessionId))) return { enabled: false };
		const device = await ctx.db.query("mobilePushDevices").withIndex("by_installation", (q) => q.eq("installationId", installationId)).unique();
		return { enabled: device?.userId === userId && device.sessionId === sessionId };
	},
});

/** Account-wide, using the same notification preferences and read semantics as desktop. */
export const badge = query({
	args: {},
	handler: async (ctx) => {
		const userId = await authUserId(ctx);
		return userId ? alertCount(ctx, userId) : 0;
	},
});
export const badgeForUser = internalQuery({
	args: { userId: v.id("users") },
	handler: (ctx, { userId }) => alertCount(ctx, userId),
});

/** Visibility is checked at enqueue, dispatch and tap; delivery ids are never authorization. */
async function visibleMessage(ctx: QueryCtx, userId: Id<"users">, messageId: Id<"chatMessages">) {
	const message = await ctx.db.get(messageId);
	if (!message || message.deleted || message.quiet || message.status !== "done") return null;
	const chat = await ctx.db.get(message.chatId);
	if (!chat || chat.archived || chat.workspaceId !== message.workspaceId || !(await memberOf(ctx, userId, chat.workspaceId))) return null;
	const seat = await membership(ctx, chat._id, userId);
	// Match desktop alerts: public channel membership is required too.
	if (!seat || seat.workspaceId !== chat.workspaceId) return null;
	if (message.threadId) {
		const parent = await ctx.db.get(message.threadId);
		if (!parent || parent.quiet || parent.chatId !== chat._id || parent.workspaceId !== chat.workspaceId) return null;
	}
	return { message, chat, seat };
}

async function eligible(ctx: QueryCtx, userId: Id<"users">, messageId: Id<"chatMessages">) {
	const visible = await visibleMessage(ctx, userId, messageId);
	if (!visible || visible.message.authorUserId === userId) return null;
	const { message, chat, seat } = visible;
	const preference = (await preferencesOf(ctx, userId))?.notify ?? "all";
	if (preference === "off") return null;
	const since = seat.lastReadAt ?? 0;
	const mention = await ctx.db.query("userMentions").withIndex("by_message", (q) => q.eq("messageId", messageId).eq("userId", userId)).first();
	if (mention && mention.at > since) return visible;
	return preference === "all" && chat.kind === "dm" && !message.threadId && shownAt(message) > since ? visible : null;
}

export const resolve = query({
	args: { deliveryId: v.string() },
	handler: async (ctx, { deliveryId }) => {
		const id = ctx.db.normalizeId("mobilePushDeliveries", deliveryId);
		const userId = await authUserId(ctx);
		const sessionId = await getAuthSessionId(ctx);
		if (!id || !userId || !sessionId || !(await sessionIsLive(ctx, userId, sessionId))) return null;
		const delivery = await ctx.db.get(id);
		if (!delivery || delivery.userId !== userId || delivery.sessionId !== sessionId || delivery.expiresAt <= Date.now()) return null;
		const device = await ctx.db.get(delivery.deviceId);
		if (!device || device.userId !== userId || device.sessionId !== sessionId) return null;
		const visible = await visibleMessage(ctx, userId, delivery.messageId);
		if (!visible || visible.chat._id !== delivery.chatId || visible.chat.workspaceId !== delivery.workspaceId) return null;
		return { workspaceId: delivery.workspaceId, chatId: delivery.chatId, messageId: delivery.messageId, ...(visible.message.threadId && { threadId: visible.message.threadId }) };
	},
});

/** Runs after the message transaction commits, including its mention index and mark-read writes. */
export const enqueue = internalMutation({
	args: { messageId: v.id("chatMessages"), cursor: v.optional(v.string()) },
	handler: async (ctx, { messageId, cursor }) => {
		const message = await ctx.db.get(messageId);
		if (!message || message.deleted || message.quiet || message.status !== "done" || shownAt(message) < Date.now() - 60 * MINUTE) return;
		const seats = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", message.chatId)).paginate({ cursor: cursor ?? null, numItems: 25 });
		for (const seat of seats.page) {
			if (!seat.userId || !(await eligible(ctx, seat.userId, messageId))) continue;
			const devices = await ctx.db.query("mobilePushDevices").withIndex("by_user", (q) => q.eq("userId", seat.userId!)).take(10);
			for (const device of devices) {
				if (!(await sessionIsLive(ctx, device.userId, device.sessionId))) continue;
				if (await ctx.db.query("mobilePushDeliveries").withIndex("by_message_device", (q) => q.eq("messageId", messageId).eq("deviceId", device._id)).first()) continue;
				await ctx.db.insert("mobilePushDeliveries", {
					deviceId: device._id, userId: device.userId, sessionId: device.sessionId, token: device.token,
					workspaceId: message.workspaceId, chatId: message.chatId, messageId,
					state: "pending", attempts: 0, nextAttemptAt: Date.now(), expiresAt: Date.now() + DAY,
				});
			}
		}
		if (!seats.isDone) await ctx.scheduler.runAfter(0, internal.mobileNotifications.enqueue, { messageId, cursor: seats.continueCursor });
	},
});

async function canSend(ctx: QueryCtx, delivery: Delivery) {
	const device = await ctx.db.get(delivery.deviceId);
	if (!device || device.userId !== delivery.userId || device.sessionId !== delivery.sessionId || device.token !== delivery.token || device.updatedAt < Date.now() - 30 * DAY) return false;
	if (!(await sessionIsLive(ctx, delivery.userId, delivery.sessionId))) return false;
	const visible = await eligible(ctx, delivery.userId, delivery.messageId);
	return !!visible && visible.chat._id === delivery.chatId && visible.chat.workspaceId === delivery.workspaceId && shownAt(visible.message) > Date.now() - 60 * MINUTE;
}

export const claim = internalMutation({
	args: { kind },
	handler: async (ctx, { kind }) => {
		const now = Date.now();
		const worker = await ctx.db.query("mobilePushWorkers").withIndex("by_kind", (q) => q.eq("kind", kind)).unique();
		if (worker && worker.leaseUntil > now) return null;
		const lease = now + LEASE;
		if (worker) await ctx.db.patch(worker._id, { leaseUntil: lease });
		else await ctx.db.insert("mobilePushWorkers", { kind, leaseUntil: lease });
		const rows = await ctx.db.query("mobilePushDeliveries").withIndex("by_state_time", (q) => q.eq("state", kind === "send" ? "pending" : "receipt").lte("nextAttemptAt", now)).take(BATCH);
		if (kind === "send" && rows.length < BATCH) rows.push(...await ctx.db.query("mobilePushDeliveries").withIndex("by_state_time", (q) => q.eq("state", "sending").lte("nextAttemptAt", now)).take(BATCH - rows.length));
		const jobs: { id: Id<"mobilePushDeliveries">; userId: Id<"users">; token: string; ticketId?: string }[] = [];
		for (const row of rows) {
			if (row.expiresAt <= now || (kind === "send" && (row.attempts >= MAX_ATTEMPTS || !(await canSend(ctx, row))))) {
				await ctx.db.patch(row._id, { state: "done" });
				continue;
			}
			await ctx.db.patch(row._id, { state: kind === "send" ? "sending" : "receipt", nextAttemptAt: lease, attempts: row.attempts + (kind === "send" ? 1 : 0) });
			jobs.push({ id: row._id, userId: row.userId, token: row.token, ...(row.ticketId && { ticketId: row.ticketId }) });
		}
		return { lease, jobs };
	},
});

const result = v.object({ id: v.id("mobilePushDeliveries"), outcome: v.union(v.literal("ok"), v.literal("retry"), v.literal("resend"), v.literal("failed"), v.literal("unregistered")), ticketId: v.optional(v.string()) });
export const complete = internalMutation({
	args: { kind, lease: v.number(), results: v.array(result) },
	handler: async (ctx, { kind, lease, results }) => {
		for (const result of results) {
			const row = await ctx.db.get(result.id);
			if (!row || row.nextAttemptAt !== lease || row.state !== (kind === "send" ? "sending" : "receipt")) continue;
			if (result.outcome === "unregistered") {
				const device = await ctx.db.get(row.deviceId);
				if (device?.token === row.token && device.userId === row.userId && device.sessionId === row.sessionId) await ctx.db.delete(device._id);
			}
			if (result.outcome === "resend" && row.attempts < MAX_ATTEMPTS && row.expiresAt > Date.now()) {
				await ctx.db.patch(row._id, { state: "pending", ticketId: undefined, nextAttemptAt: Date.now() + MINUTE });
			} else if (result.outcome === "retry" && row.expiresAt > Date.now() && (kind === "receipt" || row.attempts < MAX_ATTEMPTS)) {
				await ctx.db.patch(row._id, { state: kind === "send" ? "pending" : "receipt", nextAttemptAt: Date.now() + (kind === "receipt" ? 15 * MINUTE : Math.min(15 * MINUTE, 30_000 * 2 ** row.attempts)) });
			} else if (kind === "send" && result.outcome === "ok" && result.ticketId) {
				await ctx.db.patch(row._id, { state: "receipt", ticketId: result.ticketId, nextAttemptAt: Date.now() + 15 * MINUTE });
			} else await ctx.db.patch(row._id, { state: "done" });
		}
		const worker = await ctx.db.query("mobilePushWorkers").withIndex("by_kind", (q) => q.eq("kind", kind)).unique();
		if (worker?.leaseUntil === lease) await ctx.db.patch(worker._id, { leaseUntil: 0 });
	},
});

/** Bounded retention. Revocation is enforced immediately by lookups; this removes stale storage. */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const deliveries = await ctx.db.query("mobilePushDeliveries").withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now())).take(200);
		const devices = await ctx.db.query("mobilePushDevices").withIndex("by_updated", (q) => q.lte("updatedAt", Date.now() - 30 * DAY)).take(100);
		const limits = await ctx.db.query("mobilePushLimits").withIndex("by_window", (q) => q.lte("windowAt", Date.now() - DAY)).take(100);
		for (const row of [...deliveries, ...devices, ...limits]) await ctx.db.delete(row._id);
		// Drain a backlog in bounded transactions; retention must keep up with the send throughput.
		if (deliveries.length === 200 || devices.length === 100 || limits.length === 100) await ctx.scheduler.runAfter(0, internal.mobileNotifications.sweep, {});
	},
});
