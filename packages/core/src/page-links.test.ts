import { expect, it } from "vitest";
import { linkedPageId, pageHref, validPageHref } from "./page-links";

it("allows ordinary links and exact internal page hrefs while rejecting executable and other app protocols", () => {
	expect(linkedPageId(pageHref("abc123"))).toBe("abc123");
	for (const href of [pageHref("abc123"), "https://example.com", "mailto:a@co.com", "#/pages/abc123", "/relative", "tel:123"]) expect(validPageHref(href), href).toBe(true);
	for (const href of ["javascript:alert(1)", "java\u200bscript:alert(1)", "data:text/html,hi", "file:///tmp/x", "companybot://other/abc123", "companybot://page/abc123/extra", "companybot://page/abc123?command=x"]) expect(validPageHref(href), href).toBe(false);
});
