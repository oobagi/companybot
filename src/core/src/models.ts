/** A model an agent can run on, through Vercel AI Gateway. Prices are USD per million tokens. */
export interface ModelInfo {
	id: string;
	name: string;
	/** The part of `id` before the slash ("anthropic"). */
	provider: string;
	contextWindow?: number;
	input?: number;
	output?: number;
}

/** The recommended pick, and what new agents start on. */
export const defaultModel = "anthropic/claude-sonnet-5.5";

/** Offered while the gateway's catalog hasn't been fetched (or couldn't be). */
export const fallbackModels: ModelInfo[] = [
	{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic" },
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "anthropic" },
	{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic" },
];

/** AI Gateway's model list. Public: no key needed. */
export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

type GatewayModel = { id?: unknown; name?: unknown; type?: unknown; tags?: unknown; context_window?: unknown; pricing?: { input?: unknown; output?: unknown } | null };

/** Per-token USD string → per million tokens. */
function perMillion(price: unknown) {
	const n = typeof price === "string" && price !== "" ? Number(price) : NaN;
	return Number.isFinite(n) ? Math.round(n * 1e10) / 1e4 : undefined;
}

/** The models in a `GET /v1/models` response that can run an agent: language models that call tools. */
export function parseGatewayModels(body: unknown): ModelInfo[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	return (data as GatewayModel[])
		.flatMap((m): ModelInfo[] => {
			if (m?.type !== "language" || !Array.isArray(m.tags) || !m.tags.includes("tool-use")) return [];
			if (typeof m.id !== "string" || !m.id.includes("/")) return [];
			const input = perMillion(m.pricing?.input);
			const output = perMillion(m.pricing?.output);
			return [{
				id: m.id,
				name: typeof m.name === "string" && m.name ? m.name : m.id,
				provider: m.id.split("/")[0]!,
				...(typeof m.context_window === "number" && { contextWindow: m.context_window }),
				...(input !== undefined && { input }),
				...(output !== undefined && { output }),
			}];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
const usd = (n: number) => `$${+n.toFixed(n < 1 ? 3 : 2)}`;

/** "1M context · $3 / $15 per M tokens", or "" when the gateway said neither. */
export function modelNote(m: ModelInfo) {
	const parts = [];
	if (m.contextWindow) parts.push(`${tokens(m.contextWindow)} context`);
	if (m.input !== undefined && m.output !== undefined) parts.push(`${usd(m.input)} / ${usd(m.output)} per M tokens`);
	return parts.join(" · ");
}

/** Models whose name or id has every word of `search`. */
export function searchModels<M extends ModelInfo>(models: readonly M[], search = ""): M[] {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((m) => {
		const text = `${m.name} ${m.id}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
}
