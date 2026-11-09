import { can, normalizePhone, usageMonth } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { conversationWith, linkRecord, recordShown } from "./inbox";
import { type Member, type Who, checkPermission, getMember, liveWorkspace, memberOf, nameOf, requireInWorkspace, requireLiveAgent, requirePermission } from "./lib";
import { requireRecord } from "./recordOps";
import { recordUsage } from "./usage";

// Calls use the Inbox's conversation, message, comments and record link. Only media crosses LiveKit.
// Like image generation, admission holds the maximum cost against a monthly budget, then settles usage.
export const CALL_SECONDS = 30 * 60;
const RING_MS = 30_000;
const HOLD_MINUTES = 31; // Include ringing and provider rounding.
type Message = Doc<"inboxMessages">;
type Call = NonNullable<Message["call"]>;
export const voiceReady = () => !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET && process.env.LIVEKIT_SIP_INBOUND_TRUNK && process.env.LIVEKIT_SIP_OUTBOUND_TRUNK && process.env.TWILIO_ACCOUNT_SID && rate() > 0);
const rate = () => { const n = Number(process.env.PHONE_RATE_USD_PER_MINUTE); return Number.isFinite(n) && n > 0 ? n : 0; };
const live = (ctx: QueryCtx, workspaceId: Id<"workspaces">) => ctx.db.query("inboxMessages").withIndex("by_live_call", (q) => q.eq("workspaceId", workspaceId).eq("call.active", true)).take(11);
const inRoom = (ctx: QueryCtx, room: string) => ctx.db.query("inboxMessages").withIndex("by_call_room", (q) => q.eq("call.room", room)).first();
const shown = (m: Message) => ({ id: m._id, conversationId: m.conversationId, direction: m.direction, state: m.call!.state, connectedAt: m.call!.connectedAt ?? null, endedAt: m.call!.endedAt ?? null, at: m._creationTime });

async function phonesOf(ctx: QueryCtx, record: Doc<"records">) {
	const fields = await ctx.db.query("recordFields").withIndex("by_type_kind", (q) => q.eq("typeId", record.typeId).eq("kind", "phone")).take(20);
	return [...new Set(fields.filter((f) => !f.archived).flatMap((f) => { const value = record.values[f.key]; return (Array.isArray(value) ? value : [value]).flatMap((v) => typeof v === "string" ? normalizePhone(v) ?? [] : []); }))];
}

async function budget(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const workspace = await liveWorkspace(ctx, workspaceId);
	const spent = await ctx.db.query("usage").withIndex("by_month_kind", (q) => q.eq("workspaceId", workspaceId).eq("month", usageMonth(Date.now())).eq("kind", "phone")).collect();
	const active = await live(ctx, workspaceId);
	return !!workspace && active.length < 10 && rate() > 0 && Math.round((spent.reduce((n, r) => n + r.costUsd, 0) + active.reduce((n, m) => n + m.call!.rateUsd * HOLD_MINUTES, 0) + rate() * HOLD_MINUTES) * 1e6) <= Math.round((workspace.phoneBudgetUsd ?? 0) * 1e6);
}

async function allowed(ctx: QueryCtx, m: Message) {
	const c = await ctx.db.get(m.conversationId);
	const point = m.call && await ctx.db.get(m.call.pointId);
	const agent = c && await ctx.db.get(c.agentId);
	if (!c || !(await liveWorkspace(ctx, m.workspaceId)) || !agent || agent.archived || !point || point.status !== "active" || point.address !== m.call?.from || point.agentId !== c.agentId || point.workspaceId !== m.workspaceId) return false;
	if (!m.call?.userId) return true;
	const member = await memberOf(ctx, m.call.userId, m.workspaceId);
	return !!member && member.id === m.call.memberId && can(member, "inbox.use");
}

async function requireCall(ctx: QueryCtx, member: Member, id: Id<"inboxMessages">) {
	checkPermission(member, "inbox.use");
	const m = requireInWorkspace(member, await ctx.db.get(id), "Call");
	if (!m.call) throw new ConvexError("Call not found.");
	return m;
}

async function make(ctx: MutationCtx, point: Doc<"contactPoints">, to: string, direction: "in" | "out", room: string, who?: Who, recordId?: Id<"records">) {
	let c = await conversationWith(ctx, point.workspaceId, point.agentId, "call", to);
	if (!c) {
		const id = await ctx.db.insert("inboxConversations", { workspaceId: point.workspaceId, agentId: point.agentId, channel: "call", contact: to, mode: "staff", lastAt: Date.now(), preview: "", ...(recordId && { recordId }) });
		c = (await ctx.db.get(id))!;
		await linkRecord(ctx, c);
	}
	const id = await ctx.db.insert("inboxMessages", { workspaceId: point.workspaceId, conversationId: c._id, direction, status: "sent", text: direction === "in" ? "Incoming call" : "Outgoing call", ...(who && { authorUserId: who.member.userId, ...(who.agentId && { authorAgentId: who.agentId }) }), call: { room, pointId: point._id, from: point.address, active: true, state: "ringing", declined: [], rateUsd: rate(), ...(who && { userId: who.member.userId, memberId: who.member.id }) } });
	await ctx.db.patch(c._id, { lastAt: Date.now(), preview: direction === "in" ? "Incoming call" : "Outgoing call" });
	await ctx.scheduler.runAfter(10_000, internal.calls.watch, { id, room });
	return id;
}

export async function startCall(ctx: MutationCtx, who: Who, args: { agentId: Id<"agents">; to: string; recordId?: Id<"records"> }) {
	checkPermission(who.member, "inbox.use");
	await requireLiveAgent(ctx, who.member, args.agentId);
	if (!voiceReady()) throw new ConvexError("Calling isn't set up on this server.");
	const to = normalizePhone(args.to);
	if (!to) throw new ConvexError("Include the phone number's country code.");
	if (args.recordId) {
		const record = await requireRecord(ctx, who.member, args.recordId);
		if (record.archived) throw new ConvexError("That record is archived.");
		if (!(await phonesOf(ctx, record)).includes(to)) throw new ConvexError("Choose a phone number on this person's record, or use the Keypad for a different person.");
	}
	const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", args.agentId).eq("kind", "phone")).first();
	if (point?.status !== "active" || point.address === to) throw new ConvexError("Choose an agent with an active number and a different number to call.");
	if ((await live(ctx, who.member.workspaceId)).some((m) => m.call?.userId === who.member.userId)) throw new ConvexError("Finish your current call first.");
	if (!(await budget(ctx, who.member.workspaceId))) throw new ConvexError("The monthly call budget cannot cover this call. An owner can change it in General settings.");
	return make(ctx, point, to, "out", `cb-call-${crypto.randomUUID()}`, who, args.recordId);
}

export const start = mutation({
	args: { agentId: v.id("agents"), to: v.string(), recordId: v.optional(v.id("records")) },
	handler: async (ctx, args) => startCall(ctx, { member: await requirePermission(ctx, "inbox.use") }, args),
});

/** Current call plus incoming rings. No presence table: only signed-in, authorized clients subscribe. */
export const current = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !can(member, "inbox.use")) return null;
		const rows = (await live(ctx, member.workspaceId)).filter((m) => m.call!.userId === member.userId || (!m.call!.userId && !m.call!.declined.includes(member.userId)));
		const calls = [];
		for (const m of rows) {
			if (!(await allowed(ctx, m))) continue;
			const c = await ctx.db.get(m.conversationId);
			const record = c && await recordShown(ctx, member, c.recordId);
			if (c) calls.push({ ...shown(m), mine: m.call!.userId === member.userId, contact: c.contact, name: c.contactName ?? record?.title ?? c.contact, agentId: c.agentId });
		}
		return { available: voiceReady(), calls };
	},
});

export const numbers = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !can(member, "inbox.use")) return [];
		const points = await ctx.db.query("contactPoints").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).take(100);
		const result = [];
		for (const p of points) {
			if (p.kind !== "phone" || p.status !== "active") continue;
			const a = await ctx.db.get(p.agentId);
			if (a && !a.archived) result.push({ agentId: a._id, name: a.name, number: p.address });
		}
		return result;
	},
});

export const forRecord = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const record = await requireRecord(ctx, member, recordId);
		const cs = await ctx.db.query("inboxConversations").withIndex("by_record", (q) => q.eq("recordId", recordId)).take(20);
		const rows = (await Promise.all(cs.filter((c) => c.channel === "call").map((c) => ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(20)))).flat();
		return { phones: await phonesOf(ctx, record), calls: await Promise.all(rows.filter((m) => m.call).sort((a, b) => b._creationTime - a._creationTime).slice(0, 20).map(async (m) => ({ ...shown(m), by: m.call?.userId ? await nameOf(ctx, m.call.userId) : null }))) };
	},
});

/** Claim incoming pickup atomically. Joining a microphone is a person's device consent. */
export const join = mutation({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const m = await requireCall(ctx, member, id);
		if (!m.call!.active || m.call!.state === "ending" || !(await allowed(ctx, m))) throw new ConvexError("This call has ended.");
		if (m.call!.userId && m.call!.userId !== member.userId) throw new ConvexError("Someone else answered this call.");
		if ((await live(ctx, member.workspaceId)).some((other) => other._id !== id && other.call?.userId === member.userId)) throw new ConvexError("Finish your current call first.");
		await ctx.db.patch(id, { call: { ...m.call!, userId: member.userId, memberId: member.id }, authorUserId: member.userId });
		return { room: m.call!.room, identity: `staff-${member.userId}` };
	},
});

export const ready = mutation({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const m = await requireCall(ctx, member, id);
		if (!m.call!.active || m.call!.state !== "ringing" || m.call!.userId !== member.userId || !(await allowed(ctx, m))) throw new ConvexError("This call isn't yours to connect.");
		if (m.direction === "in") await ctx.db.patch(id, { call: { ...m.call!, state: "connected", connectedAt: Date.now() } });
		else if (!m.call!.dispatched) await ctx.scheduler.runAfter(0, internal.phoneProvider.dial, { id });
	},
});

export const claimDial = internalMutation({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const m = await ctx.db.get(id);
		if (!m?.call?.active || m.call.dispatched || m.call.state !== "ringing") return null;
		if (!(await allowed(ctx, m))) { await stop(ctx, m); return null; }
		const c = (await ctx.db.get(m.conversationId))!;
		await ctx.db.patch(id, { call: { ...m.call, dispatched: true } });
		return { room: m.call.room, to: c.contact, from: m.call.from };
	},
});

export async function endCall(ctx: MutationCtx, member: Member, id: Id<"inboxMessages">) {
	const m = await requireCall(ctx, member, id);
	if (m.call!.userId !== member.userId) throw new ConvexError("Only the person on this call can hang it up.");
	await stop(ctx, m);
}

export const end = mutation({ args: { id: v.id("inboxMessages") }, handler: async (ctx, { id }) => endCall(ctx, await requirePermission(ctx, "inbox.use"), id) });
export const decline = mutation({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const m = await requireCall(ctx, member, id);
		if (m.direction === "in" && m.call!.active && !m.call!.userId && !m.call!.declined.includes(member.userId)) await ctx.db.patch(id, { call: { ...m.call!, declined: [...m.call!.declined, member.userId].slice(-100) } });
	},
});

async function stop(ctx: MutationCtx, m: Message) {
	if (!m.call?.active || m.call.state === "ending") return;
	await ctx.db.patch(m._id, { call: { ...m.call, state: "ending" } });
	await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room: m.call.room, id: m._id });
}

export const watch = internalMutation({
	args: { id: v.id("inboxMessages"), room: v.string() },
	handler: async (ctx, { id, room }) => {
		const m = await ctx.db.get(id);
		if (!m?.call) return void await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room });
		if (!m.call.active) {
			if (m.call.state === "unknown") await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room });
			return;
		}
		const age = Date.now() - m._creationTime;
		if (!(await allowed(ctx, m)) || age >= CALL_SECONDS * 1000 || (!m.call.connectedAt && age >= RING_MS)) return stop(ctx, m);
		await ctx.scheduler.runAfter(10_000, internal.calls.watch, { id, room });
	},
});

async function finish(ctx: MutationCtx, m: Message, uncertain = false) {
	if (!m.call?.active) return;
	const now = Date.now();
	const state = uncertain ? "unknown" : m.call.connectedAt !== undefined ? "completed" : m.direction === "in" ? "missed" : "failed";
	await ctx.db.patch(m._id, { call: { ...m.call, active: false, state, endedAt: now } });
	const c = await ctx.db.get(m.conversationId);
	if (c && await liveWorkspace(ctx, m.workspaceId)) {
		await ctx.db.patch(c._id, { lastAt: now, preview: `${m.direction === "in" ? "Incoming" : "Outgoing"} call: ${state}` });
		await recordUsage(ctx, { workspaceId: m.workspaceId, agentId: c.agentId, userId: m.call.userId, kind: "phone", costUsd: m.call.rateUsd * (uncertain ? HOLD_MINUTES : m.call.connectedAt !== undefined || m.call.dispatched ? Math.min(HOLD_MINUTES, Math.max(1, Math.ceil((now - m._creationTime) / 60_000))) : 0) });
	}
}

export const closed = internalMutation({
	args: { id: v.id("inboxMessages"), uncertain: v.optional(v.boolean()) },
	handler: async (ctx, { id, uncertain }) => { const m = await ctx.db.get(id); if (m) await finish(ctx, m, uncertain); },
});

export const connected = internalMutation({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const m = await ctx.db.get(id);
		if (!m?.call?.active) return false;
		if (!(await allowed(ctx, m)) || m.call.state === "ending") { await stop(ctx, m); return false; }
		if (!m.call.connectedAt) await ctx.db.patch(id, { call: { ...m.call, state: "connected", connectedAt: Date.now() } });
		return true;
	},
});

/** Only phoneProvider passes verified LiveKit events here. Unknown rooms/numbers are closed. */
export const event = internalMutation({
	args: { event: v.string(), room: v.string(), identity: v.string(), sip: v.boolean(), attributes: v.record(v.string(), v.string()) },
	handler: async (ctx, { event, room, identity, sip, attributes }) => {
		let m = await inRoom(ctx, room);
		if (!m && (event === "participant_joined" || event === "participant_connection_aborted") && sip) {
			const to = normalizePhone(attributes["sip.trunkPhoneNumber"] ?? "");
			const from = normalizePhone(attributes["sip.phoneNumber"] ?? "");
			const point = to && await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", "phone").eq("address", to)).first();
			const agent = point && await ctx.db.get(point.agentId);
			if (!voiceReady() || attributes["sip.trunkID"] !== process.env.LIVEKIT_SIP_INBOUND_TRUNK || attributes["sip.twilio.accountSid"] !== process.env.TWILIO_ACCOUNT_SID || !point || point.status !== "active" || !from || !agent || agent.archived || !(await liveWorkspace(ctx, point.workspaceId))) return void await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room });
			const admitted = await budget(ctx, point.workspaceId);
			const id = await make(ctx, point, from, "in", room);
			m = await ctx.db.get(id);
			if (!admitted && m) {
				await finish(ctx, m);
				return void await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room });
			}
		}
		if (!m?.call?.active) return;
		if (event === "room_finished" || event === "participant_connection_aborted" || (event === "participant_left" && (sip || identity === `staff-${m.call.userId}`))) {
			await finish(ctx, m);
			await ctx.scheduler.runAfter(0, internal.phoneProvider.close, { room });
		}
	},
});
