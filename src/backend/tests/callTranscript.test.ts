import { describe, expect, it } from "vitest";
import { speakerTurns, transcriptText } from "../convex/callTranscript";

const word = (text: string, speaker: string | null, start: number, end = start + 0.3) => ({ type: "word", text, speaker_id: speaker, start, end });

describe("recorded speaker turns", () => {
	it("keeps speaker identity across interruptions and joins consecutive words", () => {
		const turns = speakerTurns([
			word("Good", "voice-b", 0), { type: "spacing", text: " " }, word("morning.", "voice-b", 0.5),
			word("Hello.", "voice-a", 1), { type: "audio_event", text: "(laughing)" },
			word("Tuesday?", "voice-b", 2), word("Yes.", "voice-a", 3),
		]);
		expect(turns).toEqual([
			{ speaker: "voice-b", text: "Good morning.", start: 0, end: 0.8 },
			{ speaker: "voice-a", text: "Hello.", start: 1, end: 1.3 },
			{ speaker: "voice-b", text: "Tuesday?", start: 2, end: 2.3 },
			{ speaker: "voice-a", text: "Yes.", start: 3, end: 3.3 },
		]);
		expect(transcriptText(turns!)).toBe("Speaker 1: Good morning.\n\nSpeaker 2: Hello.\n\nSpeaker 1: Tuesday?\n\nSpeaker 2: Yes.");
	});

	it("does not invent attribution or silently drop words with missing speakers or invalid times", () => {
		expect(speakerTurns(undefined)).toBeNull();
		for (const invalid of [word("Unknown.", null, 1), word("Backwards.", "a", 3, 2), word("Negative.", "a", -1), word("Invalid.", "a", NaN)]) {
			expect(speakerTurns([word("Known.", "a", 0), invalid])).toBeNull();
		}
	});

	it("bounds speaker output without showing a cut-off conversation as complete", () => {
		expect(speakerTurns(Array.from({ length: 4_001 }, (_, i) => word("Yes.", String(i % 2), i)))).toBeNull();
		expect(speakerTurns([word("a".repeat(120_001), "a", 0)])).toBeNull();
	});
});
