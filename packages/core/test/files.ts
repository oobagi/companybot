import { strToU8, zipSync } from "fflate";

// Small real files for tests: a Word document, an Excel workbook, and a one-page PDF.

const contentTypes = strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');

/** A .docx whose body has one paragraph per entry. */
export function docx(...paragraphs: string[]) {
	const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
	return zipSync({
		"[Content_Types].xml": contentTypes,
		"word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
	});
}

/** A .xlsx with one sheet: `rows` of cells, strings shared, numbers inline. */
export function xlsx(sheet: string, rows: (string | number)[][]) {
	const shared: string[] = [];
	const cell = (value: string | number, ref: string) => {
		if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
		shared.push(value);
		return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
	};
	const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, `${String.fromCharCode(65 + c)}${r + 1}`)).join("")}</row>`).join("");
	return zipSync({
		"[Content_Types].xml": contentTypes,
		"xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
		"xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
		"xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`),
		"xl/sharedStrings.xml": strToU8(`<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
	});
}

/** A one-page PDF that says `text` (ASCII, no parentheses). */
export function pdf(text: string) {
	const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets = objects.map((o, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return strToU8(out);
}

/** A PNG header saying `width` × `height`, padded to `size` bytes. */
export function pngOf(width: number, height: number, size = 64) {
	const bytes = new Uint8Array(size);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(bytes.buffer).setUint32(16, width);
	new DataView(bytes.buffer).setUint32(20, height);
	return bytes;
}
