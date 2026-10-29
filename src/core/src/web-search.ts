import { gateway, generateText, isStepCount } from "ai";
import { gatewayCost } from "./usage";
import type { SearchProvider, SearchResult } from "./web";

// Search providers, picked by the SEARCH_PROVIDER env var: "gateway" (default), "brave" or "searxng".

export interface SearchEnv {
	SEARCH_PROVIDER?: string;
	BRAVE_API_KEY?: string;
	SEARXNG_URL?: string;
}

/** `onCost` hears what a search cost in USD, where the provider bills through AI Gateway. */
export function searchProvider(env: SearchEnv, { onCost }: { onCost?: (usd: number) => void } = {}): SearchProvider {
	const name = env.SEARCH_PROVIDER || "gateway";
	if (name === "gateway") return gatewaySearch(onCost);
	if (name === "brave") return braveSearch(env.BRAVE_API_KEY);
	if (name === "searxng") return searxngSearch(env.SEARXNG_URL);
	return { search: async () => { throw new Error(`Unknown SEARCH_PROVIDER "${name}". Use gateway, brave or searxng.`); } };
}

/** The small model that turns a query into one Exa call; its tokens are a fraction of a cent. */
export const SEARCH_MODEL = "openai/gpt-6-luna";

/**
 * Exa through AI Gateway, billed with the models. Gateway search only runs as a
 * provider-executed tool inside a model call, so this makes one: a small model, made to call
 * exa_search with the query as given, stopped after that step. Exa over Parallel: its input is
 * a plain query and result count, like ours, so the small model only copies them.
 */
export function gatewaySearch(onCost?: (usd: number) => void): SearchProvider {
	return {
		async search(query, { limit }) {
			const { content, providerMetadata } = await generateText({
				model: SEARCH_MODEL,
				tools: { exa_search: gateway.tools.exaSearch({ numResults: limit, contents: { highlights: { maxCharacters: 400 } } }) },
				toolChoice: "required",
				stopWhen: isStepCount(1),
				maxOutputTokens: 200,
				prompt: `Call exa_search once with exactly this query and num_results ${limit}. Query: ${JSON.stringify(query)}`,
			});
			onCost?.(gatewayCost(providerMetadata));
			const output = content.find((p) => p.type === "tool-result")?.output as ExaOutput | undefined;
			if (!output) throw new Error("The search didn't run.");
			if ("error" in output) throw new Error(output.message);
			return output.results.slice(0, limit).map((r) =>
				result(r.title, r.url, r.highlights?.join(" … ") || r.text || "", r.publishedDate),
			);
		},
	};
}

type ExaOutput =
	| { results: { title: string; url: string; publishedDate?: string | null; text?: string; highlights?: string[] }[] }
	| { error: string; message: string };

/** Brave Search API (api-dashboard.search.brave.com), with BRAVE_API_KEY. */
export function braveSearch(key: string | undefined): SearchProvider {
	return {
		async search(query, { limit }) {
			if (!key) throw new Error("Web search isn't set up: BRAVE_API_KEY is missing.");
			const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit) })}`;
			const body = await getJson<{ web?: { results?: { title: string; url: string; description?: string; page_age?: string }[] } }>(url, {
				"X-Subscription-Token": key,
			});
			return (body.web?.results ?? []).slice(0, limit).map((r) => result(r.title, r.url, r.description ?? "", r.page_age));
		},
	};
}

/** A self-hosted SearXNG at SEARXNG_URL, with the JSON format turned on in its settings. */
export function searxngSearch(base: string | undefined): SearchProvider {
	return {
		async search(query, { limit }) {
			if (!base) throw new Error("Web search isn't set up: SEARXNG_URL is missing.");
			const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
			url.search = new URLSearchParams({ q: query, format: "json" }).toString();
			const body = await getJson<{ results?: { title: string; url: string; content?: string; publishedDate?: string | null }[] }>(url.href);
			return (body.results ?? []).slice(0, limit).map((r) => result(r.title, r.url, r.content ?? "", r.publishedDate));
		},
	};
}

/** Snippets come as text: providers' <strong> highlights and entities are dropped. */
function result(title: string, url: string, snippet: string, published?: string | null): SearchResult {
	const text = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!).trim();
	return { title: text(title), url, snippet: text(snippet).slice(0, 500), ...(published && { published }) };
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
	const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`The search service answered ${response.status}.`);
	return (await response.json()) as T;
}
