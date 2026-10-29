import { describe, expect, it, vi } from "vitest";
import { micError, micOnce, pickMimeType, spaced } from "./dictation";

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

	describe("asking for the microphone", () => {
		/** A getUserMedia that waits for `grant()`, like a permission prompt, and a track to watch. */
		function fakeMic() {
			const track = { stop: vi.fn() };
			const stream = { getTracks: () => [track] } as unknown as MediaStream;
			let grant = () => {};
			const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => (grant = () => resolve(stream))));
			return { track, stream, getUserMedia, grant: () => grant() };
		}

		it("starts one request for a double click, and can ask again once it's answered", async () => {
			const mic = fakeMic();
			const open = micOnce(mic.getUserMedia);
			const first = open(() => true);
			const second = open(() => true);
			mic.grant();
			expect(await first).toBe(mic.stream);
			expect(await second).toBeUndefined();
			expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
			expect(mic.track.stop).not.toHaveBeenCalled();

			const again = open(() => true);
			mic.grant();
			expect(await again).toBe(mic.stream);
			expect(mic.getUserMedia).toHaveBeenCalledTimes(2);
		});

		it("turns the mic off when the composer closed or a recording started while it waited", async () => {
			const mic = fakeMic();
			let open = true;
			const pending = micOnce(mic.getUserMedia)(() => open);
			open = false;
			mic.grant();
			expect(await pending).toBeUndefined();
			expect(mic.track.stop).toHaveBeenCalledTimes(1);
		});

		it("lets a refused request be retried", async () => {
			const getUserMedia = vi.fn().mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
			const open = micOnce(getUserMedia);
			await expect(open(() => true)).rejects.toThrow("denied");
			getUserMedia.mockResolvedValueOnce({ getTracks: () => [] });
			expect(await open(() => true)).toBeDefined();
		});
	});
});
