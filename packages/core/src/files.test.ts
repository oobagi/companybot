import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { docx, pdf, pngOf, xlsx } from "../test/files";
import { PAGE_CHARS, fileText, textPage } from "./file-text";
import { DOCX, FILE_MAX_BYTES, XLSX, cleanFileName, fileError, formatFileSize, imageSize, sniffFile, toBase64 } from "./files";

const text = (s: string) => new TextEncoder().encode(s);

describe("sniffFile", () => {
	it("reads pictures, PDFs, Word and Excel files by their bytes, whatever they're called", () => {
		expect(sniffFile(pngOf(1, 1), "notes.txt")).toBe("image/png");
		expect(sniffFile(pdf("Hi"), "a.docx")).toBe("application/pdf");
		expect(sniffFile(docx("Hi"), "report.pdf")).toBe(DOCX);
		expect(sniffFile(xlsx("S", [["a"]]), "x")).toBe(XLSX);
	});

	it("refuses other ZIPs, and ZIPs that only look like Office files", () => {
		expect(sniffFile(zipSync({ "word/document.xml": strToU8("<w/>") }), "a.docx")).toBeUndefined();
		expect(sniffFile(zipSync({ "a.txt": strToU8("hi") }), "a.zip")).toBeUndefined();
		expect(sniffFile(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), "broken.docx")).toBeUndefined();
	});

	it("takes UTF-8 text, naming its kind by extension, but never HTML, SVG or binary", () => {
		expect(sniffFile(text("# Plan"), "plan.md")).toBe("text/markdown");
		expect(sniffFile(text("a,b\n1,2"), "data.CSV")).toBe("text/csv");
		expect(sniffFile(text('{"a":1}'), "a.json")).toBe("application/json");
		expect(sniffFile(text("hello"), "notes")).toBe("text/plain");
		expect(sniffFile(text("\uFEFF  <!DOCTYPE html><script>alert(1)</script>"), "page.txt")).toBeUndefined();
		expect(sniffFile(text('<svg xmlns="http://www.w3.org/2000/svg"/>'), "logo.txt")).toBeUndefined();
		expect(sniffFile(text("plain words"), "page.html")).toBeUndefined();
		expect(sniffFile(new Uint8Array([0x68, 0x00, 0x69]), "a.txt")).toBeUndefined();
		expect(sniffFile(new Uint8Array([0xc3, 0x28]), "a.txt")).toBeUndefined();
	});

	it("explains what's refused", () => {
		expect(fileError(text("hi"), "a.txt")).toBeUndefined();
		expect(fileError(text("hi"), "a.txt", FILE_MAX_BYTES + 1)).toMatch(/20 MB/);
		expect(fileError(text("<html>"), "a.txt")).toMatch(/PDF/);
	});
});

describe("imageSize", () => {
	it("reads PNG, GIF, WebP and JPEG headers", () => {
		expect(imageSize(pngOf(800, 600), "image/png")).toEqual({ width: 800, height: 600 });
		const gif = new Uint8Array(32);
		gif.set([...strToU8("GIF89a"), 0x20, 0x03, 0x58, 0x02]);
		expect(imageSize(gif, "image/gif")).toEqual({ width: 800, height: 600 });
		const webp = new Uint8Array(40);
		webp.set([...strToU8("RIFF"), 0, 0, 0, 0, ...strToU8("WEBPVP8X")]);
		webp.set([0x1f, 0x03, 0, 0x57, 0x02, 0], 24);
		expect(imageSize(webp, "image/webp")).toEqual({ width: 800, height: 600 });
		// SOI, an APP0 segment, then a baseline frame: 600 high, 800 wide.
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, ...new Array(20).fill(0)]);
		expect(imageSize(jpeg, "image/jpeg")).toEqual({ width: 800, height: 600 });
		expect(imageSize(new Uint8Array(40), "image/jpeg")).toBeUndefined();
	});
});

describe("names and sizes", () => {
	it("keeps a file's own name: no folders or control characters, one line", () => {
		expect(cleanFileName("C:\\Users\\ada\\Q3 report.pdf")).toBe("Q3 report.pdf");
		expect(cleanFileName("../../etc/passwd")).toBe("passwd");
		expect(cleanFileName("a\u202Efdp.exe\n.txt")).toBe("afdp.exe .txt");
		expect(cleanFileName("")).toBe("file");
		expect(cleanFileName("x".repeat(500))).toHaveLength(200);
	});

	it("formats sizes", () => {
		expect(formatFileSize(1)).toBe("1 byte");
		expect(formatFileSize(2048)).toBe("2 KB");
		expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1.3 MB");
	});
});

describe("toBase64", () => {
	it("encodes pictures of any size without Node's Buffer, which Convex's runtime lacks", () => {
		// Several of its 32 KB chunks, and a part one.
		const big = new Uint8Array(200_003).map((_, i) => i * 7);
		let binary = "";
		for (const byte of big) binary += String.fromCharCode(byte);
		const g = globalThis as { Buffer?: unknown };
		const real = g.Buffer;
		delete g.Buffer;
		try {
			expect(toBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
			expect(toBase64(big)).toBe(btoa(binary));
		} finally {
			g.Buffer = real;
		}
	});
});

describe("fileText", () => {
	it("reads a PDF's pages", async () => {
		expect(await fileText(pdf("Quarterly revenue up"), "application/pdf")).toContain("Quarterly revenue up");
	});

	it("reads a Word document's paragraphs, decoding entities", async () => {
		expect(await fileText(docx("Dear Ada,", "Fish &amp; chips"), DOCX)).toBe("Dear Ada,\nFish & chips");
	});

	it("reads each sheet as CSV under its name", async () => {
		const book = xlsx("Leads", [["Name", "Deal"], ["Acme, Inc.", 1200], ["Bob \"B\"", 5]]);
		expect(await fileText(book, XLSX)).toBe('## Leads\nName,Deal\n"Acme, Inc.",1200\n"Bob ""B""",5');
	});

	it("won't unpack more than 50 MB of a Word or Excel file (zip bombs)", async () => {
		// Nine 6 MB sheets of zeros pack to a few KB each, and would unpack to 54 MB together.
		const zeros = new Uint8Array(6 * 1024 * 1024);
		const sheets = Array.from({ length: 9 }, (_, i) => i + 1);
		const bomb = zipSync({
			"xl/workbook.xml": strToU8(`<workbook><sheets>${sheets.map((i) => `<sheet name="S${i}" r:id="rId${i}"/>`).join("")}</sheets></workbook>`),
			"xl/_rels/workbook.xml.rels": strToU8(`<Relationships>${sheets.map((i) => `<Relationship Id="rId${i}" Target="worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`),
			...Object.fromEntries(sheets.map((i) => [`xl/worksheets/sheet${i}.xml`, zeros])),
		});
		expect(bomb.length).toBeLessThan(1024 * 1024);
		expect(await fileText(bomb, XLSX)).toBe("(This file is too long to read.)");
	});

	it("holds no more of a part than its header says, even when the header lies", async () => {
		const body = "<w:p><w:t>Hi</w:t></w:p>";
		const file = zipSync({ "word/document.xml": strToU8(body + "<w:p><w:t>more</w:t></w:p>".repeat(100_000)) });
		// Rewrite the uncompressed size in the central directory entry (offset 24) to the first paragraph's.
		const view = new DataView(file.buffer);
		for (let at = 0; at < file.length - 4; at++) if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, body.length, true);
		expect(await fileText(file, DOCX)).toBe("Hi");
	});

	it("pages long text", async () => {
		const long = "a".repeat(PAGE_CHARS) + "b";
		expect(textPage(long, 2)).toEqual({ text: "b", page: 2, pages: 2 });
		expect(textPage(long, 9).page).toBe(2);
		expect(textPage("", 1)).toEqual({ text: "", page: 1, pages: 1 });
		expect(await fileText(text("a,b"), "text/csv")).toBe("a,b");
	});
});
