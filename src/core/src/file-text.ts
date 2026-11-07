import { DOCX, PPTX, XLSX, isImageType } from "./files";
import { readDocx, readPptx, readXlsx, toCsv } from "./office-text";

// The text in an attached file, for agents (chat.read_file, files.read). Office files are read
// straight from their XML (office-text.ts); PDFs through unpdf (PDF.js built for servers). Not in
// the core barrel: unpdf is big, so only the backend's Node action that reads files imports it.

/** Characters per page an agent reads at once (~5k tokens). */
export const PAGE_CHARS = 20_000;
/** Text kept from one file; past it, the rest is left out with a note. */
const TEXT_MAX = 2_000_000;
const TOO_LONG = "(This file is too long to read.)";

/** A file's text: a PDF's pages, a Word file's paragraphs, each sheet of an Excel file as CSV, a deck's slides, or text as is. */
export async function fileText(bytes: Uint8Array, type: string): Promise<string> {
	const text = await extract(bytes, type);
	return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n\n(The rest of this file is too long to read.)` : text;
}

async function extract(bytes: Uint8Array, type: string) {
	if (isImageType(type)) return "";
	if (type === "application/pdf") return pdfText(bytes);
	if (type === DOCX) return readDocx(bytes) ?? TOO_LONG;
	if (type === XLSX) return readXlsx(bytes)?.map((sheet) => `## ${sheet.name}\n${toCsv(sheet.rows)}`).join("\n\n") ?? TOO_LONG;
	if (type === PPTX) return readPptx(bytes)?.map((lines, i) => `--- Slide ${i + 1} ---\n${lines.join("\n")}`).join("\n\n") ?? TOO_LONG;
	return new TextDecoder().decode(bytes);
}

/** One page of a file's text: `page` is 1-based. */
export function textPage(text: string, page = 1) {
	const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
	const at = Math.min(Math.max(1, Math.floor(page)), pages);
	return { text: text.slice((at - 1) * PAGE_CHARS, at * PAGE_CHARS), page: at, pages };
}

async function pdfText(bytes: Uint8Array) {
	const { extractText } = await import("unpdf");
	// PDF.js takes ownership of the buffer it's given.
	const { text } = await extractText(bytes.slice(), { mergePages: false });
	return text.map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`).join("\n\n");
}
