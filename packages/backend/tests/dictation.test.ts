import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { DICTATION_MODEL, MAX_AUDIO_BYTES, transcribeClip } from "../convex/dictation";
import { newTest, signIn } from "./helpers";

// No network: the AI SDK's transcribe and the gateway are stubbed, so nothing is billed.
const transcribe = vi.hoisted(() => vi.fn());
const transcription = vi.hoisted(() => vi.fn((id: string) => ({ id })));
vi.mock("ai", async (original) => ({
	...(await original<typeof import("ai")>()),
	experimental_transcribe: transcribe,
	gateway: { transcription },
}));

const clip = (size = 64) => new Uint8Array(size).buffer;

describe("dictation", () => {
	beforeEach(() => {
		transcribe.mockReset().mockResolvedValue({ text: "  call Ada tomorrow \n", providerMetadata: { gateway: { cost: "0.0004" } } });
		transcription.mockClear();
	});

	it("turns a recording into trimmed text, through the gateway's transcription model", async () => {
		const t = newTest();
		const ada = await signIn(t, "ada@co.com");
		expect(await ada.action(api.dictation.transcribeAudio, { audio: clip() })).toBe("call Ada tomorrow");
		expect(transcription).toHaveBeenCalledWith(DICTATION_MODEL);
		expect(transcribe).toHaveBeenCalledWith({ model: { id: DICTATION_MODEL }, audio: new Uint8Array(clip()) });
	});

	it("reports what the gateway charged, for the usage recorder", async () => {
		expect(await transcribeClip(new Uint8Array(8))).toEqual({ text: "call Ada tomorrow", costUsd: 0.0004 });
		transcribe.mockResolvedValue({ text: "hi", providerMetadata: {} });
		expect((await transcribeClip(new Uint8Array(8))).costUsd).toBe(0);
	});

	it("takes nothing from someone who isn't signed in to a workspace", async () => {
		const t = newTest();
		await expect(t.action(api.dictation.transcribeAudio, { audio: clip() })).rejects.toThrow("Sign in");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("returns nothing for an empty clip without a call, and refuses one that's too big", async () => {
		const t = newTest();
		const ada = await signIn(t, "ada@co.com");
		expect(await ada.action(api.dictation.transcribeAudio, { audio: clip(0) })).toBe("");
		await expect(ada.action(api.dictation.transcribeAudio, { audio: clip(MAX_AUDIO_BYTES + 1) })).rejects.toThrow("too long");
		expect(transcribe).not.toHaveBeenCalled();
	});

	it("passes a gateway failure on", async () => {
		const t = newTest();
		const ada = await signIn(t, "ada@co.com");
		transcribe.mockRejectedValue(new Error("gateway down"));
		await expect(ada.action(api.dictation.transcribeAudio, { audio: clip() })).rejects.toThrow();
	});
});
