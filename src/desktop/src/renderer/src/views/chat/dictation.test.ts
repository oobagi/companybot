import { describe, expect, it } from "vitest";
import { micError, pickMimeType, spaced } from "./dictation";

describe("dictation", () => {
	it("records in the best format the browser can make", () => {
		expect(pickMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
		expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
		expect(pickMimeType(() => false)).toBeUndefined();
	});

	it("puts a space between the words already there and the new ones, not at a line start or after a space", () => {
		expect(spaced("hello", " world ")).toBe(" world");
		expect(spaced("hello ", "world")).toBe("world");
		expect(spaced("", "world")).toBe("world");
		expect(spaced("a\n", "world")).toBe("world");
		expect(spaced("hello", "  ")).toBe("");
	});

	it("explains a blocked or missing microphone", () => {
		expect(micError({ name: "NotAllowedError" })).toMatch(/microphone access/);
		expect(micError({ name: "NotFoundError" })).toMatch(/No microphone/);
	});
});
