import type { AutomationStore } from "./automation-tools";
import type { FlexibleSchema, Tool } from "ai";
import type { ChatStore } from "./chat";
import type { MemoryStore } from "./memory";
import type { PageStore } from "./page-tools";
import type { RecordStore } from "./record-tools";
import type { SkillStore } from "./skills";
import type { Risk } from "./action-rules";
import type { Permission } from "./permissions";
import type { Actor } from "./types";

/** What a tool can reach while it runs. */
export interface ToolContext {
	actor: Actor;
	/** The actor's IANA time zone (see resolveTimeZone). UTC when left out. */
	timeZone?: string;
	agentId: string;
	memory: MemoryStore;
	/** The chats the actor can see, and the message this turn answers. */
	chat: ChatStore;
	/** Installed skills, and creation as the actor. */
	skills: SkillStore;
	/** Automations, as the actor can see and make them. */
	automations: AutomationStore;
	/** Records (the CRM), as the actor may read and change them. */
	records: RecordStore;
	/** Pages and records' page bodies, as the actor may read and change them. */
	pages: PageStore;
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

export type ToolSource = { type: "builtin" } | { type: "connector"; connectorId: string };

/**
 * A tool an agent can call. Built-in tools are defined in code; connector tools are
 * discovered from the connector's MCP server each turn (see mcp.ts). Both go through
 * the same grant and role checks in agents.ts.
 *
 * Ids are "group.name": "memory.search", or "<connectorId>.<toolName>" for connectors.
 */
export interface ToolDef<Input = any> {
	id: string;
	/** Its name for people ("Send SMS"). Unset: made from the id (action-words.ts `actionLabel`). */
	title?: string;
	description: string;
	/** A zod schema, or `jsonSchema(...)` for tools described by an MCP server. */
	input: FlexibleSchema<Input>;
	/** Only roles with this permission may use it (permissions.ts). Omit for everyone. */
	permission?: Permission;
	/** True when the tool only reads. Unknown counts as a write. */
	readOnly?: boolean;
	/**
	 * What a call can do outside the workspace (action-rules.ts `Risk`): "outside" asks first,
	 * "locked" always asks with no "Always allow". Set it on any built-in that sends, calls,
	 * pays, deletes, or sends in bulk. Default: connector tools not marked read-only are
	 * "outside"; everything else runs right away.
	 */
	risk?: Risk;
	/** Returns data worth showing. Results get a ref widgets can point at; see ResultStore. */
	returnsData?: boolean;
	source: ToolSource;
	execute(input: Input, ctx: ToolContext): Promise<unknown>;
	/** What the model sees instead of the raw result, e.g. a short receipt for widgets. */
	toModelOutput?: Tool["toModelOutput"];
	/**
	 * What one call did, for its tool line ("Save Acme Roofing"), from its input and, once it
	 * finished, its result (a data tool's `data`; `{ error }` results included). Undefined: `title`.
	 */
	label?(input: Input, output?: unknown): string | undefined;
}

export const defineTool = <Input>(tool: Omit<ToolDef<Input>, "source">): ToolDef<Input> => ({
	...tool,
	source: { type: "builtin" },
});

/** "memory.search" → "memory". */
export const toolGroup = (id: string) => id.slice(0, id.indexOf("."));

/**
 * Whether an agent's grants cover a tool. A grant is an exact id ("memory.search")
 * or a whole group ("memory.*", "gmail.*"), so new connector tools are covered automatically.
 */
export const isGranted = (grants: readonly string[], toolId: string) =>
	grants.includes(toolId) || grants.includes(`${toolGroup(toolId)}.*`);

/** The name the model sees. Model APIs allow letters, digits, "_" and "-", up to 64 characters. */
export const modelToolName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
