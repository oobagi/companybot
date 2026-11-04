import { expect, it } from "vitest";
import { promotePageLinks } from "./pageBlockUpgrades";

type PageBlock = Parameters<typeof promotePageLinks>[0];
const paragraph = (content: unknown[]): PageBlock => ({ id: "original", type: "paragraph", props: {}, content, children: [] }) as unknown as PageBlock;
const link = { type: "link", href: "companybot://page/abc123", content: [{ type: "text", text: "Untitled", styles: {} }] };

it("turns old page links into atomic blocks without losing adjacent text or formatting", () => {
	const before = { type: "text", text: "aa", styles: { bold: true } };
	const after = { type: "text", text: " notes", styles: {} };
	expect(promotePageLinks(paragraph([before, link, after]))).toEqual([
		{ id: "original", type: "paragraph", props: {}, content: [before] },
		{ type: "page", props: { pageId: "abc123", title: "Untitled" } },
		{ type: "paragraph", props: {}, content: [after], children: [] },
	]);
});

it("keeps the original block id when a link is the whole paragraph and leaves ordinary links alone", () => {
	expect(promotePageLinks(paragraph([link]))).toEqual([{ id: "original", type: "page", props: { pageId: "abc123", title: "Untitled" }, children: [] }]);
	expect(promotePageLinks(paragraph([{ ...link, href: "https://example.com" }]))).toBeUndefined();
});
