import type { FlexibleSchema, Tool } from "ai";
import type { ChatStore } from "./chat";
import type { MemoryStore } from "./memory";
import type { Skill } from "./skills";
import type { Actor, Role } from "./types";

/** What a tool can reach while it runs. */
export interface ToolContext {
	actor: Actor;
	agentId: string;
	memory: MemoryStore;
	/** The chats the actor can see, and the message this turn answers. */
	chat: ChatStore;
	/** Skills installed in the workspace. */
	skills: Skill[];
	/** This turn's data results, by ref, so widgets can show them. */
	results: ResultStore;
}

/**
 * Data tools' results for one turn. Each gets a short ref ("r1") that the model
 * sees with the result; a widget can then point at it ("show r1's leads") instead
 * of copying every row back out, which is slow, costly, and can drift from the data.
 */
export interface ResultStore {
	save(data: unknown): string;
	get(ref: string): unknown;
}

export function createResultStore(): ResultStore {
	const results = new Map<string, unknown>();
	return {
		save(data) {
			const ref = `r${results.size + 1}`;
			results.set(ref, data);
			return ref;
		},
		get: (ref) => results.get(ref),
	};
}

export type ToolSource = { type: "builtin" } | { type: "plugin"; pluginId: string };

/**
 * A tool an agent can call. Built-in tools are defined in code; plugin tools are
 * discovered from the plugin's MCP server each turn (see mcp.ts). Both go through
 * the same grant and role checks in agents.ts.
 *
 * Ids are "group.name": "memory.search", or "<pluginId>.<toolName>" for plugins.
 */
export interface ToolDef<Input = any> {
	id: string;
	description: string;
	/** A zod schema, or `jsonSchema(...)` for tools described by an MCP server. */
	input: FlexibleSchema<Input>;
	/** Roles allowed to use this tool. Omit for everyone. */
	roles?: Role[];
	/** True when the tool only reads. Unknown counts as a write. */
	readOnly?: boolean;
	/** Returns data worth showing. Results get a ref widgets can point at; see ResultStore. */
	returnsData?: boolean;
	source: ToolSource;
	execute(input: Input, ctx: ToolContext): Promise<unknown>;
	/** What the model sees instead of the raw result, e.g. a short receipt for widgets. */
	toModelOutput?: Tool["toModelOutput"];
}

export const defineTool = <Input>(tool: Omit<ToolDef<Input>, "source">): ToolDef<Input> => ({
	...tool,
	source: { type: "builtin" },
});

/** "memory.search" → "memory". */
export const toolGroup = (id: string) => id.slice(0, id.indexOf("."));

/**
 * Whether an agent's grants cover a tool. A grant is an exact id ("memory.search")
 * or a whole group ("memory.*", "gmail.*"), so new plugin tools are covered automatically.
 */
export const isGranted = (grants: readonly string[], toolId: string) =>
	grants.includes(toolId) || grants.includes(`${toolGroup(toolId)}.*`);

/** The name the model sees. Model APIs allow letters, digits, "_" and "-", up to 64 characters. */
export const modelToolName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
