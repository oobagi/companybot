import type { FlexibleSchema, Tool } from "ai";
import type { MemoryStore } from "./memory";
import type { Skill } from "./skills";
import type { Actor, Role } from "./types";

/** What a tool can reach while it runs. */
export interface ToolContext {
	actor: Actor;
	agentId: string;
	memory: MemoryStore;
	/** Skills installed in the workspace. */
	skills: Skill[];
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
