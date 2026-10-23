import { type ToolSet, asSchema, tool } from "ai";
import { z } from "zod";
import type { ToolDef } from "./tools";

/**
 * Plugin tools aren't sent to the model up front: one MCP server can carry dozens of
 * tools and tens of thousands of tokens of schemas, on every call. Instead the model
 * gets two fixed tools: `plugins_search` returns matching tools with their input
 * schemas, and `plugins_call` runs one. The tool list never changes, so prompt
 * caching keeps working, and it works the same on every model.
 */
export const PLUGIN_SEARCH = "plugins_search";
export const PLUGIN_CALL = "plugins_call";
const SEARCH_LIMIT = 5;

/** A connected service's name and the usage notes its MCP server sends, if any. */
export interface PluginService {
	id: string;
	name: string;
	instructions?: string;
}

export function pluginMetaTools(
	tools: ToolDef[],
	services: PluginService[],
	run: (t: ToolDef, input: unknown) => Promise<unknown>,
): ToolSet {
	const byId = new Map(tools.map((t) => [t.id, t]));
	return {
		[PLUGIN_SEARCH]: tool({
			description:
				"Find tools for connected services (listed in each message). An empty query lists every tool and each service's usage notes; start there with a service you haven't used yet in this conversation. Otherwise returns up to 5 matches with input schemas. Exact tool ids work as queries.",
			inputSchema: z.object({ query: z.string().describe("A few words ('find leads'), exact tool ids, or empty to list all") }),
			execute: async ({ query }) => {
				if (tools.length === 0) return { error: "No connected services right now." };
				if (!query.trim()) {
					return {
						services: services.map((s) => ({ name: s.name, ...(s.instructions && { notes: s.instructions }) })),
						tools: tools.map((t) => ({ tool: t.id, description: firstLine(t.description) })),
					};
				}
				const matches = (await rank(tools, query)).slice(0, SEARCH_LIMIT);
				if (matches.length === 0) return { tools: [], note: "No match. Try other words, or an empty query to list all." };
				return { tools: matches.map(({ t, schema }) => ({ tool: t.id, description: t.description, input: schema })) };
			},
		}),
		[PLUGIN_CALL]: tool({
			description: "Run a connected-service tool found with plugins_search. `input` must match its schema.",
			inputSchema: z.object({
				tool: z.string().describe("The tool's id from plugins_search"),
				input: z.record(z.string(), z.unknown()).default({}),
			}),
			execute: async ({ tool: id, input }) => {
				const t = byId.get(id);
				if (!t) return { error: `No connected tool "${id}". Use plugins_search first.` };
				const check = await asSchema(t.input).validate?.(input);
				if (check && !check.success) return { error: `Input doesn't match ${id}'s schema: ${check.error.message}` };
				return run(t, check?.success ? check.value : input);
			},
		}),
	};
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Tools ranked by query words found in their id, description, and argument names.
 * Rare words count more (words every tool shares, like the service's name, count
 * for nothing), and an exact tool id always wins.
 */
async function rank(tools: ToolDef[], query: string) {
	const docs = await Promise.all(
		tools.map(async (t) => {
			const schema = await asSchema(t.input).jsonSchema;
			const props = Object.keys((schema as { properties?: object }).properties ?? {}).join(" ");
			return { t, schema, id: new Set(words(t.id)), text: new Set(words(`${t.description} ${props}`)) };
		}),
	);
	const q = [...new Set(words(query))];
	const weight = new Map(q.map((w) => [w, Math.log(1 + docs.length / Math.max(1, docs.filter((d) => d.id.has(w) || d.text.has(w)).length))]));
	const exact = new Set(query.split(/[\s,]+/));
	return docs
		.map((d) => ({
			...d,
			score: exact.has(d.t.id) ? Number.POSITIVE_INFINITY : q.reduce((sum, w) => sum + weight.get(w)! * ((d.id.has(w) ? 3 : 0) + (d.text.has(w) ? 1 : 0)), 0),
		}))
		.filter((d) => d.score > 0)
		.sort((a, b) => b.score - a.score);
}

const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 160);

/** Which tool a `plugins_call` ran, for showing tool activity. */
export const calledPluginTool = (input: unknown) =>
	input && typeof input === "object" && "tool" in input && typeof input.tool === "string" ? input.tool : undefined;
