import { describe, expect, it } from "vitest";
import { imageError, imageMaxBytes, sniffImage } from "./images";

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("sniffImage", () => {
	it("reads the type from the first bytes", () => {
		expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
		expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffImage(bytes("GIF87a"))).toBe("image/gif");
		expect(sniffImage(bytes("GIF89a"))).toBe("image/gif");
		expect(sniffImage(bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBe("image/webp");
	});

	it("refuses anything else, including SVG and other RIFF files", () => {
		expect(sniffImage(bytes("<svg xmlns="))).toBeUndefined();
		expect(sniffImage(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBeUndefined();
		expect(sniffImage(bytes([0x89, 0x50]))).toBeUndefined();
		expect(imageError(bytes("<html>"), 10)).toMatch(/PNG/);
		expect(imageError(bytes("GIF89a"), imageMaxBytes + 1)).toMatch(/2 MB/);
		expect(imageError(bytes("GIF89a"), imageMaxBytes)).toBeUndefined();
	});
});
