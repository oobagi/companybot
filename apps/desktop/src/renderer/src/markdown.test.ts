import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, appRoute } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { mode: "static" }, text));

describe("Markdown links", () => {
	it("keeps page links as in-app links", () => {
		const html = render("See [Plan](companybot://page/abc123).");
		expect(html).toContain('<a class="page-link" href="companybot://page/abc123">Plan</a>');
		expect(html).not.toContain("[blocked]");
	});

	it("opens screen links in the app", () => {
		const html = render("Go to [Members](#/settings/members).");
		expect(html).toContain('<a class="wrap-anywhere font-medium text-link hover:underline" href="#/settings/members">Members</a>');
		expect(html).not.toContain("<button");
		expect(appRoute("#/settings/members")).toEqual(["settings", "members"]);
		expect(appRoute("#/chat")).toEqual(["chat"]);
		expect(appRoute("#/settings/%E0")).toBeUndefined();
		expect(appRoute("https://x.com/#/a")).toBeUndefined();
	});

	it("colors web links as links", () => {
		const html = render("See [the docs](https://ai-sdk.dev).");
		expect(html).toMatch(/class="[^"]*text-link[^"]*"/);
		expect(html).not.toMatch(/class="[^"]*text-primary[^"]*"/);
	});

	it("still strips unsafe links", () => {
		expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
	});
});
