import { actionLabel } from "./action-words";
import { CONNECTOR_CALL, CONNECTOR_SEARCH, type ConnectorService, calledConnectorTool } from "./connector-tools";
import { type ToolDef, modelToolName, dataOf } from "./tools";
import { isWidgetToolName } from "./widgets";

/**
 * The activity log: one entry per tool call an agent makes, with what went in and
 * what came out, so people can check what an agent did on their behalf.
 */

/** Longest input or output kept per entry, in characters. */
export const ACTIVITY_MAX_CHARS = 4_000;

export interface LoggedCall {
	/** The tool's id ("memory.create", "<connector>.<tool>"), or the model's name for it if unknown. */
	tool: string;
	input: unknown;
	/** False only for tools marked read-only. */
	changes: boolean;
}

/**
 * What to log for a call by model tool name. A connectors_call logs as the tool it ran,
 * with that tool's input. Widgets (shown in the reply) and connectors_search (finding
 * tools) aren't actions, so they return null.
 */
export function describeCall(modelName: string, input: unknown, tools: ToolDef[]): LoggedCall | null {
	if (isWidgetToolName(modelName) || modelName === CONNECTOR_SEARCH) return null;
	if (modelName === CONNECTOR_CALL) {
		const id = calledConnectorTool(input) ?? CONNECTOR_CALL;
		const t = tools.find((x) => x.id === id);
		const inner = input && typeof input === "object" && "input" in input ? input.input : input;
		return { tool: id, input: inner, changes: t?.readOnly !== true };
	}
	const t = tools.find((x) => modelToolName(x.id) === modelName);
	return { tool: t?.id ?? modelName, input, changes: t?.readOnly !== true };
}

/**
 * What a call did, for its tool line (action-words.ts `toolLine`): "Send SMS with Fake CRM",
 * "Look up Fake CRM actions", "Save Acme Roofing". `name` is the model's tool name, or a tool id.
 * With the call's input (and output, once it's done), tools with `label` say what this call did.
 */
export function callLabel(
	name: string,
	tools: ToolDef[],
	services: Pick<ConnectorService, "id" | "name">[],
	call?: { input: unknown; output?: unknown },
) {
	if (name === CONNECTOR_SEARCH) return services.length === 1 ? `Look up ${services[0]!.name} actions` : "Look up connected actions";
	const t = tools.find((x) => x.id === name || modelToolName(x.id) === name);
	const service = t?.source.type === "connector" ? services.find((s) => t.source.type === "connector" && s.id === t.source.connectorId) : undefined;
	return `${(call && t?.label?.(call.input ?? {}, dataOf(call.output))) || actionLabel(t?.id ?? name, t?.title)}${service ? ` with ${service.name}` : ""}`;
}

/**
 * How a finished call ended. Tools report expected problems as `{ error }` instead of
 * throwing (asToolResult, connector errors), so the model can read them; the reply's
 * tool line and the activity log still count those as failed.
 */
export function callEnd(output: unknown): { output: unknown } | { error: string } {
	return output && typeof output === "object" && "error" in output ? { error: String(output.error) } : { output };
}

/** A value as JSON, cut to ACTIVITY_MAX_CHARS. */
export function clipJson(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
	} catch {
		text = String(value);
	}
	return text.length > ACTIVITY_MAX_CHARS ? `${text.slice(0, ACTIVITY_MAX_CHARS)}\n… (cut)` : text;
}
