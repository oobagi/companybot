/** A model an agent can run on, through Vercel AI Gateway. Prices are USD per million tokens. */
export interface ModelInfo {
	id: string;
	name: string;
	/** The part of `id` before the slash ("anthropic"). */
	provider: string;
	contextWindow?: number;
	input?: number;
	output?: number;
	/** Takes pictures in the prompt (the gateway's `vision` tag). */
	vision?: boolean;
}

/** The recommended pick, and what new agents start on. */
export const defaultModel = "openai/gpt-6-luna";

/** Offered while the gateway's catalog hasn't been fetched (or couldn't be). */
export const fallbackModels: ModelInfo[] = [
	{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", provider: "openai", vision: true },
	{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic", vision: true },
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "anthropic", vision: true },
	{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", provider: "anthropic", vision: true },
];

/** AI Gateway's model list. Public: no key needed. */
export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

type GatewayModel = {
	id?: unknown;
	name?: unknown;
	type?: unknown;
	tags?: unknown;
	context_window?: unknown;
	pricing?: { input?: unknown; output?: unknown; image?: unknown; image_dimension_quality_pricing?: unknown } | null;
};

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
				...(m.tags.includes("vision") && { vision: true }),
			}];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A model that makes pictures, through AI Gateway. Image models (Imagen, FLUX, Recraft, GPT Image)
 * run with `generateImage`; `multimodal` ones are language models that answer with pictures
 * (Nano Banana), run with `generateText`.
 */
export interface ImageModelInfo {
	id: string;
	name: string;
	provider: string;
	multimodal?: boolean;
	/** USD for one picture at the default settings. */
	perImage?: number;
	/** What it's best at, for the picker. */
	use?: string;
}

/** What workspaces make pictures with until an owner picks another. */
export const defaultImageModel = "openai/gpt-image-2.5-flare";

/**
 * The picture models we offer: a short list we've tried, not the gateway's whole catalog, where
 * models come and go. One the gateway stops listing drops out (`catalogImageModels`); adding one
 * is a line here after a test picture. `perImage` is what one default picture cost through AI
 * Gateway on 2026-10-29 (Recraft's is its listed price): shown in the picker and held against the
 * budget while a call runs. The cost recorded is the gateway's.
 */
export const imageModels: ImageModelInfo[] = [
	{ id: "openai/gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", provider: "openai", perImage: 0.007, use: "Fast, everyday pictures" },
	{ id: "openai/gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", provider: "openai", perImage: 0.007, use: "Precise edits" },
	{ id: "google/gemini-nano-banana-2.1", name: "Nano Banana 2.1", provider: "google", multimodal: true, perImage: 0.039, use: "Google's newest" },
	{ id: "bfl/flux-3-image", name: "FLUX 3", provider: "bfl", perImage: 0.048, use: "Photo-real" },
	{ id: "recraft/recraft-v4.1", name: "Recraft V4.1", provider: "recraft", perImage: 0.035, use: "Logos and design" },
];

/** A USD string as a number, if it is one. */
function dollars(price: unknown) {
	const n = typeof price === "string" && price !== "" ? Number(price) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

/** One picture's price: the flat `image` price, else the "default" (or first) size's. */
function perImage(pricing: GatewayModel["pricing"]) {
	const flat = dollars(pricing?.image);
	if (flat !== undefined) return flat;
	const sizes = Array.isArray(pricing?.image_dimension_quality_pricing) ? (pricing.image_dimension_quality_pricing as { size?: unknown; cost?: unknown }[]) : [];
	return dollars((sizes.find((s) => s?.size === "default") ?? sizes[0])?.cost);
}

/**
 * The models in a `GET /v1/models` response that make pictures: the `image-generation` tag, on an
 * image model (`type: "image"`) or a language model (`type: "language"`, so multimodal).
 */
export function parseGatewayImageModels(body: unknown): ImageModelInfo[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	return (data as GatewayModel[])
		.flatMap((m): ImageModelInfo[] => {
			if ((m?.type !== "image" && m?.type !== "language") || !Array.isArray(m.tags) || !m.tags.includes("image-generation")) return [];
			if (typeof m.id !== "string" || !m.id.includes("/")) return [];
			const price = perImage(m.pricing);
			return [{
				id: m.id,
				name: typeof m.name === "string" && m.name ? m.name : m.id,
				provider: m.id.split("/")[0]!,
				...(m.type === "language" && { multimodal: true }),
				...(price !== undefined && { perImage: price }),
			}];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** "Fast, everyday pictures · $0.007 per picture". */
export const imageModelNote = (m: ImageModelInfo) => [m.use, m.perImage !== undefined && `${usd(m.perImage)} per picture`].filter(Boolean).join(" · ");

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
export function searchModels<M extends Pick<ModelInfo, "id" | "name">>(models: readonly M[], search = ""): M[] {
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((m) => {
		const text = `${m.name} ${m.id}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
}
