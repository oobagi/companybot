import { describe, expect, it } from "vitest";
import { pptx, xlsx } from "../test/files";
import { columnName, parseCsv, readPptx, readXlsx, toCsv } from "./office-text";

describe("office-text", () => {
	it("reads a workbook's sheets as rows of cells", () => {
		expect(readXlsx(xlsx("Leads", [["Name", "Deal"], ["Acme", 12]]))).toEqual([{ name: "Leads", rows: [["Name", "Deal"], ["Acme", "12"]] }]);
	});

	it("reads slides in presentation order", () => {
		expect(readPptx(pptx(["One", "Two"], ["Three"]))).toEqual([["One", "Two"], ["Three"]]);
	});

	it("parses CSV with quotes and line breaks, and writes it back", () => {
		const rows = [["Name", "Note"], ["Acme, Inc.", 'Said "hi"\nthen left'], ["", "x"]];
		expect(parseCsv(toCsv(rows))).toEqual(rows);
		expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
	});

	it("names columns like a spreadsheet", () => {
		expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
	});
});
