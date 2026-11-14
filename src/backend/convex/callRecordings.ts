import { can, usageMonth } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { action, mutation, query } from "./functions";
import { liveWorkspace, memberOf, requirePermission } from "./lib";
import { recordUsage } from "./usage";
import { callTranscriptTurn, validTranscriptTurns, type CallTranscriptTurn } from "./callTranscript";

type Message = Doc<"inboxMessages">;
const idArgs = { id: v.id("inboxMessages") };
const MAX_TRANSCRIPT = 120_000;
/** Conservative maximum for 30 minutes of transcription plus a bounded summary. */
export const PROCESSING_HOLD_USD = 0.25;
async function processingBudget(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const workspace = await liveWorkspace(ctx, workspaceId);
	const usage = await ctx.db.query("usage").withIndex("by_month_kind", q => q.eq("workspaceId", workspaceId).eq("month", usageMonth(Date.now())).eq("kind", "phone")).collect();
	const processing = await ctx.db.query("inboxMessages").withIndex("by_call_processing", q => q.eq("workspaceId", workspaceId).eq("call.recording.processingReserved", true)).take(101);
	const active = await ctx.db.query("inboxMessages").withIndex("by_live_call", q => q.eq("workspaceId", workspaceId).eq("call.active", true)).take(11);
	const total = usage.reduce((n, row) => n + row.costUsd, 0) + processing.length * PROCESSING_HOLD_USD + active.reduce((n, row) => n + (row.call?.rateUsd ?? 0) * 31, 0) + PROCESSING_HOLD_USD;
	return processing.length < 100 && Math.round(total * 1e6) <= Math.round((workspace?.phoneBudgetUsd ?? 0) * 1e6);
}

/** Same access as the Inbox conversation, checked again on every audio range request. */
async function available(ctx: QueryCtx, m: Message | null) {
	if (!m?.call || !(await liveWorkspace(ctx, m.workspaceId))) return null;
	const c = await ctx.db.get(m.conversationId);
	return c?.workspaceId === m.workspaceId ? m : null;
}

export const authorize = internalQuery({
	args: { ...idArgs, userId: v.id("users"), workspaceId: v.id("workspaces") },
	handler: async (ctx, { id, userId, workspaceId }) => {
		const member = await memberOf(ctx, userId, workspaceId);
		if (!member || !can(member, "inbox.use")) return null;
		const m = await available(ctx, await ctx.db.get(id));
		return m?.workspaceId === workspaceId ? m : null;
	},
});

export const target = internalQuery({ args: idArgs, handler: async (ctx, { id }) => available(ctx, await ctx.db.get(id)) });

/** A live subscription lets the persistent player release already-buffered audio after access or deletion changes. */
export const availability = query({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId || !ctx.workspaceId) return false;
		const member = await memberOf(ctx, userId, ctx.workspaceId);
		if (!member || !can(member, "inbox.use")) return false;
		const m = await available(ctx, await ctx.db.get(id));
		return m?.workspaceId === ctx.workspaceId && m.call?.recording?.status === "ready" && !!m.call.recording.storageId;
	},
});

/** One server-chosen object key and one start claim; never retry an uncertain paid start. */
export const claimStart = internalMutation({
	args: { ...idArgs, configured: v.boolean() },
	handler: async (ctx, { id, configured }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.active || m.call.state === "ending" || m.call.recording) return null;
		const c = (await ctx.db.get(m.conversationId))!;
		const point = await ctx.db.get(m.call.pointId);
		const agent = await ctx.db.get(c.agentId);
		const caller = m.call.userId ? await memberOf(ctx, m.call.userId, m.workspaceId) : null;
		if (!point || point.status !== "active" || point.workspaceId !== m.workspaceId || point.address !== m.call.from || point.agentId !== c.agentId || !agent || agent.archived || (m.call.userId && (!caller || !can(caller, "inbox.use") || (m.call.memberId && caller.id !== m.call.memberId)))) return null;
		const key = `calls/${m.workspaceId}/${id}.mp3`;
		await ctx.db.patch(id, { call: { ...m.call, recording: { key, status: configured ? "processing" : "unavailable", ...(!configured && { error: "Recording storage is not configured." }) } } });
		return configured ? { room: m.call.room, key } : null;
	},
});

export const started = internalMutation({
	args: { ...idArgs, egressId: v.string() },
	handler: async (ctx, { id, egressId }) => {
		const m = await available(ctx, await ctx.db.get(id));
		const recording = m?.call?.recording;
		if (!m?.call || !recording || (recording.egressId && recording.egressId !== egressId)) return false;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...recording, egressId, ...(!recording.importing && !recording.storageId && { status: "recording" as const }) } } });
		return m.call.active;
	},
});

export const captureFailed = internalMutation({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording || (m.call.recording.status !== "recording" && m.call.recording.status !== "processing")) return;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, status: "failed", error: "Recording could not start. The call itself is unaffected." } } });
	},
});

/** Verified LiveKit events only. File URLs are deliberately ignored. */
export const egressEnded = internalMutation({
	args: { room: v.string(), egressId: v.string(), key: v.string(), size: v.number(), complete: v.boolean() },
	handler: async (ctx, { room, egressId, key, size, complete }) => {
		const m = await ctx.db.query("inboxMessages").withIndex("by_call_room", q => q.eq("call.room", room)).first();
		const recording = m?.call?.recording;
		if (!m) {
			const parts = key.split("/");
			if (parts.length === 3 && parts[0] === "calls" && ctx.db.normalizeId("workspaces", parts[1]!) && parts[2]!.endsWith(".mp3") && ctx.db.normalizeId("inboxMessages", parts[2]!.slice(0, -4))) await ctx.scheduler.runAfter(0, internal.callRecordingJobs.cleanup, { key });
			return;
		}
		if (!m.call || !recording || recording.key !== key || (recording.egressId && recording.egressId !== egressId) || recording.importing || recording.storageId) return;
		if (!(await available(ctx, m))) return;
		if (!complete || size <= 0 || size > 24_000_000) {
			await ctx.db.patch(m._id, { call: { ...m.call, recording: { ...recording, egressId, status: "failed", error: "The recording could not be saved." } } });
			await ctx.scheduler.runAfter(0, internal.callRecordingJobs.cleanup, { key });
			return;
		}
		await ctx.db.patch(m._id, { call: { ...m.call, recording: { ...recording, egressId, importing: true, status: "processing" } } });
		await ctx.scheduler.runAfter(0, internal.callRecordingJobs.importAudio, { id: m._id, key });
	},
});

export const imported = internalMutation({
	args: { ...idArgs, key: v.string(), storageId: v.id("_storage") },
	handler: async (ctx, { id, key, storageId }) => {
		const m = await available(ctx, await ctx.db.get(id));
		const recording = m?.call?.recording;
		if (!m?.call || !recording || recording.key !== key || !recording.importing || recording.storageId) return false;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...recording, status: "ready", storageId, importing: undefined, error: undefined }, transcript: { status: "pending" }, summary: { status: "pending" } } });
		await ctx.scheduler.runAfter(0, internal.callRecordingJobs.process, { id });
		return true;
	},
});

export const importFailed = internalMutation({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording || m.call.recording.storageId) return;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, importing: undefined, status: "failed", error: "The recording could not be retrieved from storage." } } });
	},
});

export const transcriptRow = internalQuery({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m) return null;
		const row = await ctx.db.query("callTranscripts").withIndex("by_message", q => q.eq("messageId", id)).first();
		return row?.workspaceId === m.workspaceId && row.conversationId === m.conversationId ? { text: row.text, turns: row.turns ?? null } : null;
	},
});

export const claimProcessing = internalMutation({
	args: { ...idArgs, attempt: v.string(), configured: v.boolean() },
	handler: async (ctx, { id, attempt, configured }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording?.storageId || m.call.recording.attempt || m.call.summary?.status === "ready") return null;
		const transcriptReady = m.call.transcript?.status === "ready";
		const budget = configured && await processingBudget(ctx, m.workspaceId);
		const error = configured ? "The call budget cannot cover processing. Ask an owner to increase it." : "Transcription and summaries need AI Gateway configuration.";
		configured = configured && budget;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, ...(configured && { attempt, processingReserved: true, processingSpentUsd: 0 }) }, transcript: transcriptReady ? m.call.transcript : { status: configured ? "processing" : "failed", ...(!configured && { error }) }, summary: { status: configured ? "pending" : "failed", ...(!configured && { error }) } } });
		return configured ? m : null;
	},
});

export const saveTranscript = internalMutation({
	args: { ...idArgs, attempt: v.string(), text: v.string(), turns: v.optional(v.array(callTranscriptTurn)), costUsd: v.number(), model: v.string() },
	handler: async (ctx, { id, attempt, text, turns, costUsd, model }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording || m.call.recording.attempt !== attempt || m.call.transcript?.status !== "processing") return false;
		if (text.length > MAX_TRANSCRIPT) throw new ConvexError("The transcript exceeds the supported length.");
		if (turns && !validTranscriptTurns(turns)) throw new ConvexError("The transcript has invalid speaker turns.");
		if (new TextEncoder().encode(JSON.stringify({ text, turns })).length > 900_000) throw new ConvexError("The transcript exceeds the supported storage size.");
		const old = await ctx.db.query("callTranscripts").withIndex("by_message", q => q.eq("messageId", id)).first();
		if (old) await ctx.db.patch(old._id, { text, turns });
		else await ctx.db.insert("callTranscripts", { messageId: id, workspaceId: m.workspaceId, conversationId: m.conversationId, text, turns });
		const excerpt = turns?.length ? turns.map(turn => turn.text).join(" ") : text;
		await ctx.db.patch(id, { call: { ...m.call, transcript: { status: "ready", preview: excerpt.replace(/\s+/g, " ").trim().slice(0, 320) }, summary: { status: text ? "processing" : "ready", ...(!text && { text: "No speech was detected in this recording." }) }, recording: { ...m.call.recording, processingSpentUsd: costUsd, ...(!text && { attempt: undefined, processingReserved: undefined }) } } });
		const c = (await ctx.db.get(m.conversationId))!;
		await recordUsage(ctx, { workspaceId: m.workspaceId, agentId: c.agentId, userId: m.call.userId, kind: "phone", model, costUsd });
		return true;
	},
});

export const saveSummary = internalMutation({
	args: { ...idArgs, attempt: v.string(), text: v.string(), costUsd: v.number(), model: v.string() },
	handler: async (ctx, { id, attempt, text, costUsd, model }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording || m.call.recording.attempt !== attempt) return;
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, attempt: undefined, processingReserved: undefined }, summary: { status: "ready", text: text.slice(0, 4_000) } } });
		const c = (await ctx.db.get(m.conversationId))!;
		await recordUsage(ctx, { workspaceId: m.workspaceId, agentId: c.agentId, userId: m.call.userId, kind: "phone", model, costUsd });
	},
});

export const processingFailed = internalMutation({
	args: { ...idArgs, attempt: v.string(), error: v.optional(v.string()), uncertain: v.optional(v.boolean()) },
	handler: async (ctx, { id, attempt, error, uncertain }) => {
		const m = await available(ctx, await ctx.db.get(id));
		if (!m?.call?.recording || m.call.recording.attempt !== attempt) return;
		if (uncertain && m.call.recording.processingReserved) {
			const c = (await ctx.db.get(m.conversationId))!;
			await recordUsage(ctx, { workspaceId: m.workspaceId, agentId: c.agentId, userId: m.call.userId, kind: "phone", model: "call-processing-uncertain", costUsd: Math.max(0, PROCESSING_HOLD_USD - (m.call.recording.processingSpentUsd ?? 0)) });
		}
		const failure = { status: "failed" as const, error: error ?? "Processing failed. You can retry it." };
		await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, attempt: undefined, processingReserved: undefined }, transcript: m.call.transcript?.status === "ready" ? m.call.transcript : failure, summary: failure } });
	},
});

export async function retryProcessing(ctx: MutationCtx, id: Id<"inboxMessages">, workspaceId: Id<"workspaces">) {
	const m = await available(ctx, await ctx.db.get(id));
	if (!m?.call?.recording?.storageId || m.workspaceId !== workspaceId) throw new ConvexError("Recording not found.");
	if (m.call.recording.attempt || (m.call.transcript?.status !== "failed" && m.call.summary?.status !== "failed")) return;
	if ((m.call.recording.retries ?? 0) >= 3) throw new ConvexError("This call has reached its processing retry limit.");
	if (!process.env.AI_GATEWAY_API_KEY) throw new ConvexError("Transcription and summaries need AI Gateway configuration.");
	if (!(await processingBudget(ctx, workspaceId))) throw new ConvexError("The call budget cannot cover processing. Ask an owner to increase it.");
	await ctx.db.patch(id, { call: { ...m.call, recording: { ...m.call.recording, retries: (m.call.recording.retries ?? 0) + 1 }, transcript: m.call.transcript?.status === "ready" ? m.call.transcript : { status: "pending" }, summary: { status: "pending" } } });
	await ctx.scheduler.runAfter(0, internal.callRecordingJobs.process, { id });
}

export const retry = mutation({ args: idArgs, handler: async (ctx, { id }) => retryProcessing(ctx, id, (await requirePermission(ctx, "inbox.use")).workspaceId) });

type Ticket = { id: Id<"inboxMessages">; userId: Id<"users">; workspaceId: Id<"workspaces">; expires: number };
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const decode = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
async function signingKey() {
	const secret = process.env.CONNECTIONS_KEY;
	if (!secret) throw new ConvexError("Private playback is not configured.");
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export const playback = action({
	args: idArgs,
	handler: async (ctx, { id }): Promise<{ url: string }> => {
		const userId = await getAuthUserId(ctx);
		const workspaceId = ctx.workspaceId;
		if (!userId || !workspaceId) throw new ConvexError("Sign in to play this recording.");
		const m = await ctx.runQuery(internal.callRecordings.authorize, { id, userId, workspaceId });
		if (m?.call?.recording?.status !== "ready") throw new ConvexError("Recording not found.");
		const ticket: Ticket = { id, userId, workspaceId, expires: Date.now() + 5 * 60_000 };
		const data = encode(new TextEncoder().encode(JSON.stringify(ticket)));
		const signature = encode(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), new TextEncoder().encode(data))));
		return { url: `${process.env.CONVEX_SITE_URL}/phone/recording?token=${data}.${signature}` };
	},
});

export const transcript = action({
	args: idArgs,
	handler: async (ctx, { id }): Promise<{ text: string; turns: CallTranscriptTurn[] | null }> => {
		const userId = await getAuthUserId(ctx);
		if (!userId || !ctx.workspaceId || !(await ctx.runQuery(internal.callRecordings.authorize, { id, userId, workspaceId: ctx.workspaceId }))) throw new ConvexError("Transcript not found.");
		const result = await ctx.runQuery(internal.callRecordings.transcriptRow, { id });
		if (result === null) throw new ConvexError("The transcript is not ready yet.");
		if (!(await ctx.runQuery(internal.callRecordings.authorize, { id, userId, workspaceId: ctx.workspaceId }))) throw new ConvexError("Transcript not found.");
		return result;
	},
});

/** No storage URL is exposed. Range requests recheck current membership and Inbox access. */
export const audio = httpAction(async (ctx, request) => {
	let ticket: Ticket;
	try {
		const token = new URL(request.url).searchParams.get("token") ?? "";
		if (token.length > 2_048) throw new Error();
		const [data, signature, extra] = token.split(".");
		if (!data || !signature || extra || !(await crypto.subtle.verify("HMAC", await signingKey(), decode(signature), new TextEncoder().encode(data)))) throw new Error();
		ticket = JSON.parse(new TextDecoder().decode(decode(data)));
		if (!Number.isFinite(ticket.expires) || ticket.expires < Date.now() || ticket.expires > Date.now() + 5 * 60_000) throw new Error();
	} catch { return new Response("Recording unavailable", { status: 403 }); }
	const authorize = () => ctx.runQuery(internal.callRecordings.authorize, { id: ticket.id, userId: ticket.userId, workspaceId: ticket.workspaceId });
	let m;
	try { m = await authorize(); } catch { return new Response("Recording unavailable", { status: 403 }); }
	const storageId = m?.call?.recording?.storageId;
	if (!storageId) return new Response("Recording unavailable", { status: 403 });
	const blob = await ctx.storage.get(storageId);
	if (!blob || blob.size > 24_000_000 || !(await authorize())) return new Response("Recording unavailable", { status: 403 });
	const headers = new Headers({ "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" });
	const range = request.headers.get("Range");
	if (!range) { headers.set("Content-Length", String(blob.size)); return new Response(blob, { headers }); }
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	let start = match?.[1] ? Number(match[1]) : 0;
	let end = match?.[2] ? Number(match[2]) : blob.size - 1;
	if (match && !match[1] && match[2]) { start = Math.max(0, blob.size - Number(match[2])); end = blob.size - 1; }
	if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= blob.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
	end = Math.min(end, blob.size - 1);
	headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
	headers.set("Content-Length", String(end - start + 1));
	return new Response(blob.slice(start, end + 1), { status: 206, headers });
});
