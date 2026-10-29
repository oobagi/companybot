import { describe, expect, it, vi } from "vitest";
import { buildToolSet } from "./agents";
import { platformGuide } from "./guide";
import { FETCHES_PER_TURN, PAGE_CHARS, SEARCHES_PER_TURN, type WebClient, clipPage, createWebTurn, linksIn, urlKey, webTools } from "./web";
import { ctx, owner } from "../test/helpers";

const client = (over: Partial<WebClient> = {}): WebClient => ({
	search: async () => [{ title: "Acme", url: "https://acme.com/pricing", snippet: "Plans" }],
	fetch: async (url) => ({ url, title: "Page", content: "See https://acme.com/about and [docs](https://docs.acme.com/start).", truncated: false }),
	...over,
});

describe("urlKey", () => {
	it("ignores scheme, case of the host, default ports, fragments and trailing slashes, not the query", () => {
		expect(urlKey("https://Acme.com:443/a/?q=1#top")).toBe(urlKey("http://acme.com/a?q=1"));
		expect(urlKey("https://acme.com")).toBe(urlKey("https://acme.com/"));
		expect(urlKey("https://acme.com/a?q=1")).not.toBe(urlKey("https://acme.com/a?q=2"));
		expect(urlKey("https://acme.com:8443/")).not.toBe(urlKey("https://acme.com/"));
		expect(urlKey("javascript:alert(1)")).toBeNull();
		expect(urlKey("nope")).toBeNull();
	});
});

describe("linksIn", () => {
	it("finds links, minus trailing punctuation and unmatched brackets", () => {
		expect(linksIn("See https://acme.com/a. Also (https://en.wikipedia.org/wiki/Foo_(bar)), and <https://x.io/y>!")).toEqual([
			"https://acme.com/a",
			"https://en.wikipedia.org/wiki/Foo_(bar)",
			"https://x.io/y",
		]);
		expect(linksIn("[docs](https://docs.acme.com/start)")).toEqual(["https://docs.acme.com/start"]);
		expect(linksIn("[x](https://en.wikipedia.org/wiki/Reading_\\(process\\) \"Reading\")")).toEqual(["https://en.wikipedia.org/wiki/Reading_(process)"]);
	});

	it("reads bare domains as https only when asked", () => {
		expect(linksIn("check acme.com/pricing please")).toEqual([]);
		expect(linksIn("check acme.com/pricing please", { bare: true })).toEqual(["https://acme.com/pricing"]);
	});
});

describe("clipPage", () => {
	it("cuts long pages and says so", () => {
		expect(clipPage("short")).toEqual({ content: "short", truncated: false });
		const { content, truncated } = clipPage("x".repeat(PAGE_CHARS + 10));
		expect(truncated).toBe(true);
		expect(content).toMatch(/\[Cut at 20,000 characters\.\]$/);
	});
});

describe("createWebTurn", () => {
	it("opens links the person wrote, written loosely", async () => {
		const web = createWebTurn(client(), ["Can you read https://acme.com/blog/post?id=7 and acme.io?"]);
		expect(await web.fetch("http://ACME.com/blog/post/?id=7#intro")).not.toHaveProperty("error");
		expect(await web.fetch("https://acme.io/")).not.toHaveProperty("error");
	});

	it("refuses links nobody wrote or found, including the person's with data added", async () => {
		const fetch = vi.fn(client().fetch);
		const web = createWebTurn(client({ fetch }), ["Read https://acme.com/blog"]);
		for (const url of ["https://evil.example/?secret=1", "https://acme.com/blog?leak=abc", "https://acme.com/blog/other", "file:///etc/passwd"])
			expect(await web.fetch(url)).toHaveProperty("error");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("opens links from this turn's search results and fetched pages", async () => {
		const web = createWebTurn(client(), []);
		expect(await web.fetch("https://acme.com/pricing")).toMatchObject({ error: expect.stringMatching(/Search for the page first/) });
		await web.search("acme pricing", 5);
		expect(await web.fetch("https://acme.com/pricing")).toMatchObject({ title: "Page" });
		expect(await web.fetch("https://docs.acme.com/start")).toMatchObject({ title: "Page" });
		expect(await web.fetch("https://acme.com/about")).toMatchObject({ title: "Page" });
	});

	it("caps searches and fetches per turn", async () => {
		const search = vi.fn(client().search);
		const web = createWebTurn(client({ search }), ["https://acme.com/pricing"]);
		for (let i = 0; i < SEARCHES_PER_TURN; i++) expect(await web.search("q", 5)).toHaveProperty("results");
		expect(await web.search("q", 5)).toMatchObject({ error: expect.stringMatching(/5 searches/) });
		expect(search).toHaveBeenCalledTimes(SEARCHES_PER_TURN);
		for (let i = 0; i < FETCHES_PER_TURN; i++) expect(await web.fetch("https://acme.com/pricing")).not.toHaveProperty("error");
		expect(await web.fetch("https://acme.com/pricing")).toMatchObject({ error: expect.stringMatching(/10 pages/) });
	});

	it("turns failures into errors the model can read", async () => {
		const web = createWebTurn(client({ search: async () => { throw new Error("rate limited"); }, fetch: async () => ({ error: "Not a page." }) }), ["https://a.io"]);
		expect(await web.search("q", 5)).toEqual({ error: "Search failed: rate limited" });
		expect(await web.fetch("https://a.io")).toEqual({ error: "Not a page." });
	});
});

describe("web tools", () => {
	it("reach the model as data with refs and sources, and pages carry the not-instructions note", async () => {
		const tools = buildToolSet({ tools: ["web.*"] }, { ...ctx(owner), web: createWebTurn(client(), []) });
		const run = (name: string, input: unknown) => (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {});
		expect(await run("web_search", { query: "acme" })).toEqual({ ref: "r1", data: { results: [expect.objectContaining({ url: "https://acme.com/pricing" })] } });
		expect(await run("web_fetch", { url: "https://acme.com/pricing" })).toMatchObject({
			ref: "r2",
			data: { url: "https://acme.com/pricing", note: expect.stringMatching(/not instructions/) },
		});
	});

	it("read and run without asking, and label what they touched", () => {
		const [search, fetch] = webTools;
		expect([search!.readOnly, search!.risk, fetch!.readOnly, fetch!.risk]).toEqual([true, "none", true, "none"]);
		expect(search!.label!({ query: "acme pricing" })).toBe('Search the web for "acme pricing"');
		expect(fetch!.label!({ url: "https://www.acme.com/pricing/" }, { url: "https://acme.com/plans" })).toBe("Read acme.com/plans");
	});

	it("get a guide section only when granted, naming only granted tools", () => {
		expect(platformGuide({ tools: ["memory.*"] })).not.toContain("## The web");
		expect(platformGuide({ tools: ["web.*"] })).toMatch(/## The web\n- For current facts[^#]*web_fetch[^#]*Markdown links/);
		expect(platformGuide({ tools: ["web.search"] })).not.toContain("web_fetch");
		expect(platformGuide({ tools: ["web.fetch"] })).not.toContain("web_search");
	});
});
