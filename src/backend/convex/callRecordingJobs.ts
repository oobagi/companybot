"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { deleteRecording, readRecording, reconcileRecording, recordingConfigured, startRecording, stopRecording } from "./callRecordingProvider";
import { isCallProcessingConfigured, summarizeCall, transcribeCall } from "./callProcessingProvider";

const idArgs = { id: v.id("inboxMessages") };

export const start = internalAction({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const claim = await ctx.runMutation(internal.callRecordings.claimStart, { id, configured: recordingConfigured() });
		if (!claim) return;
		let egressId;
		try { egressId = await startRecording(claim.room, claim.key); }
		catch {
			// A lost response may have started recording. Only reconcile; never issue another start.
			await ctx.scheduler.runAfter(5_000, internal.callRecordingJobs.check, { id, checks: 0 });
			return;
		}
		if (!(await ctx.runMutation(internal.callRecordings.started, { id, egressId }))) {
			if (await ctx.runQuery(internal.callRecordings.target, { id })) {
				await stopRecording(egressId);
				await ctx.scheduler.runAfter(30_000, internal.callRecordingJobs.check, { id, checks: 0 });
			} else await ctx.runAction(internal.callRecordingJobs.cleanup, { key: claim.key, egressId });
			return;
		}
		await ctx.scheduler.runAfter(30_000, internal.callRecordingJobs.check, { id, checks: 0 });
	},
});

/** Recovers missed callbacks as well as uncertain start responses, without another paid start. */
export const check = internalAction({
	args: { ...idArgs, checks: v.number() },
	handler: async (ctx, { id, checks }) => {
		const m = await ctx.runQuery(internal.callRecordings.target, { id });
		const recording = m?.call?.recording;
		if (!m?.call || !recording || recording.storageId || recording.importing) return;
		try {
			const found = await reconcileRecording(m.call.room, recording.key);
			if (found) {
				const active = await ctx.runMutation(internal.callRecordings.started, { id, egressId: found.id });
				if (found.status >= 3) {
					await ctx.runMutation(internal.callRecordings.egressEnded, { room: m.call.room, egressId: found.id, key: recording.key, complete: found.status === 3, size: 1 });
					return;
				}
				if (!active) await stopRecording(found.id);
			} else if (checks >= 2 && !recording.egressId) {
				await ctx.runMutation(internal.callRecordings.captureFailed, { id });
				return;
			}
		} catch { /* A bounded watchdog retries reads, never starts or model calls. */ }
		if (checks < 64) await ctx.scheduler.runAfter(30_000, internal.callRecordingJobs.check, { id, checks: checks + 1 });
		else await ctx.runMutation(internal.callRecordings.captureFailed, { id });
	},
});

export const importAudio = internalAction({
	args: { ...idArgs, key: v.string(), attempt: v.optional(v.number()), stored: v.optional(v.id("_storage")) },
	handler: async (ctx, { id, key, attempt = 0, stored }): Promise<void> => {
		const m = await ctx.runQuery(internal.callRecordings.target, { id });
		const recording = m?.call?.recording;
		if (!recording || recording.key !== key || recording.storageId) {
			if (stored && recording?.storageId !== stored) await ctx.storage.delete(stored);
			await ctx.runAction(internal.callRecordingJobs.cleanup, { key });
			return;
		}
		let storageId = stored;
		try {
			if (!storageId) {
				const blob = await readRecording(key);
				const latest = await ctx.runQuery(internal.callRecordings.target, { id });
				if (!latest?.call?.recording || latest.call.recording.storageId) {
					await ctx.runAction(internal.callRecordingJobs.cleanup, { key });
					return;
				}
				storageId = await ctx.storage.store(blob);
			}
			const attached = await ctx.runMutation(internal.callRecordings.imported, { id, key, storageId });
			if (!attached) {
				const latest = await ctx.runQuery(internal.callRecordings.target, { id });
				if (latest?.call?.recording?.storageId !== storageId) await ctx.storage.delete(storageId);
			}
			await ctx.runAction(internal.callRecordingJobs.cleanup, { key });
		} catch {
			// An attachment may have committed despite a lost response. Never delete its file blindly.
			let latest;
			try { latest = await ctx.runQuery(internal.callRecordings.target, { id }); }
			catch {
				await ctx.scheduler.runAfter(30_000, internal.callRecordingJobs.importAudio, { id, key, attempt, ...(storageId && { stored: storageId }) });
				return;
			}
			if (latest?.call?.recording?.storageId) {
				if (storageId && latest.call.recording.storageId !== storageId) await ctx.storage.delete(storageId);
				await ctx.runAction(internal.callRecordingJobs.cleanup, { key });
				return;
			}
			if (latest && attempt < 2) {
				await ctx.scheduler.runAfter(5_000 * (attempt + 1), internal.callRecordingJobs.importAudio, { id, key, attempt: attempt + 1, ...(storageId && { stored: storageId }) });
				return;
			}
			if (storageId) await ctx.storage.delete(storageId);
			await ctx.runMutation(internal.callRecordings.importFailed, { id });
			await ctx.runAction(internal.callRecordingJobs.cleanup, { key });
		}
	},
});

/** Single claimed model attempt, with no automatic paid retries after timeouts. */
export const process = internalAction({
	args: idArgs,
	handler: async (ctx, { id }) => {
		const attempt = crypto.randomUUID();
		const m = await ctx.runMutation(internal.callRecordings.claimProcessing, { id, attempt, configured: isCallProcessingConfigured() });
		if (!m?.call?.recording?.storageId) return;
		await ctx.scheduler.runAfter(5 * 60_000, internal.callRecordings.processingFailed, { id, attempt, error: "Processing timed out. A manual retry may incur another charge.", uncertain: true });
		let paidPending = false;
		try {
			let text = m.call.transcript?.status === "ready" ? (await ctx.runQuery(internal.callRecordings.transcriptRow, { id }))?.text ?? null : null;
			if (text === null) {
				const audio = await ctx.storage.get(m.call.recording.storageId);
				if (!audio) throw new Error("Recording unavailable");
				if (!(await ctx.runQuery(internal.callRecordings.target, { id }))) return;
				paidPending = true;
				const result = await transcribeCall(new Uint8Array(await audio.arrayBuffer()), audio.type, m.call.connectedAt === undefined ? undefined : Math.max(0, ((m.call.endedAt ?? Date.now()) - m.call.connectedAt) / 1000));
				if (result.truncated) {
					await ctx.runMutation(internal.usage.record, { workspaceId: m.workspaceId, userId: m.call.userId, kind: "phone", model: result.model, costUsd: result.costUsd });
					await ctx.runMutation(internal.callRecordings.processingFailed, { id, attempt, error: "The transcript exceeded the supported length. The recording is still available." });
					return;
				}
				if (!(await ctx.runMutation(internal.callRecordings.saveTranscript, { id, attempt, text: result.text, ...(result.turns && { turns: result.turns }), costUsd: result.costUsd, model: result.model }))) return;
				paidPending = false;
				text = result.text;
			}
			if (!text || !(await ctx.runQuery(internal.callRecordings.target, { id }))) return;
			paidPending = true;
			const result = await summarizeCall(text);
			await ctx.runMutation(internal.callRecordings.saveSummary, { id, attempt, text: result.text, costUsd: result.costUsd, model: result.model });
		} catch {
			await ctx.runMutation(internal.callRecordings.processingFailed, { id, attempt, uncertain: paidPending });
		}
	},
});

/** Runs even after a call's row was deleted. Keys and ids were chosen by the server. */
export const cleanup = internalAction({
	args: { key: v.string(), egressId: v.optional(v.string()), attempt: v.optional(v.number()) },
	handler: async (ctx, { key, egressId, attempt = 0 }) => {
		try {
			if (egressId) {
				await stopRecording(egressId);
				// Stop completes asynchronously; allow the final upload before removing its object.
				await ctx.scheduler.runAfter(60_000, internal.callRecordingJobs.cleanup, { key });
				return;
			}
			await deleteRecording(key);
		} catch {
			if (attempt < 4) await ctx.scheduler.runAfter(5_000 * 2 ** attempt, internal.callRecordingJobs.cleanup, { key, ...(egressId && { egressId }), attempt: attempt + 1 });
			else console.error("Call recording staging cleanup failed. Check the private bucket lifecycle policy.");
		}
	},
});
