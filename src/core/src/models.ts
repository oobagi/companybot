/** Models an agent can run on, through Vercel AI Gateway. */
export const models = [
	{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", note: "Balanced. A good default." },
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", note: "Fastest and cheapest." },
	{ id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", note: "Smartest, slowest, priciest." },
] as const;

export type ModelId = (typeof models)[number]["id"];
