import type { ManageStore } from "./manage-tools";
import type { AutomationStore } from "./automation-tools";
import type { WakeupStore } from "./wakeups";
import type { FlexibleSchema, JSONValue, Tool } from "ai";
import type { ChatStore } from "./chat";
import type { ImageStore } from "./image-tools";
import type { MemoryStore } from "./memory";
import type { PageStore } from "./page-tools";
import type { RecordStore } from "./record-tools";
import type { SkillStore } from "./skills";
import type { Risk } from "./action-rules";
import type { Permission } from "./permissions";
import type { Actor } from "./types";
import type { WebTurn } from "./web";

/** What a tool can reach while it runs. */
export interface ToolContext {
	actor: Actor;
	manage: ManageStore;
	/** The actor's IANA time zone (see resolveTimeZone). UTC when left out. */
	timeZone?: string;
	agentId: string;
	memory: MemoryStore;
	/** The chats the actor can see, and the message this turn answers. */
	chat: ChatStore;
	/** Loading installed skills, and creation, as the actor. */
	skills: SkillStore;
	/** Automations, as the actor can see and make them. */
	automations: AutomationStore;
	/** Wakeups: follow-ups the agent sets, and speaking up from a quiet wake turn. */
	wakeups: WakeupStore;
	/** Records (the CRM), as the actor may read and change them. */
	records: RecordStore;
	/** Pages and records' page bodies, as the actor may read and change them. */
	pages: PageStore;
	/** This turn's data results, by ref, so widgets can show them. */
	results: ResultStore;
	/** Web search and pages, capped per turn (web.ts). */
	web: WebTurn;
	/** Making pictures for the reply, within the workspace's image budget (image-tools.ts). */
	images: ImageStore;
	/**
	 * The stores for one model call, keyed by its call id, so the runner can make each write once per call
	 * (a retried step doesn't write twice). buildToolSet uses them for every call when given.
	 */
	forCall?(callId: string): Partial<ToolContext>;
	/** This call's operation key (backend approvals.ts), for tools whose effect takes several steps (`untransacted`). */
	op?: object;
	/**
	 * Claims a connector call that changes something, by its call id, before it's sent (when its tool takes no
	 * idempotency key): `start` returns what to answer instead if this call already went, else null; `finish` saves
	 * its result. The runner keeps them in the database, so a retried step never sends it twice.
	 */
	calls?: {
		start(callId: string): Promise<unknown>;
		finish(callId: string, output: unknown): Promise<unknown>;
	};
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

/** Something a call's effect depends on as it is now, by id (`ToolDef.binds`). */
export type Bound = { kind: "page" | "recordPage" | "pageVersion" | "record" | "memory" | "message" | "agent" | "skill" | "automation"; id: string };

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
	 * "outside"; built-in writes are "inside" (ask in runs following others' words), and reads are "none".
	 */
	risk?: Risk;
	/** Per-call risk for grouped built-ins whose actions need different consent. */
	riskFor?(input: Input): Risk;
	/**
	 * What this call's effect depends on as it is now (a page it overwrites or archives, a memory it
	 * rewrites). A held call's approval binds their current revisions too (backend approvals.ts), so a
	 * change made after the person saw the card stops it instead of running on what they didn't see.
	 */
	binds?(input: Input): Bound[];
	/**
	 * Its input leaves the workspace (a search query, a link to open): when the turn has read something not
	 * everyone in the chat may see, the call asks first, showing exactly what goes out (backend permissions.check).
	 */
	sendsOut?: boolean;
	/**
	 * Its effects take several steps outside one transaction (a provider call, then files): cut off after it was
	 * approved, it may or may not have happened, so the card says so rather than "nothing changed".
	 */
	untransacted?: boolean;
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
	/** A thread a finished call made, for its tool line to open (chat.ask_agent's). */
	opens?(output: unknown): { chatId: string; messageId: string; kind?: "message" } | undefined;
}

/** `toModelOutput` for a result the model reads as JSON. Tool results are plain data already. */
export const jsonOutput = (value: unknown) => ({ type: "json" as const, value: value as JSONValue });

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

/** A string at `key` of a tool's input or result, if there is one. */
export function resultText(from: unknown, key: string) {
	const v = from && typeof from === "object" ? (from as Record<string, unknown>)[key] : undefined;
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
