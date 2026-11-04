import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { Markdown, appRoute } from "./markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { mode: "static" }, text));

describe("Markdown links", () => {
	it("shows images in text as links, never loading them or saying they're blocked", () => {
		const html = render("Saved it: ![Linear logo](https://linear.app/icon.png) and ![](https://a.io/x.png)");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("blocked");
		// External links are Streamdown's open-with-confirmation buttons.
		expect(html).toMatch(/data-streamdown="link"[^>]*>Linear logo<\/button>/);
		expect(html).toMatch(/data-streamdown="link"[^>]*>Picture<\/button>/);
		// A chat file id isn't a link: the picture shows on the message already.
		expect(render("Saved it.\n\n![Vercel logo](md78sjk0df6bwp6m1hm2kc6fas8hk90y/0)")).not.toMatch(/Vercel logo|blocked/);
	});

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

describe("Markdown chips", () => {
	const tokens = {
		people: [{ type: "agent" as const, id: "a1" as never, name: "Quill", image: null }],
		channels: [{ name: "sales", id: "c1" as never }],
		skills: [{ id: "s1", name: "Proposal", description: "Write a proposal." }],
	};
	const chips = (text: string) => renderToStaticMarkup(createElement(Markdown, { mode: "static", tokens }, text));

	it("makes @names, #channels and /skills in a reply clickable", () => {
		const html = chips("Ask **@quill** in #sales to run /Proposal.");
		expect(html).toContain('<button type="button" aria-expanded="false" class="cursor-pointer token hover:underline">@quill</button></span>');
		expect(html).toContain('<button type="button" class="token hover:underline">#sales</button>');
		expect(html).toContain('<button type="button" aria-expanded="false" class="token cursor-pointer hover:underline"><span title="Write a proposal.">/Proposal</span></button>');
	});

	it("uses the names it's given now, not the first ones (Streamdown caches its processor)", () => {
		expect(renderToStaticMarkup(createElement(Markdown, { mode: "static", tokens: { ...tokens, people: [] } }, "Hi @Quill"))).not.toContain("token");
		expect(chips("Hi @Quill")).toContain(">@Quill</button>");
	});

	it("turns names into chips once they load, after the reply showed", async () => {
		const element = (t: typeof tokens) => createElement(Markdown, { mode: "static", tokens: t }, "Hi @Quill");
		const root = await act(async () => create(element({ ...tokens, people: [] })));
		expect(JSON.stringify(root.toJSON())).not.toContain("token");
		await act(async () => root.update(element(tokens)));
		expect(JSON.stringify(root.toJSON())).toContain("token");
		await act(async () => root.unmount());
	});

	it("leaves code, links and unknown names alone", () => {
		const html = chips("`@Quill` [#sales](https://x.co) @Nobody");
		expect(html).not.toContain("token");
		expect(html).toContain("@Nobody");
	});
});
