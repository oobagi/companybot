import { AccessToken } from "livekit-server-sdk";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ActionCtx } from "../convex/_generated/server";
import { agentsOf, ownerAndMember, settle, sideWorkspace, workspaceOf } from "./helpers";

const provider = vi.hoisted(() => ({
	readRecording: vi.fn(),
	deleteRecording: vi.fn(),
	startRecording: vi.fn(),
	stopRecording: vi.fn(),
	reconcileRecording: vi.fn(),
}));
vi.mock("../convex/callRecordingProvider", () => ({ ...provider, recordingConfigured: () => true, RECORDING_MAX_BYTES: 24_000_000, RECORDING_MIME: "audio/mpeg" }));
const processing = vi.hoisted(() => ({ transcribeCall: vi.fn(), summarizeCall: vi.fn() }));
vi.mock("../convex/callProcessingProvider", () => ({ ...processing, isCallProcessingConfigured: () => true }));

const KEY = "test-recording-key";
const SECRET = "test-recording-secret-at-least-32-characters";
const AUDIO = new Uint8Array([73, 68, 51, ...Array.from({ length: 29 }, (_, i) => i)]);
const speech = "The caller asked for an appointment on Tuesday. Staff will confirm by email.";
type Test = Awaited<ReturnType<typeof ownerAndMember>>["t"];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("CONNECTIONS_KEY", "test-private-playback-signing-key");
	vi.stubEnv("CONVEX_SITE_URL", "https://recordings.example");
	vi.stubEnv("LIVEKIT_URL", "https://livekit.example");
	vi.stubEnv("LIVEKIT_API_KEY", KEY);
	vi.stubEnv("LIVEKIT_API_SECRET", SECRET);
	vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
	provider.readRecording.mockReset().mockResolvedValue(new Blob([AUDIO], { type: "audio/mpeg" }));
	provider.deleteRecording.mockReset().mockResolvedValue(undefined);
	provider.startRecording.mockReset().mockResolvedValue("EGrecording");
	provider.stopRecording.mockReset().mockResolvedValue(undefined);
	provider.reconcileRecording.mockReset().mockResolvedValue(null);
	processing.transcribeCall.mockReset().mockResolvedValue({ text: speech, costUsd: 0.006, model: "test-transcription", truncated: false });
	processing.summarizeCall.mockReset().mockResolvedValue({ text: "Appointment requested; staff will confirm by email.", costUsd: 0.001, model: "test-summary" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(ready = true) {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const { companybot } = await agentsOf(owner);
	const room = `cb-call-${crypto.randomUUID()}`;
	const { id, conversationId, storageId, key } = await t.run(async ctx => {
		await ctx.db.patch(workspaceId, { phoneBudgetUsd: 20 });
		const pointId = await ctx.db.insert("contactPoints", { workspaceId, agentId: companybot._id, kind: "phone", address: "+14155550100", status: "active", createdBy: owner.userId });
		const conversationId = await ctx.db.insert("inboxConversations", { workspaceId, agentId: companybot._id, channel: "call", contact: "+14155550199", mode: "staff", lastAt: Date.now(), preview: "Outgoing call" });
		const call = { room, pointId, from: "+14155550100", active: !ready, state: ready ? "completed" as const : "connected" as const, userId: owner.userId, declined: [], connectedAt: Date.now() - 60_000, ...(ready && { endedAt: Date.now() }), rateUsd: 0.05 };
		const id = await ctx.db.insert("inboxMessages", { workspaceId, conversationId, direction: "out", status: "sent", text: "Outgoing call", authorUserId: owner.userId, call });
		const key = `calls/${workspaceId}/${id}.mp3`;
		const storageId = ready ? await ctx.storage.store(new Blob([AUDIO], { type: "audio/mpeg" })) : null;
		if (storageId) {
			await ctx.db.patch(id, { call: { ...call, recording: { key, status: "ready", storageId, egressId: "EGrecording" }, transcript: { status: "ready" }, summary: { status: "ready", text: "Appointment requested; email confirmation pending." } } });
			await ctx.db.insert("callTranscripts", { workspaceId, conversationId, messageId: id, text: speech });
		}
		return { id, conversationId, storageId, key };
	});
	return { t, owner, member, workspaceId, room, id, conversationId, storageId, key };
}

const row = (t: Test, id: Id<"inboxMessages">) => t.run(ctx => ctx.db.get(id));
const pathOf = (url: string) => `${new URL(url).pathname}${new URL(url).search}`;

/** Inject a lost mutation RPC response while the real action, storage and transactions still run. */
type ImportArgs = { id: Id<"inboxMessages">; key: string };
async function importWithAttachmentFailure(t: Test, args: ImportArgs, afterCommit: boolean) {
	const { importAudio } = await import("../convex/callRecordingJobs");
	// Convex exposes the registered handler for its test runtime; no production function is changed.
	const handler = (importAudio as unknown as { _handler: (ctx: ActionCtx, args: ImportArgs) => Promise<void> })._handler;
	return t.action(async ctx => {
		const runMutation: ActionCtx["runMutation"] = async (reference, ...values) => {
			if (getFunctionName(reference) === "callRecordings:imported") {
				if (afterCommit) await ctx.runMutation(reference, ...values);
				throw new Error("Lost attachment mutation response");
			}
			return ctx.runMutation(reference, ...values);
		};
		return handler({ ...ctx, runMutation }, args);
	});
}

async function egressEvent(t: Test, room: string, key: string, { id = "EGrecording", size = AUDIO.byteLength, status = "EGRESS_COMPLETE", secret = SECRET }: { id?: string; size?: number; status?: string; secret?: string } = {}) {
	// Egress webhooks need not include event.room: the room is on egressInfo.
	const body = JSON.stringify({ event: "egress_ended", id: crypto.randomUUID(), egressInfo: { roomName: room, egressId: id, status, fileResults: [{ filename: key, size: String(size), location: "https://untrusted.example/must-not-fetch.mp3" }] } });
	const token = new AccessToken(KEY, secret, { ttl: 60 });
	token.sha256 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))));
	return t.fetch("/phone/events", { method: "POST", body, headers: { authorization: await token.toJwt() } });
}

describe("private call recordings", () => {
	it("serves the saved audio with byte seeking and never exposes a storage URL", async () => {
		const { t, member, id } = await fixture();
		const { url } = await member.action(api.callRecordings.playback, { id });
		expect(new URL(url).pathname).toBe("/phone/recording");
		const full = await t.fetch(pathOf(url));
		expect(full.status).toBe(200);
		expect(full.headers.get("cache-control")).toContain("no-store");
		expect(new Uint8Array(await full.arrayBuffer())).toEqual(AUDIO);
		const range = await t.fetch(pathOf(url), { headers: { Range: "bytes=3-8" } });
		expect(range.status).toBe(206);
		expect(range.headers.get("content-range")).toBe(`bytes 3-8/${AUDIO.byteLength}`);
		expect(new Uint8Array(await range.arrayBuffer())).toEqual(AUDIO.slice(3, 9));
		const tail = await t.fetch(pathOf(url), { headers: { Range: "bytes=-4" } });
		expect(new Uint8Array(await tail.arrayBuffer())).toEqual(AUDIO.slice(-4));
		expect((await t.fetch(pathOf(url), { headers: { Range: `bytes=${AUDIO.length}-` } })).status).toBe(416);
	});

	it("revokes existing playback tickets as soon as Inbox access is removed", async () => {
		const { t, owner, member, id } = await fixture();
		const { url } = await member.action(api.callRecordings.playback, { id });
		expect(await member.action(api.callRecordings.transcript, { id })).toEqual({ text: speech });
		const role = (await owner.query(api.roles.list))!.find(r => r.builtIn === "member")!;
		await owner.mutation(api.roles.setPermission, { id: role.id, permission: "inbox.use", on: false });
		expect((await t.fetch(pathOf(url), { headers: { Range: "bytes=0-3" } })).status).toBe(403);
		await expect(member.action(api.callRecordings.playback, { id })).rejects.toThrow();
		await expect(member.action(api.callRecordings.transcript, { id })).rejects.toThrow();
	});

	it("cannot read another workspace's recording or transcript even as an owner of both", async () => {
		const { t, owner, member, id } = await fixture();
		const { workspaceId } = await sideWorkspace(t, "owner@co.com");
		await expect(owner.in(workspaceId).action(api.callRecordings.playback, { id })).rejects.toThrow();
		await expect(owner.in(workspaceId).action(api.callRecordings.transcript, { id })).rejects.toThrow();
		await expect(member.in(workspaceId).action(api.callRecordings.transcript, { id })).rejects.toThrow();
	});

	it("rejects expired or altered playback tickets", async () => {
		const { t, owner, id } = await fixture();
		const { url } = await owner.action(api.callRecordings.playback, { id });
		const altered = new URL(url);
		altered.searchParams.set("token", `${altered.searchParams.get("token")}changed`);
		expect((await t.fetch(pathOf(altered.toString()))).status).toBe(403);
		vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
		expect((await t.fetch(pathOf(url))).status).toBe(403);
	});

	it("erases saved audio and transcript with their workspace and invalidates its tickets immediately", async () => {
		const { t, owner, id, storageId } = await fixture();
		const { url } = await owner.action(api.callRecordings.playback, { id });
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		expect((await t.fetch(pathOf(url))).status).toBe(403);
		await settle(t);
		expect(await row(t, id)).toBeNull();
		expect(await t.run(ctx => ctx.db.system.get(storageId!))).toBeNull();
		expect(await t.run(ctx => ctx.db.query("callTranscripts").collect())).toHaveLength(0);
	});
});

describe("recording capture and processing ownership", () => {
	it("claims one recording start and accepts one early signed completion for its exact object", async () => {
		const { t, id, room, key } = await fixture(false);
		expect(await t.mutation(internal.callRecordings.claimStart, { id, configured: true })).toEqual({ room, key });
		expect(await t.mutation(internal.callRecordings.claimStart, { id, configured: true })).toBeNull();
		expect((await egressEvent(t, room, key, { secret: "wrong-secret-at-least-32-characters" })).status).toBe(403);
		await egressEvent(t, room, `${key}foreign`);
		expect((await row(t, id))!.call!.recording!.importing).toBeUndefined();
		await egressEvent(t, room, key);
		expect((await row(t, id))!.call!.recording).toMatchObject({ egressId: "EGrecording", importing: true, status: "processing" });
		const queued = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
		await egressEvent(t, room, key);
		await egressEvent(t, room, key, { id: "EGforeign" });
		expect(await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(queued.length);
		expect(await t.mutation(internal.callRecordings.started, { id, egressId: "EGforeign" })).toBe(false);
		expect((await row(t, id))!.call!.recording!.egressId).toBe("EGrecording");
	});

	it.each([[24_000_001, "EGRESS_COMPLETE"], [AUDIO.length, "EGRESS_FAILED"]] as const)("refuses export size %i with outcome %s without making it playable", async (size, status) => {
		const { t, id, room, key } = await fixture(false);
		await t.mutation(internal.callRecordings.claimStart, { id, configured: true });
		await egressEvent(t, room, key, { size, status });
		expect((await row(t, id))!.call!.recording).toMatchObject({ status: "failed" });
		expect((await row(t, id))!.call!.recording!.storageId).toBeUndefined();
	});

	it("leaves the call connected when recording storage is not configured", async () => {
		const { t, id } = await fixture(false);
		expect(await t.mutation(internal.callRecordings.claimStart, { id, configured: false })).toBeNull();
		expect((await row(t, id))!.call).toMatchObject({ active: true, state: "connected", recording: { status: "unavailable" } });
		expect(await t.mutation(internal.callRecordings.claimStart, { id, configured: true })).toBeNull();
	});

	it("discards a completed import if its call disappears while private storage is being read", async () => {
		const { t, id, room, key } = await fixture(false);
		await t.mutation(internal.callRecordings.claimStart, { id, configured: true });
		await t.mutation(internal.callRecordings.egressEnded, { room, key, egressId: "EGrecording", size: AUDIO.length, complete: true });
		const before = await t.run(ctx => ctx.db.system.query("_storage").collect());
		provider.readRecording.mockImplementationOnce(async () => {
			await t.run(ctx => ctx.db.delete(id));
			return new Blob([AUDIO], { type: "audio/mpeg" });
		});
		await t.action(internal.callRecordingJobs.importAudio, { id, key });
		expect(await row(t, id)).toBeNull();
		expect(await t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(before.length);
		expect(provider.deleteRecording).toHaveBeenCalledWith(key);
	});

	it("keeps imported bytes and staging audio when attachment fails before commit, then reuses those bytes on retry", async () => {
		const { t, id, room, key } = await fixture(false);
		await t.mutation(internal.callRecordings.claimStart, { id, configured: true });
		await t.mutation(internal.callRecordings.egressEnded, { room, key, egressId: "EGrecording", size: AUDIO.length, complete: true });
		await importWithAttachmentFailure(t, { id, key }, false);
		expect((await row(t, id))!.call!.recording!.storageId).toBeUndefined();
		const stored = await t.run(ctx => ctx.db.system.query("_storage").collect());
		expect(stored).toHaveLength(1);
		expect(provider.deleteRecording).not.toHaveBeenCalled();
		const jobs = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
		const retry = jobs.find(job => job.name === "callRecordingJobs:importAudio" && job.args[0]?.attempt === 1)!;
		expect(retry.args[0]).toMatchObject({ id, key, attempt: 1, stored: stored[0]!._id });
		await t.action(internal.callRecordingJobs.importAudio, { id, key, attempt: 1, stored: stored[0]!._id });
		expect((await row(t, id))!.call!.recording).toMatchObject({ status: "ready", storageId: stored[0]!._id });
		expect(provider.readRecording).toHaveBeenCalledTimes(1);
		expect(await t.run(ctx => ctx.db.system.query("_storage").collect())).toHaveLength(1);
		expect(provider.deleteRecording).toHaveBeenCalledWith(key);
	});

	it("preserves attached audio when the attachment commits but its response is lost", async () => {
		const { t, id, room, key } = await fixture(false);
		await t.mutation(internal.callRecordings.claimStart, { id, configured: true });
		await t.mutation(internal.callRecordings.egressEnded, { room, key, egressId: "EGrecording", size: AUDIO.length, complete: true });
		await importWithAttachmentFailure(t, { id, key }, true);
		const saved = (await row(t, id))!.call!.recording!;
		expect(saved).toMatchObject({ status: "ready", storageId: expect.any(String) });
		expect(await t.run(ctx => ctx.db.system.get(saved.storageId!))).not.toBeNull();
		const jobs = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
		expect(jobs.filter(job => job.name === "callRecordingJobs:importAudio" && job.args[0]?.stored)).toHaveLength(0);
		expect(provider.readRecording).toHaveBeenCalledTimes(1);
		expect(provider.deleteRecording).toHaveBeenCalledWith(key);
	});

	it("allows one processing owner and preserves its transcript when only the summary needs retrying", async () => {
		const { t, owner, id } = await fixture();
		await t.run(async ctx => {
			const m = (await ctx.db.get(id))!;
			await ctx.db.patch(id, { call: { ...m.call!, summary: { status: "failed", error: "Summary provider unavailable" } } });
		});
		await owner.mutation(api.callRecordings.retry, { id });
		await owner.mutation(api.callRecordings.retry, { id });
		expect((await row(t, id))!.call!.recording!.retries).toBe(1);
		expect(await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "first", configured: true })).not.toBeNull();
		expect(await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "second", configured: true })).toBeNull();
		await t.mutation(internal.callRecordings.processingFailed, { id, attempt: "second" });
		expect((await row(t, id))!.call!.recording!.attempt).toBe("first");
		await t.mutation(internal.callRecordings.processingFailed, { id, attempt: "first" });
		expect((await row(t, id))!.call!.transcript!.status).toBe("ready");
		expect(await owner.action(api.callRecordings.transcript, { id })).toEqual({ text: speech });
		await owner.mutation(api.callRecordings.retry, { id });
		expect(await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "third", configured: true })).not.toBeNull();
		await t.mutation(internal.callRecordings.saveSummary, { id, attempt: "third", text: "Tuesday appointment requested.", costUsd: 0.001, model: "test-summary" });
		await t.mutation(internal.callRecordings.saveSummary, { id, attempt: "third", text: "Duplicate result", costUsd: 0.001, model: "test-summary" });
		expect((await row(t, id))!.call!.summary).toMatchObject({ status: "ready", text: "Tuesday appointment requested." });
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 0.001 });
	});

	it("does not charge twice when a transcription result is delivered more than once", async () => {
		const { t, owner, id } = await fixture();
		await t.run(async ctx => {
			const m = (await ctx.db.get(id))!;
			await ctx.db.patch(id, { call: { ...m.call!, transcript: { status: "pending" }, summary: { status: "pending" } } });
		});
		await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "first", configured: true });
		const result = { id, attempt: "first", text: speech, costUsd: 0.006, model: "test-transcription" };
		await t.mutation(internal.callRecordings.saveTranscript, result);
		await t.mutation(internal.callRecordings.saveTranscript, result);
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 0.006 });
		expect(await t.run(ctx => ctx.db.query("callTranscripts").collect())).toHaveLength(1);
	});

	it("keeps only a bounded excerpt in conversation data while retaining the full transcript", async () => {
		const { t, owner, id, conversationId } = await fixture();
		await t.run(async ctx => {
			const m = (await ctx.db.get(id))!;
			await ctx.db.patch(id, { call: { ...m.call!, transcript: { status: "pending" }, summary: { status: "pending" } } });
		});
		await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "preview", configured: true });
		const text = `  ${"A caller asked about Tuesday.\n\t".repeat(100)}`;
		await t.mutation(internal.callRecordings.saveTranscript, { id, attempt: "preview", text, costUsd: 0.006, model: "test-transcription" });
		const message = (await owner.query(api.inbox.get, { id: conversationId }))!.messages.find(m => m.id === id)!;
		expect(message.call!.transcript).toMatchObject({ text: null, preview: text.replace(/\s+/g, " ").trim().slice(0, 320) });
		expect(await owner.action(api.callRecordings.transcript, { id })).toEqual({ text });
	});

	it("imports private audio, saves its transcript and summary, and accounts for each model once", async () => {
		const { t, owner, id, room, key } = await fixture(false);
		await t.mutation(internal.callRecordings.claimStart, { id, configured: true });
		await t.mutation(internal.callRecordings.egressEnded, { room, key, egressId: "EGrecording", size: AUDIO.length, complete: true });
		await t.action(internal.callRecordingJobs.importAudio, { id, key });
		expect((await row(t, id))!.call!.recording).toMatchObject({ status: "ready", storageId: expect.any(String) });
		await t.action(internal.callRecordingJobs.process, { id });
		await t.action(internal.callRecordingJobs.process, { id });
		expect(processing.transcribeCall).toHaveBeenCalledTimes(1);
		expect(processing.transcribeCall.mock.calls[0]![0]).toEqual(AUDIO);
		expect(processing.summarizeCall).toHaveBeenCalledTimes(1);
		expect(processing.summarizeCall).toHaveBeenCalledWith(speech);
		expect(await owner.action(api.callRecordings.transcript, { id })).toEqual({ text: speech });
		expect((await row(t, id))!.call!.summary).toMatchObject({ status: "ready", text: "Appointment requested; staff will confirm by email." });
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 0.007 });
		expect(provider.deleteRecording).toHaveBeenCalledWith(key);
	});

	it("keeps a successful transcript when summarizing fails and retries only the summary", async () => {
		const { t, owner, id } = await fixture();
		await t.run(async ctx => {
			const m = (await ctx.db.get(id))!;
			await ctx.db.patch(id, { call: { ...m.call!, transcript: { status: "pending" }, summary: { status: "pending" } } });
		});
		processing.summarizeCall.mockRejectedValueOnce(new Error("Provider unavailable"));
		await t.action(internal.callRecordingJobs.process, { id });
		expect((await row(t, id))!.call).toMatchObject({ transcript: { status: "ready" }, summary: { status: "failed" } });
		expect(await owner.action(api.callRecordings.transcript, { id })).toEqual({ text: speech });
		await owner.mutation(api.callRecordings.retry, { id });
		await t.action(internal.callRecordingJobs.process, { id });
		expect(processing.transcribeCall).toHaveBeenCalledTimes(1);
		expect(processing.summarizeCall).toHaveBeenCalledTimes(2);
		expect((await row(t, id))!.call!.summary!.status).toBe("ready");
		expect((await owner.query(api.usage.report, {}))!.byKind).toContainEqual({ kind: "phone", costUsd: 0.251 });
	});

	it("does not claim paid processing when the workspace call budget is zero", async () => {
		const { t, id, workspaceId } = await fixture();
		await t.run(async ctx => {
			await ctx.db.patch(workspaceId, { phoneBudgetUsd: 0 });
			const m = (await ctx.db.get(id))!;
			await ctx.db.patch(id, { call: { ...m.call!, transcript: { status: "pending" }, summary: { status: "pending" } } });
		});
		expect(await t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "first", configured: true })).toBeNull();
		expect((await row(t, id))!.call).toMatchObject({ transcript: { status: "failed" }, summary: { status: "failed" } });
		expect((await row(t, id))!.call!.recording!.attempt).toBeUndefined();
		expect((await row(t, id))!.call!.recording!.processingReserved).toBeUndefined();
	});

	it("reserves processing allowance atomically so concurrent calls cannot exceed the remaining budget", async () => {
		const { t, id, workspaceId } = await fixture();
		const secondId = await t.run(async ctx => {
			await ctx.db.patch(workspaceId, { phoneBudgetUsd: 0.49 });
			const m = (await ctx.db.get(id))!;
			const call = { ...m.call!, transcript: { status: "pending" as const }, summary: { status: "pending" as const } };
			await ctx.db.patch(id, { call });
			const { _id: _messageId, _creationTime: _at, ...base } = m;
			return ctx.db.insert("inboxMessages", { ...base, call: { ...call, room: `${call.room}-second`, recording: { ...call.recording!, key: `${call.recording!.key.slice(0, -4)}-second.mp3` } } });
		});
		const claims = await Promise.all([
			t.mutation(internal.callRecordings.claimProcessing, { id, attempt: "first", configured: true }),
			t.mutation(internal.callRecordings.claimProcessing, { id: secondId, attempt: "second", configured: true }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const reserved = await t.run(ctx => ctx.db.query("inboxMessages").withIndex("by_call_processing", q => q.eq("workspaceId", workspaceId).eq("call.recording.processingReserved", true)).collect());
		expect(reserved).toHaveLength(1);
	});
});
