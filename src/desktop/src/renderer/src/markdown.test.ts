import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { mode: "static" }, text));

describe("Markdown links", () => {
	it("keeps page links as in-app links", () => {
		const html = render("See [Plan](companybot://page/abc123).");
		expect(html).toContain('<a class="page-link" href="companybot://page/abc123">Plan</a>');
		expect(html).not.toContain("[blocked]");
	});

	it("still strips unsafe links", () => {
		expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
	});
});
