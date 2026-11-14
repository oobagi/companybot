"use node";

import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AudioCodec, EgressClient, EgressStatus, EncodedFileType, EncodingOptions, FileOutput, MediaSource, Output, S3Upload, StartEgressRequest, StorageConfig } from "livekit-server-sdk";

/** Below the transcription provider's 25 MB upload limit. 64 kbps for 30 minutes is about 14.4 MB. */
export const RECORDING_MAX_BYTES = 24_000_000;
export const RECORDING_MIME = "audio/mpeg";

function storageConfig() {
	const bucket = process.env.RECORDING_S3_BUCKET;
	const region = process.env.RECORDING_S3_REGION;
	const accessKeyId = process.env.RECORDING_S3_ACCESS_KEY_ID;
	const secretAccessKey = process.env.RECORDING_S3_SECRET_ACCESS_KEY;
	const endpoint = process.env.RECORDING_S3_ENDPOINT || undefined;
	if (!bucket || !region || !accessKeyId || !secretAccessKey) throw new Error("Call recording storage is not configured.");
	if (endpoint) {
		const url = new URL(endpoint);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Call recording storage needs an HTTPS endpoint.");
	}
	return { bucket, region, accessKeyId, secretAccessKey, endpoint };
}

export function recordingConfigured() {
	try {
		storageConfig();
		return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
	} catch {
		return false;
	}
}

function egressClient(requestTimeout = 30) {
	const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
	if (!url || !key || !secret) throw new Error("Calling is not configured.");
	// A timed-out start may already have created a recorder. Reconcile it instead of repeating it.
	return new EgressClient(url, key, secret, { requestTimeout, failover: false });
}

function checkKey(key: string) {
	if (!/^[A-Za-z0-9_/-]+\.mp3$/.test(key) || key.startsWith("/") || key.includes("//")) throw new Error("Invalid recording storage key.");
}

function s3() {
	const config = storageConfig();
	return {
		bucket: config.bucket,
		client: new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: !!config.endpoint, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 3 }),
	};
}

/** The caller claims one start transactionally before calling this function. */
export async function startRecording(room: string, key: string): Promise<string> {
	checkKey(key);
	const config = storageConfig();
	const info = await egressClient().startEgress(new StartEgressRequest({
		roomName: room,
		// SDK media capture records all published audio, including both staff and the SIP caller.
		source: { case: "media", value: new MediaSource({ audio: { captureAll: true } }) },
		encoding: { case: "advanced", value: new EncodingOptions({ audioCodec: AudioCodec.AC_MP3, audioBitrate: 64, audioFrequency: 44100 }) },
		outputs: [new Output({ config: { case: "file", value: new FileOutput({ fileType: EncodedFileType.MP3, filepath: key, disableManifest: true }) } })],
		storage: new StorageConfig({ provider: { case: "s3", value: new S3Upload({ bucket: config.bucket, region: config.region, accessKey: config.accessKeyId, secret: config.secretAccessKey, ...(config.endpoint && { endpoint: config.endpoint, forcePathStyle: true }) }) } }),
	}));
	if (!info.egressId) throw new Error("The recorder did not return an ID.");
	const deadline = Date.now() + 15_000;
	let current = info;
	while (current.status !== EgressStatus.EGRESS_ACTIVE) {
		if (current.status !== EgressStatus.EGRESS_STARTING) throw new Error("The recorder ended before it became ready.");
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("The recorder did not become ready in time.");
		await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)));
		// Bound each read by the remaining readiness window. Never issue another start.
		const requestTimeout = Math.floor((deadline - Date.now()) / 1000);
		if (requestTimeout <= 0) throw new Error("The recorder did not become ready in time.");
		current = (await egressClient(requestTimeout).listEgress({ egressId: info.egressId })).find(egress => egress.egressId === info.egressId) ?? current;
	}
	return info.egressId;
}

/** Recover a lost start response by the room and exact server-chosen output key. */
export async function reconcileRecording(room: string, key: string): Promise<{ id: string; status: number } | null> {
	checkKey(key);
	const recordings = await egressClient().listEgress({ roomName: room });
	const found = recordings.find((recording) => recording.roomName === room && recording.request.case === "egress" && recording.request.value.outputs.some((output) => output.config.case === "file" && output.config.value.filepath === key));
	return found ? { id: found.egressId, status: found.status } : null;
}

export async function stopRecording(id: string): Promise<void> {
	try {
		await egressClient().stopEgress(id);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "not_found")) throw error;
	}
}

/** Read only the known private object key, never a URL supplied by a webhook. */
export async function readRecording(key: string): Promise<Blob> {
	checkKey(key);
	const { client, bucket } = s3();
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), 60_000);
	try {
		const file = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: abort.signal });
		if (file.ContentLength !== undefined && (file.ContentLength <= 0 || file.ContentLength > RECORDING_MAX_BYTES)) throw new Error("The call recording exceeds the supported size.");
		if (!file.Body) throw new Error("The call recording is empty.");
		const reader = file.Body.transformToWebStream().getReader();
		const parts: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > RECORDING_MAX_BYTES) {
					await reader.cancel();
					throw new Error("The call recording exceeds the supported size.");
				}
				parts.push(new Uint8Array(value));
			}
		} finally {
			reader.releaseLock();
		}
		if (!size) throw new Error("The call recording is empty.");
		return new Blob(parts, { type: RECORDING_MIME });
	} finally {
		clearTimeout(timeout);
		client.destroy();
	}
}

/** Delete is idempotent; callers retry failures after a successful Convex import. */
export async function deleteRecording(key: string): Promise<void> {
	checkKey(key);
	const { client, bucket } = s3();
	try {
		await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
	} finally {
		client.destroy();
	}
}
