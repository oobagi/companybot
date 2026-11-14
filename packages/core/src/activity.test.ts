import { skills } from "../test/fixtures";
import { describe, expect, it } from "vitest";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ACTIVITY_MAX_CHARS, callEnd, callLabel, clipJson, describeCall } from "./activity";
import { buildToolSet } from "./agents";
import { builtinTools } from "./builtin-tools";
import { toolLine } from "./action-words";

import { type ToolDef, modelToolName } from "./tools";
import { z } from "zod";

import { owner, ctx } from "../test/helpers";

describe("activity log", () => {
	const notesFind: ToolDef = {
		id: "notes.find",
		description: "Find notes",
		input: z.object({}),
		readOnly: true,
		source: { type: "connector", connectorId: "notes" },
		execute: async () => [],
	};
	const tools = [...builtinTools, notesFind];

	it("logs calls by tool id, and connector calls as the tool they ran", () => {
		expect(describeCall(modelToolName("memory.remember"), { content: "x" }, tools)).toEqual({
			tool: "memory.remember",
			input: { content: "x" },
			changes: true,
		});
		expect(describeCall(modelToolName("clock.now"), {}, tools)?.changes).toBe(false);
		expect(describeCall("connectors_call", { tool: "notes.find", input: { q: "a" } }, tools)).toEqual({
			tool: "notes.find",
			input: { q: "a" },
			changes: false,
		});
		expect(describeCall("connectors_call", { tool: "notes.gone", input: {} }, tools)?.changes).toBe(true);
	});

	it("labels tool lines in plain words", () => {
		const crm = [{ id: "notes", name: "Notes" }];
		expect(callLabel("connectors_search", tools, crm)).toBe("Look up Notes actions");
		expect(callLabel("connectors_search", tools, [...crm, { id: "crm", name: "CRM" }])).toBe("Look up connected actions");
		expect(callLabel("notes.find", tools, crm)).toBe("Find with Notes");
		expect(callLabel(modelToolName("memory.search"), tools, crm)).toBe("Search memory");
		expect(callLabel("gone.send_sms", tools, crm)).toBe("Send SMS");
	});

	it("quotes what a memory save saved, so no save is silent", () => {
		const remember = modelToolName("memory.remember");
		const saved = { saved: "m1" };
		expect(toolLine(callLabel(remember, tools, [], { input: { content: "Prefers mornings" }, output: saved }), "done")).toBe('Saved a personal memory: "Prefers mornings"');
		expect(callLabel(modelToolName("memory.remember_for_team"), tools, [], { input: { content: "x".repeat(100) }, output: saved })).toBe(`Save to team memory: "${"x".repeat(79)}…"`);
		// While it runs, or when it was refused, the content isn't shown.
		expect(callLabel(remember, tools, [], { input: { content: "Prefers mornings" } })).toBe("Remember");
		expect(callLabel(remember, tools, [], { input: { content: "Prefers mornings" }, output: { error: "Memory is off." } })).toBe("Remember");
	});

	it("skips widgets and tool search", () => {
		expect(describeCall(modelToolName("widgets.table"), {}, tools)).toBeNull();
		expect(describeCall("connectors_search", { query: "" }, tools)).toBeNull();
	});

	it("counts a call that answered { error } as failed, though the model sees it as a result", async () => {
		const agent = { tools: ["skills.load"] };
		const tools = buildToolSet(agent, ctx(owner), builtinTools);
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const load = (id: string, skill: string) => ({ type: "tool-call" as const, toolCallId: id, toolName: "skills_load", input: JSON.stringify({ id: skill }) });
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						load("c1", "nope"),
						load("c2", skills[0]!.id),
						{ type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
					],
				}),
			}),
		});
		const ends: Record<string, string> = {};
		for await (const part of streamText({ model, prompt: "load", tools }).stream)
			if (part.type === "tool-result") ends[part.toolCallId] = "error" in callEnd(part.output) ? "error" : "done";
		expect(ends).toEqual({ c1: "error", c2: "done" });
		expect(callEnd({ error: "No installed skill." })).toEqual({ error: "No installed skill." });
		expect(callEnd([{ id: 1 }])).toEqual({ output: [{ id: 1 }] });
	});

	it("cuts long values", () => {
		expect(clipJson({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(clipJson("x".repeat(ACTIVITY_MAX_CHARS + 10))).toHaveLength(ACTIVITY_MAX_CHARS + "\n… (cut)".length);
	});
});
