import { unzipSync } from "fflate";
import { type ImageType, imageTypes, sniffImage } from "./images";

// Files people attach to chat messages. Like pictures, a file's type is read from its bytes,
// never from its name or what the uploader says: the app checks before uploading, the backend's
// upload endpoint checks again. Nothing that a browser would run (HTML, SVG) is ever taken.

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const fileTypes = [...imageTypes, "application/pdf", DOCX, XLSX, "text/plain", "text/markdown", "text/csv", "application/json"] as const;
export type FileType = (typeof fileTypes)[number];

/** Convex HTTP actions take request bodies up to 20 MB, so that's the most one file can be. */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;
export const FILES_PER_MESSAGE = 10;

/** Pictures sent to a model with one turn, newest kept, and the most a model takes (Anthropic's limits). */
export const TURN_IMAGES_MAX = 8;
const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const MODEL_IMAGE_MAX_SIDE = 8000;

/** Whether a model can be sent this picture as is. */
export const modelTakesImage = (f: Pick<Attachment, "type" | "size" | "width" | "height">) =>
	isImageType(f.type) && f.size <= MODEL_IMAGE_MAX_BYTES && (f.width ?? 0) <= MODEL_IMAGE_MAX_SIDE && (f.height ?? 0) <= MODEL_IMAGE_MAX_SIDE;
/** Longest file name kept. */
const NAME_MAX = 200;

export const isImageType = (type: string): type is ImageType => (imageTypes as readonly string[]).includes(type);
export const isFileType = (type: string): type is FileType => (fileTypes as readonly string[]).includes(type);

/** A file as a message carries it. */
export interface Attachment {
	name: string;
	type: FileType;
	size: number;
	/** Pictures only, when their header says. */
	width?: number;
	height?: number;
}

/** What a file's bytes say it is, or undefined if it isn't one we take. `name` only picks between kinds of text. */
export function sniffFile(bytes: Uint8Array, name: string): FileType | undefined {
	const image = sniffImage(bytes);
	if (image) return image;
	if (startsWith(bytes, "%PDF-")) return "application/pdf";
	if (startsWith(bytes, "PK\x03\x04")) return sniffZip(bytes);
	return sniffText(bytes, name);
}

/** Why this file can't be attached, or undefined if it can. */
export function fileError(bytes: Uint8Array, name: string, size = bytes.length) {
	if (size > FILE_MAX_BYTES) return `Pick a file under ${FILE_MAX_BYTES / 1024 / 1024} MB.`;
	if (!sniffFile(bytes, name)) return "Attach a picture, PDF, Word or Excel file, or plain text (Markdown, CSV, JSON).";
}

const startsWith = (bytes: Uint8Array, text: string) => [...text].every((c, i) => bytes[i] === c.charCodeAt(0));

/** Word and Excel files are ZIPs: told apart by the parts listed in the archive, without unpacking any. */
function sniffZip(bytes: Uint8Array): FileType | undefined {
	const names = zipNames(bytes);
	if (!names.has("[Content_Types].xml")) return;
	if (names.has("word/document.xml")) return DOCX;
	if (names.has("xl/workbook.xml")) return XLSX;
}

export function zipNames(bytes: Uint8Array) {
	const names = new Set<string>();
	try {
		unzipSync(bytes, { filter: (f) => (names.add(f.name), false) });
	} catch {
		// Not a readable ZIP.
	}
	return names;
}

const textTypes: Record<string, FileType> = { md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json" };
/** Never text, whatever their bytes: browsers run them. */
const markupExtensions = new Set(["html", "htm", "xhtml", "svg", "xml", "shtml"]);

/** UTF-8 text with no NUL bytes that doesn't start like a web page or SVG. The extension picks the kind. */
function sniffText(bytes: Uint8Array, name: string): FileType | undefined {
	const extension = name.toLowerCase().split(".").pop() ?? "";
	if (markupExtensions.has(extension) || bytes.includes(0)) return;
	let head: string;
	try {
		head = new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, 1024);
	} catch {
		return;
	}
	if (/^\s*<(!doctype|html|svg|\?xml|head|body|script)/i.test(head)) return;
	return textTypes[extension] ?? "text/plain";
}

/** A picture's size from its header, when it's cheap to read. Undefined if the header doesn't say. */
export function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | undefined {
	const u16be = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
	const u16le = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
	const u24le = (at: number) => u16le(at) | (bytes[at + 2]! << 16);
	const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
	if (bytes.length < 30) return;
	if (type === "image/png") return size(((bytes[16]! << 24) >>> 0) + (bytes[17]! << 16) + u16be(18), ((bytes[20]! << 24) >>> 0) + (bytes[21]! << 16) + u16be(22));
	if (type === "image/gif") return size(u16le(6), u16le(8));
	if (type === "image/webp") {
		const chunk = String.fromCharCode(...bytes.subarray(12, 16));
		if (chunk === "VP8 ") return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
		if (chunk === "VP8L") {
			const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
			return size(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
		}
		if (chunk === "VP8X") return size(1 + u24le(24), 1 + u24le(27));
		return;
	}
	if (type === "image/jpeg") {
		// Walk the markers to the first start-of-frame, which holds the size.
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return;
			const marker = bytes[at + 1]!;
			if (marker === 0xff) {
				at++;
				continue;
			}
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(u16be(at + 7), u16be(at + 5));
			at += marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 2 : 2 + u16be(at + 2);
		}
	}
}

/** A file name to keep: no folders, no control characters, one line, at most NAME_MAX characters. */
export function cleanFileName(raw: string) {
	const name = (raw.split(/[/\\]/).pop() ?? "").replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]+/gu, "").trim();
	return [...name].slice(0, NAME_MAX).join("") || "file";
}

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatFileSize(bytes: number) {
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${+(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "PDF", "Word", "Excel", "PNG", "Text"…: a file's kind for people. */
export function fileKind(type: string) {
	if (type === DOCX) return "Word";
	if (type === XLSX) return "Excel";
	if (type === "application/pdf") return "PDF";
	if (type === "application/json") return "JSON";
	if (type === "text/csv") return "CSV";
	if (type === "text/markdown") return "Markdown";
	if (isImageType(type)) return type.slice(6).toUpperCase().replace("JPEG", "JPG");
	return "Text";
}
