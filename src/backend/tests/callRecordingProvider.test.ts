import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRecording } from "../convex/callRecordingProvider";

const ROOM = "cb-call-test";
const KEY = "calls/workspace/message.mp3";
const ID = "EGtest";
type RequestLog = { method: string; body: Record<string, unknown> };

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv("LIVEKIT_URL", "https://test.livekit.cloud");
	vi.stubEnv("LIVEKIT_API_KEY", "test-key");
	vi.stubEnv("LIVEKIT_API_SECRET", "test-secret-at-least-32-characters");
	vi.stubEnv("RECORDING_S3_BUCKET", "test-private-recordings");
	vi.stubEnv("RECORDING_S3_REGION", "us-east-1");
	vi.stubEnv("RECORDING_S3_ACCESS_KEY_ID", "test-access-key");
	vi.stubEnv("RECORDING_S3_SECRET_ACCESS_KEY", "test-secret-access-key");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function script(respond: (method: string) => Response) {
	const requests: RequestLog[] = [];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const method = new URL(request.url).pathname.split("/").at(-1)!;
		requests.push({ method, body: JSON.parse(await request.text()) });
		return respond(method);
	});
	return { requests, fetch };
}

describe("recording provider readiness", () => {
	it("records all published room audio to one bounded MP3 without requesting a video compositor", async () => {
		const { requests } = script(() => Response.json({ egressId: ID, roomName: ROOM, status: "EGRESS_ACTIVE" }));
		expect(await startRecording(ROOM, KEY)).toBe(ID);
		expect(requests).toHaveLength(1);
		expect(requests[0]!.method).toBe("StartEgress");
		expect(requests[0]!.body).toMatchObject({ roomName: ROOM, media: { audio: { captureAll: true } }, advanced: { audioCodec: "AC_MP3", audioBitrate: 64 }, outputs: [{ file: { fileType: "MP3", filepath: KEY, disableManifest: true } }], storage: { s3: { bucket: "test-private-recordings", region: "us-east-1" } } });
		expect(requests[0]!.body.template).toBeUndefined();
		expect(requests[0]!.body.web).toBeUndefined();
	});

	it("waits for the created recorder to become active without creating another recorder", async () => {
		let reads = 0;
		const { requests } = script(method => method === "StartEgress"
			? Response.json({ egressId: ID, roomName: ROOM, status: "EGRESS_STARTING" })
			: Response.json({ items: [{ egressId: ID, roomName: ROOM, status: ++reads === 1 ? "EGRESS_STARTING" : "EGRESS_ACTIVE" }] }));
		let finished = false;
		const result = startRecording(ROOM, KEY).then(id => { finished = true; return id; });
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(500);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(await result).toBe(ID);
		expect(requests.filter(request => request.method === "StartEgress")).toHaveLength(1);
		expect(requests.filter(request => request.method === "ListEgress").every(request => request.body.egressId === ID)).toBe(true);
	});

	it("rejects an export that ends before becoming active", async () => {
		const { requests } = script(() => Response.json({ egressId: ID, roomName: ROOM, status: "EGRESS_FAILED" }));
		await expect(startRecording(ROOM, KEY)).rejects.toThrow("ended before");
		expect(requests).toHaveLength(1);
	});

	it("bounds recorder readiness waiting and never retries a paid start", async () => {
		let began = 0;
		let rejectedAt = 0;
		const { requests } = script(method => {
			if (method === "StartEgress") {
				began = Date.now();
				return Response.json({ egressId: ID, roomName: ROOM, status: "EGRESS_STARTING" });
			}
			return Response.json({ items: [{ egressId: ID, roomName: ROOM, status: "EGRESS_STARTING" }] });
		});
		const result = expect(startRecording(ROOM, KEY).catch(error => { rejectedAt = Date.now(); throw error; })).rejects.toThrow("ready in time");
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(15_000);
		await result;
		expect(rejectedAt - began).toBeLessThanOrEqual(15_000);
		expect(requests.filter(request => request.method === "StartEgress")).toHaveLength(1);
	});

	it("does not repeat a start when its response is lost", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Lost response"));
		await expect(startRecording(ROOM, KEY)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
