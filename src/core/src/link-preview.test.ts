import { describe, expect, it } from "vitest";
import { PREVIEWS_PER_MESSAGE, previewLinks, previewUrl } from "./link-preview";

describe("previewLinks", () => {
	it("finds http(s) links in the order written, without duplicates, up to three", () => {
		expect(previewLinks("see https://a.com/x and http://b.org then https://a.com/x again")).toEqual(["https://a.com/x", "http://b.org/"]);
		const many = previewLinks("https://a.com https://b.com https://c.com https://d.com");
		expect(many).toHaveLength(PREVIEWS_PER_MESSAGE);
		expect(many.at(-1)).toBe("https://c.com/");
	});

	it("drops the punctuation around a link but keeps a path's own parentheses and query", () => {
		expect(previewLinks("Read https://a.com/docs.")).toEqual(["https://a.com/docs"]);
		expect(previewLinks("(see https://a.com/b)")).toEqual(["https://a.com/b"]);
		expect(previewLinks("[the docs](https://a.com/b), thanks!")).toEqual(["https://a.com/b"]);
		expect(previewLinks("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
		expect(previewLinks("<https://a.com/q?x=1&y=2>")).toEqual(["https://a.com/q?x=1&y=2"]);
	});

	it("skips links in code, in-app addresses, page links and other schemes", () => {
		expect(previewLinks("run `curl https://a.com/in-code` now")).toEqual([]);
		expect(previewLinks("```\nhttps://a.com/fenced\n```\nhttps://b.com/after")).toEqual(["https://b.com/after"]);
		expect(previewLinks("```\nhttps://a.com/unclosed")).toEqual([]);
		expect(previewLinks("~~~\nhttps://a.com/tilde\n~~~")).toEqual([]);
		expect(previewLinks("[Members](#/settings/members) [Plan](companybot://page/abc123) mailto:a@b.com ftp://a.com/x")).toEqual([]);
	});

	it("skips links that carry credentials or point at a host with no dot (and so bracketed IPv6)", () => {
		expect(previewLinks("https://user:pass@a.com/x http://localhost:3000/y https://intranet/z http://[2001:db8::1]/x")).toEqual([]);
	});

	it("keys links without their fragment", () => {
		expect(previewUrl("https://a.com/x#top")).toBe("https://a.com/x");
		expect(previewLinks("https://a.com/x#one https://a.com/x#two")).toEqual(["https://a.com/x"]);
		expect(previewUrl(`https://a.com/${"x".repeat(3000)}`)).toBeUndefined();
	});
});
