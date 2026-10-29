import { strFromU8, unzipSync } from "fflate";
import { DOCX, XLSX, isImageType } from "./files";

// The text in an attached file, for agents (chat.read_file). Word and Excel files are read
// straight from their XML; PDFs through unpdf (PDF.js built for servers). Not in the core barrel:
// unpdf is big, so only the backend's Node action that reads files imports it.

/** Characters per page an agent reads at once (~5k tokens). */
export const PAGE_CHARS = 20_000;
/** Text kept from one file; past it, the rest is left out with a note. */
const TEXT_MAX = 2_000_000;
/** A part of a Word or Excel file whose unpacked size says it's more than this isn't read (zip bombs). */
const PART_MAX = 50 * 1024 * 1024;

/** A file's text: a PDF's pages, a Word file's paragraphs, each sheet of an Excel file as CSV, or text as is. */
export async function fileText(bytes: Uint8Array, type: string): Promise<string> {
	const text = await extract(bytes, type);
	return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n\n(The rest of this file is too long to read.)` : text;
}

async function extract(bytes: Uint8Array, type: string) {
	if (isImageType(type)) return "";
	if (type === "application/pdf") return pdfText(bytes);
	if (type === DOCX) return docxText(unzip(bytes, (name) => name === "word/document.xml"));
	if (type === XLSX) return xlsxText(unzip(bytes, (name) => (name.startsWith("xl/") && name.endsWith(".xml")) || name.endsWith(".rels")));
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

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean) {
	const parts = unzipSync(bytes, { filter: (f) => wanted(f.name) && f.originalSize <= PART_MAX });
	return (name: string) => (parts[name] ? strFromU8(parts[name]) : "");
}

const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (xml: string) =>
	xml.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
		if (code[0] !== "#") return entities[code] ?? whole;
		const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
		return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
	});
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

/** A Word document's body: its text runs, with tabs, line breaks, paragraphs and table cells kept. */
function docxText(part: (name: string) => string) {
	let out = "";
	for (const [token, text] of part("word/document.xml").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<\/w:p>|<\/w:tc>/g)) {
		if (text !== undefined) out += decode(text);
		else if (token === "<w:tab/>" || token === "</w:tc>") out += "\t";
		else out += "\n";
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Every sheet of a workbook as CSV, under its name. Formulas show their last saved value. */
function xlsxText(part: (name: string) => string) {
	const runs = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1]!)).join("");
	const shared = [...part("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]!));
	const targets = new Map(
		[...part("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target") ?? ""]),
	);
	const sheets = [...part("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
		const target = targets.get(attr(m[0], "r:id")) ?? "";
		return { name: decode(attr(m[0], "name") ?? "Sheet"), path: target.startsWith("/") ? target.slice(1) : `xl/${target}` };
	});
	return sheets
		.map(({ name, path }) => {
			const rows = [...part(path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
				const cells: string[] = [];
				for (const [, attrs, inner = ""] of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
					const column = columnIndex(attr(attrs!, "r") ?? "") ?? cells.length;
					const value = decode(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
					const t = attr(attrs!, "t");
					cells[column] = t === "s" ? (shared[Number(value)] ?? "") : t === "inlineStr" ? runs(inner) : t === "b" ? (value === "1" ? "TRUE" : "FALSE") : value;
				}
				return Array.from(cells, (c) => csvCell(c ?? "")).join(",");
			});
			return `## ${name}\n${rows.join("\n")}`;
		})
		.join("\n\n");
}

/** "B7" → 1. */
function columnIndex(ref: string) {
	const letters = ref.match(/^[A-Z]+/)?.[0];
	if (!letters) return;
	return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
