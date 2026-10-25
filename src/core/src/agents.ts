import { type ToolSet, asSchema, tool } from "ai";
import { callEnd } from "./activity";
import type { AgentConfig } from "./agent-config";
import { type PermissionDecision, deniedReason, permissionFor, toolRisk } from "./approvals";
import { builtinTools } from "./builtin-tools";
import { models } from "./models";
import { can } from "./permissions";
import { CONNECTOR_CALL, type ConnectorService, calledConnectorTool, connectorMetaTools } from "./connector-tools";
import { findConnector } from "./connectors";
import { type ToolContext, type ToolDef, isGranted, modelToolName, toolGroup } from "./tools";
import type { Actor, Role } from "./types";

export const defineAgent = (agent: AgentConfig) => agent;

const builtinGroups = new Set(builtinTools.map((t) => toolGroup(t.id)));

/** A grant names a built-in tool, a built-in group, or a catalog connector. */
function isKnownGrant(grant: string) {
	const group = toolGroup(grant);
	if (!group) return false;
	if (grant.endsWith(".*")) return builtinGroups.has(group) || !!findConnector(group);
	return builtinTools.some((t) => t.id === grant) || !!findConnector(group);
}

/** Returns a message people can read, or null if the config is fine. */
export function validateAgentConfig(config: AgentConfig): string | null {
	const name = config.name.trim();
	if (!name) return "Give the agent a name.";
	if (name.length > 40) return "Keep the name under 40 characters.";
	if (config.description.length > 200) return "Keep the description under 200 characters.";
	if (config.instructions.length > 20_000) return "Instructions are too long (20,000 characters max).";
	if (!models.some((m) => m.id === config.model)) return "Pick a model from the list.";
	const unknown = config.tools.find((id) => !isKnownGrant(id));
	if (unknown) return `Unknown tool: ${unknown}`;
	return null;
}

/** Where a connector stands for this person, from the backend. */
export interface ConnectorState {
	id: string;
	/** Roles the workspace allows to use it. */
	roles: Role[];
	/** Has a usable connection for this person (theirs, or the workspace's). */
	connected: boolean;
}

export type ToolAccess =
	| { id: string; visible: true }
	| { id: string; visible: false; reason: "role" | "not_found" | "not_installed" | "not_connected" };

/**
 * For each of an agent's grants, whether this person can use it and why not.
 * A tool reaches the model only if the agent grants it, the person's role allows
 * it, and (for connectors) the connector is installed, allowed, and connected.
 */
export function describeToolAccess(
	agent: Pick<AgentConfig, "tools">,
	actor: Actor,
	connectors: ConnectorState[] = [],
): ToolAccess[] {
	return agent.tools.flatMap((id): ToolAccess[] => {
		const group = toolGroup(id);
		if (findConnector(group)) {
			const state = connectors.find((p) => p.id === group);
			if (!state) return [{ id, visible: false, reason: "not_installed" }];
			if (!state.roles.includes(actor.role)) return [{ id, visible: false, reason: "role" }];
			if (!state.connected) return [{ id, visible: false, reason: "not_connected" }];
			return [{ id, visible: true }];
		}
		// Built-in grants are listed tool by tool, so a group shows which of its tools are hidden.
		const defs = builtinTools.filter((t) => (id.endsWith(".*") ? toolGroup(t.id) === group : t.id === id));
		if (defs.length === 0) return [{ id, visible: false, reason: "not_found" }];
		return defs.map((d) => (canUseTool(actor, d) ? { id: d.id, visible: true } : { id: d.id, visible: false, reason: "role" }));
	});
}

/** Whether this person's role may use a tool: it needs no permission, or they have it. */
export const canUseTool = (who: Actor | Role, tool: Pick<ToolDef, "permission">) => !tool.permission || can(who, tool.permission);

/**
 * The tools this agent can use for this person, out of `available` (built-ins plus
 * whatever connector tools were loaded for the turn). Connector role checks happen when
 * connectors are loaded; tool-level `permission` is checked here.
 */
export function resolveTools(
	agent: Pick<AgentConfig, "tools">,
	actor: Actor,
	available: ToolDef[] = builtinTools,
): ToolDef[] {
	return available.filter((t) => isGranted(agent.tools, t.id) && canUseTool(actor, t));
}

/** Builds the AI SDK tool set for one run. */
export function buildToolSet(
	agent: Pick<AgentConfig, "tools">,
	ctx: ToolContext,
	available: ToolDef[] = builtinTools,
	/** Connected connectors' names and usage notes, shown by connectors_search. */
	services: ConnectorService[] = [],
): ToolSet {
	const tools: ToolSet = {};
	const run = (t: ToolDef, input: unknown) => (t.returnsData ? withRef(t.execute(input, ctx), ctx) : t.execute(input, ctx));
	const resolved = resolveTools(agent, ctx.actor, available);
	for (const t of resolved.filter((t) => t.source.type === "builtin")) {
		tools[modelToolName(t.id)] = tool({
			description: t.description,
			inputSchema: t.input,
			execute: (input) => run(t, input),
			...(t.toModelOutput && { toModelOutput: t.toModelOutput }),
		});
	}
	// Connector tools load on demand (see connector-tools.ts). Present whenever the agent is
	// granted a connector, connected or not, so the tool list stays the same turn to turn.
	const connectorTools = resolved.filter((t) => t.source.type === "connector");
	if (connectorTools.length > 0 || grantedConnectorIds(agent).length > 0) Object.assign(tools, connectorMetaTools(connectorTools, services, run));
	return tools;
}

/** Wraps a data tool's result as `{ ref, data }`. Errors pass through unchanged. */
async function withRef(output: Promise<unknown>, ctx: ToolContext) {
	const data = await output;
	if ("error" in callEnd(data)) return data;
	return { ref: ctx.results.save(data), data };
}

/** Connectors an agent's grants reach, so the runner only connects to those. */
export const grantedConnectorIds = (agent: Pick<AgentConfig, "tools">) =>
	[...new Set(agent.tools.map(toolGroup))].filter((group) => !!findConnector(group));

/**
 * The action a model call runs: the tool and its exact input, or null if it names no
 * tool this person can use. A connectors_call is the tool it runs, with that tool's
 * input, once the input matches the tool's schema (a bad one runs as is, so the model
 * gets the schema error back). `tools` are the ones this person can use (resolveTools).
 */
export async function actionOf(modelName: string, input: unknown, tools: ToolDef[]): Promise<{ tool: ToolDef; input: unknown } | null> {
	if (modelName === CONNECTOR_CALL) {
		const t = tools.find((x) => x.id === calledConnectorTool(input));
		if (!t) return null;
		const inner = (input as { input?: unknown }).input ?? {};
		const check = await asSchema(t.input).validate?.(inner);
		if (check && !check.success) return null;
		return { tool: t, input: check?.success ? check.value : inner };
	}
	const t = tools.find((x) => modelToolName(x.id) === modelName);
	return t ? { tool: t, input } : null;
}

/**
 * Decides one call from the rules in force right now (see approvals.permissionFor).
 * The runner reads them fresh for every call. Default: the tool's risk alone.
 */
export type PermissionCheck = (tool: ToolDef, callId: string) => Promise<PermissionDecision>;

const byRiskOnly: PermissionCheck = async (t) => permissionFor({ risk: toolRisk(t) });

/**
 * The AI SDK `toolApproval` setting for one run. Calls that ask stop the run there,
 * unexecuted; blocked ones never run and the model is told why. Built-ins with no risk
 * skip the check: rules and locks only cover actions that can ask, plus connector reads.
 */
export const toolApprovalPolicy =
	(tools: ToolDef[], check: PermissionCheck = byRiskOnly) =>
	async ({ toolCall }: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => {
		const action = await actionOf(toolCall.toolName, toolCall.input, tools);
		if (!action || (action.tool.source.type === "builtin" && toolRisk(action.tool) === "none")) return undefined;
		const decision = await check(action.tool, toolCall.toolCallId);
		if (decision.type === "ask") return "user-approval" as const;
		if (decision.type === "deny") return { type: "denied" as const, reason: deniedReason(decision.by, action.tool.id) };
		return undefined;
	};
