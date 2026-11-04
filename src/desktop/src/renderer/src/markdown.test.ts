import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown, appRoute } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { mode: "static" }, text));

// Untrusted text can't make the app load a picture from the web.
it("shows images in text as links, never loading them", () => {
	const html = render("Saved it: ![Linear logo](https://linear.app/icon.png) and ![](https://a.io/x.png)");
	expect(html).not.toContain("<img");
	expect(html).not.toContain("blocked");
	expect(html).toContain("Linear logo");
	expect(html).toContain("Picture");
	// A chat file id isn't a link: the picture shows on the message already.
	expect(render("Saved it.\n\n![Vercel logo](md78sjk0df6bwp6m1hm2kc6fas8hk90y/0)")).not.toMatch(/Vercel logo|blocked/);
});

// Our sanitizer setup: page links survive it, script links don't.
it("keeps page links and strips unsafe ones", () => {
	const page = render("See [Plan](companybot://page/abc123).");
	expect(page).toContain('href="companybot://page/abc123"');
	expect(page).not.toContain("[blocked]");
	expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
});

it("reads screen links as app routes, and nothing else", () => {
	expect(appRoute("#/settings/members")).toEqual(["settings", "members"]);
	expect(appRoute("#/chat")).toEqual(["chat"]);
	expect(appRoute("#/settings/%E0")).toBeUndefined();
	expect(appRoute("https://x.com/#/a")).toBeUndefined();
});
