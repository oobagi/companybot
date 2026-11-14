import type { ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai";
import { isWidgetToolName } from "./widgets";

/**
 * A turn's tool steps, kept so later turns replay them as the model saw them: its tool calls and
 * their results, in the messages the provider takes (ChatGPT and Claude replay tool results the same
 * way). Without them a later turn can't tell what it did or use what it got back (a record id, a file
 * id). The final answer isn't a step: the turn keeps its decision (backend turns.ts sessionTurns).
 */

/** Longest result a later turn replays, in characters: enough for ids and facts; it can call again for the rest. */
export const REPLAY_RESULT_CHARS = 4_000;
/** Longest call input a later turn replays (a page's whole Markdown, say). */
export const REPLAY_INPUT_CHARS = 20_000;

/** What a call held for the person's approval gets as its result: providers refuse a call with none. */
export const HELD_RESULT = "Not run yet: held for the person's approval. If they decide, you're told in a later message.";
/** A result someone else's turn got, replayed to a person who may not see it (activity log rule). */
export const PRIVATE_RESULT = "Only the person this was done for sees its result.";

const cut = (text: string, max: number) => `${text.slice(0, max)}\n[Cut to ${max.toLocaleString("en-US")} characters for later replies. Call again for the rest.]`;

/** A result as kept: the same, cut to REPLAY_RESULT_CHARS, with no provider metadata. */
function keptOutput(output: ToolResultPart["output"]): ToolResultPart["output"] {
	switch (output.type) {
		case "text":
		case "error-text":
			return { type: output.type, value: output.value.length > REPLAY_RESULT_CHARS ? cut(output.value, REPLAY_RESULT_CHARS) : output.value };
		case "json":
		case "error-json": {
			const text = JSON.stringify(output.value) ?? "null";
			if (text.length <= REPLAY_RESULT_CHARS) return { type: output.type, value: output.value };
			return { type: output.type === "json" ? "text" : "error-text", value: cut(text, REPLAY_RESULT_CHARS) };
		}
		case "execution-denied":
			return { type: "execution-denied", ...(output.reason && { reason: output.reason }) };
		case "content": {
			const text = output.value.map((p) => (p.type === "text" ? p.text : "(A file, not kept.)")).join("\n");
			return { type: "text", value: text.length > REPLAY_RESULT_CHARS ? cut(text, REPLAY_RESULT_CHARS) : text };
		}
	}
}

function keptInput(input: unknown): unknown {
	const text = JSON.stringify(input) ?? "null";
	return text.length > REPLAY_INPUT_CHARS ? { cut: cut(text, REPLAY_INPUT_CHARS) } : input;
}

/**
 * One finished step as kept (AI SDK `onStepEnd`'s `response.messages`): its text and tool calls, and
 * their results. Reasoning, approval requests and provider metadata go: providers reject another
 * turn's. Empty for a step that called no tool (the answer, kept as the turn's decision).
 */
export function keptStep(messages: readonly ModelMessage[]): ModelMessage[] {
	const calls = messages.some((m) => m.role === "assistant" && typeof m.content !== "string" && m.content.some((p) => p.type === "tool-call"));
	if (!calls) return [];
	return messages.flatMap((m): ModelMessage[] => {
		if (m.role === "assistant" && typeof m.content !== "string") {
			const content = m.content.flatMap((p): (TextPart | ToolCallPart)[] =>
				p.type === "text" && p.text.trim()
					? [{ type: "text", text: p.text }]
					: p.type === "tool-call"
						? [{ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: keptInput(p.input) }]
						: [],
			);
			return content.length ? [{ role: "assistant", content }] : [];
		}
		if (m.role === "tool") {
			const content = m.content.flatMap((p): ToolResultPart[] => (p.type === "tool-result" ? [{ type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: keptOutput(p.output) }] : []));
			return content.length ? [{ role: "tool", content }] : [];
		}
		return [];
	});
}

/**
 * Kept steps as someone else's turn may replay them. `details`: they may see what the reply used
 * (backend canReadReplyDetails); else only its widgets, which show in the reply, replay. `results`:
 * the turn acted for them; else results are hidden, as in the activity log.
 */
export function stepsFor(steps: readonly ModelMessage[], { details, results }: { details: boolean; results: boolean }): ModelMessage[] {
	if (details && results) return [...steps];
	const keep = (name: string) => details || isWidgetToolName(name);
	return steps.flatMap((m): ModelMessage[] => {
		if (m.role === "assistant" && typeof m.content !== "string") {
			const content = m.content.filter((p) => (p.type === "tool-call" ? keep(p.toolName) : details));
			return content.length ? [{ ...m, content }] : [];
		}
		if (m.role === "tool") {
			const content = m.content.flatMap((p) =>
				p.type !== "tool-result" || !keep(p.toolName) ? [] : [results || isWidgetToolName(p.toolName) ? p : { ...p, output: { type: "text" as const, value: PRIVATE_RESULT } }],
			);
			return content.length ? [{ role: "tool", content }] : [];
		}
		return [m];
	});
}

/** Steps with a result for every call, as providers require: a call held for approval has none. */
export function paired(steps: readonly ModelMessage[]): ModelMessage[] {
	const answered = new Set(steps.flatMap((m) => (m.role === "tool" ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.toolCallId] : [])) : [])));
	return steps.flatMap((m): ModelMessage[] => {
		if (m.role !== "assistant" || typeof m.content === "string") return [m];
		const missing = m.content.flatMap((p) =>
			p.type === "tool-call" && !answered.has(p.toolCallId) ? [{ type: "tool-result" as const, toolCallId: p.toolCallId, toolName: p.toolName, output: { type: "text" as const, value: HELD_RESULT } }] : [],
		);
		return missing.length ? [m, { role: "tool", content: missing }] : [m];
	});
}

/** The tools a turn called, by name, for its summary (backend compaction): what it did, not what it got back. */
export const calledTools = (steps: readonly ModelMessage[]) =>
	steps.flatMap((m) => (m.role === "assistant" && typeof m.content !== "string" ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolName] : [])) : []));
