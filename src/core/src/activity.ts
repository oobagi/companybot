import { PLUGIN_CALL, PLUGIN_SEARCH, calledPluginTool } from "./plugin-tools";
import { type ToolDef, modelToolName } from "./tools";
import { isWidgetToolName } from "./widgets";

/**
 * The activity log: one entry per tool call an agent makes, with what went in and
 * what came out, so people can check what an agent did on their behalf.
 */

/** Longest input or output kept per entry, in characters. */
export const ACTIVITY_MAX_CHARS = 4_000;

export interface LoggedCall {
	/** The tool's id ("memory.create", "<plugin>.<tool>"), or the model's name for it if unknown. */
	tool: string;
	input: unknown;
	/** False only for tools marked read-only. */
	changes: boolean;
}

/**
 * What to log for a call by model tool name. A plugins_call logs as the tool it ran,
 * with that tool's input. Widgets (shown in the reply) and plugins_search (finding
 * tools) aren't actions, so they return null.
 */
export function describeCall(modelName: string, input: unknown, tools: ToolDef[]): LoggedCall | null {
	if (isWidgetToolName(modelName) || modelName === PLUGIN_SEARCH) return null;
	if (modelName === PLUGIN_CALL) {
		const id = calledPluginTool(input) ?? PLUGIN_CALL;
		const t = tools.find((x) => x.id === id);
		const inner = input && typeof input === "object" && "input" in input ? input.input : input;
		return { tool: id, input: inner, changes: t?.readOnly !== true };
	}
	const t = tools.find((x) => modelToolName(x.id) === modelName);
	return { tool: t?.id ?? modelName, input, changes: t?.readOnly !== true };
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
