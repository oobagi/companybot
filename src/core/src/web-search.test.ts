import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (actual) => ({ ...(await actual<typeof import("ai")>()), generateText }));

import { searchProvider } from "./web-search";

afterEach(() => {
	vi.unstubAllGlobals();
	generateText.mockReset();
});

/** Stubs fetch with one JSON answer and returns the mock, to check what was asked. */
function answer(body: unknown, status = 200) {
	const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

describe("search providers", () => {
	it("gateway: one forced Exa call, its results mapped, its cost reported", async () => {
		generateText.mockResolvedValue({
			content: [
				{ type: "tool-call", toolName: "exa_search", input: { query: "acme" } },
				{
					type: "tool-result",
					toolName: "exa_search",
					providerExecuted: true,
					output: {
						requestId: "x",
						results: [
							{ title: "Acme", url: "https://acme.com", id: "1", publishedDate: "2026-01-02", highlights: ["Roofing", "since 1990"] },
							{ title: "Other", url: "https://other.com", id: "2", text: "Full text" },
						],
					},
				},
			],
			providerMetadata: { gateway: { cost: "0.0071" } },
		});
		const onCost = vi.fn();
		const results = await searchProvider({}, { onCost }).search("acme", { limit: 2 });
		expect(results).toEqual([
			{ title: "Acme", url: "https://acme.com", snippet: "Roofing … since 1990", published: "2026-01-02" },
			{ title: "Other", url: "https://other.com", snippet: "Full text" },
		]);
		expect(onCost).toHaveBeenCalledWith(0.0071);
		const call = generateText.mock.calls[0]![0];
		expect(Object.keys(call.tools)).toEqual(["exa_search"]);
		expect(call.toolChoice).toBe("required");
		expect(call.prompt).toContain('"acme"');
	});

	it("gateway: a search error comes back as one", async () => {
		generateText.mockResolvedValue({ content: [{ type: "tool-result", output: { error: "rate_limit", message: "Slow down." } }] });
		await expect(searchProvider({ SEARCH_PROVIDER: "gateway" }).search("q", { limit: 5 })).rejects.toThrow("Slow down.");
	});

	it("brave: key header, count, and HTML-free snippets", async () => {
		const fetch = answer({ web: { results: [{ title: "<strong>Acme</strong> &amp; Co", url: "https://acme.com", description: "Best <strong>roofs</strong>", page_age: "2026-03-01T00:00:00" }] } });
		const results = await searchProvider({ SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "k" }).search("acme roofs", { limit: 3 });
		expect(results).toEqual([{ title: "Acme & Co", url: "https://acme.com", snippet: "Best roofs", published: "2026-03-01T00:00:00" }]);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe("https://api.search.brave.com/res/v1/web/search?q=acme+roofs&count=3");
		expect(init?.headers).toMatchObject({ "X-Subscription-Token": "k" });
	});

	it("brave: says what's missing, and when the service fails", async () => {
		await expect(searchProvider({ SEARCH_PROVIDER: "brave" }).search("q", { limit: 5 })).rejects.toThrow(/BRAVE_API_KEY/);
		answer({}, 429);
		await expect(searchProvider({ SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "k" }).search("q", { limit: 5 })).rejects.toThrow(/429/);
	});

	it("searxng: JSON format from SEARXNG_URL, cut to the limit", async () => {
		const fetch = answer({ results: [1, 2, 3].map((i) => ({ title: `T${i}`, url: `https://s${i}.com`, content: `C${i}`, publishedDate: null })) });
		const results = await searchProvider({ SEARCH_PROVIDER: "searxng", SEARXNG_URL: "http://searx.local:8080/base" }).search("q", { limit: 2 });
		expect(results).toEqual([
			{ title: "T1", url: "https://s1.com", snippet: "C1" },
			{ title: "T2", url: "https://s2.com", snippet: "C2" },
		]);
		expect(fetch.mock.calls[0]![0]).toBe("http://searx.local:8080/base/search?q=q&format=json");
	});

	it("an unknown provider says which ones exist", async () => {
		await expect(searchProvider({ SEARCH_PROVIDER: "bing" }).search("q", { limit: 5 })).rejects.toThrow(/gateway, brave or searxng/);
	});
});
