import { strFromU8, unzipSync } from "fflate";

// Office files (Word, Excel, PowerPoint) read straight from their XML, with no library: the
// backend reads them for agents (file-text.ts) and the app shows spreadsheets and slide outlines
// in Drive. Each reader takes a file's bytes and gives undefined when the file would unpack past
// UNZIP_MAX (zip bombs).

/** Bytes unpacked from one Office file, all parts together; past it, the file isn't read. */
export const UNZIP_MAX = 50 * 1024 * 1024;

/** The wanted parts of a ZIP, or undefined if together they'd unpack past UNZIP_MAX. */
export function unzip(bytes: Uint8Array, wanted: (name: string) => boolean) {
	// Sizes come from the ZIP's headers, read without unpacking anything. A header can lie, but
	// fflate inflates each part into a buffer of its stated size and drops what doesn't fit, so
	// what's held never passes the total. Stored (uncompressed) parts are copied at their packed size.
	let total = 0;
	unzipSync(bytes, {
		filter: (f) => {
			if (wanted(f.name)) total += f.compression ? f.originalSize : f.size;
			return false;
		},
	});
	if (total > UNZIP_MAX) return;
	const parts = unzipSync(bytes, { filter: (f) => wanted(f.name) });
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

/** Relationship id → part path, for a part's .rels file; paths are made absolute within `base`. */
function relationships(xml: string, base: string) {
	return new Map(
		[...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
			const target = attr(m[0], "Target") ?? "";
			return [attr(m[0], "Id"), target.startsWith("/") ? target.slice(1) : `${base}/${target}`];
		}),
	);
}

/** A Word document's text: its runs, with tabs, line breaks, paragraphs and table cells kept. Undefined past UNZIP_MAX. */
export function readDocx(bytes: Uint8Array) {
	const part = unzip(bytes, (name) => name === "word/document.xml");
	if (!part) return;
	let out = "";
	for (const [token, text] of part("word/document.xml").matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<\/w:p>|<\/w:tc>/g)) {
		if (text !== undefined) out += decode(text);
		else if (token === "<w:tab/>" || token === "</w:tc>") out += "\t";
		else out += "\n";
	}
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

export interface Sheet {
	name: string;
	/** Rows of cell text, columns in order; gaps are empty strings. Formulas show their last saved value. */
	rows: string[][];
}

/** Every sheet of a workbook, in order. Undefined past UNZIP_MAX. */
export function readXlsx(bytes: Uint8Array): Sheet[] | undefined {
	const part = unzip(bytes, (name) => (name.startsWith("xl/") && name.endsWith(".xml")) || name.endsWith(".rels"));
	if (!part) return;
	const runs = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1]!)).join("");
	const shared = [...part("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]!));
	const targets = relationships(part("xl/_rels/workbook.xml.rels"), "xl");
	return [...part("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
		const path = targets.get(attr(m[0], "r:id")) ?? "";
		const rows = [...part(path).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
			const cells: string[] = [];
			for (const [, attrs, inner = ""] of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const column = columnIndex(attr(attrs!, "r") ?? "") ?? cells.length;
				const value = decode(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
				const t = attr(attrs!, "t");
				cells[column] = t === "s" ? (shared[Number(value)] ?? "") : t === "inlineStr" ? runs(inner) : t === "b" ? (value === "1" ? "TRUE" : "FALSE") : value;
			}
			return Array.from(cells, (c) => c ?? "");
		});
		return { name: decode(attr(m[0], "name") ?? "Sheet"), rows };
	});
}

/** Each slide's text, in presentation order: a line per paragraph. Undefined past UNZIP_MAX. */
export function readPptx(bytes: Uint8Array): string[][] | undefined {
	const part = unzip(bytes, (name) => name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels" || /^ppt\/slides\/slide\d+\.xml$/.test(name));
	if (!part) return;
	const targets = relationships(part("ppt/_rels/presentation.xml.rels"), "ppt");
	const paths = [...part("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*>/g)].map((m) => targets.get(attr(m[0], "r:id")) ?? "");
	return paths.map((path) =>
		[...part(path).matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
			.map((p) => [...p[1]!.matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\b[^>]*\/?>/g)].map((m) => (m[1] === undefined ? "\n" : decode(m[1]))).join("").trim())
			.filter(Boolean),
	);
}

/** "B7" → 1. */
export function columnIndex(ref: string) {
	const letters = ref.match(/^[A-Z]+/)?.[0];
	if (!letters) return;
	return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

/** 0 → "A", 26 → "AA". */
export function columnName(index: number) {
	let name = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

export const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Rows as CSV lines. */
export const toCsv = (rows: string[][]) => rows.map((row) => row.map(csvCell).join(",")).join("\n");

/** CSV text as rows of cells: quoted fields, doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
			else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === ",") row.push(cell), (cell = "");
		else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	if (cell !== "" || row.length) row.push(cell), rows.push(row);
	return rows;
}
