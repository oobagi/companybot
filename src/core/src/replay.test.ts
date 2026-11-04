import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { HELD_RESULT, PRIVATE_RESULT, REPLAY_INPUT_CHARS, REPLAY_RESULT_CHARS, calledTools, keptStep, paired, stepsFor } from "./replay";

const call = (id: string, toolName: string, input: unknown = {}): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input }] });
const result = (id: string, toolName: string, value: unknown): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "json", value: value as never } }] });

describe("replaying tool steps", () => {
	it("keeps a step's text, calls and results as the model had them, minus what another turn can't send", () => {
		const step: ModelMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "thinking", providerOptions: { anthropic: { signature: "x" } } },
					{ type: "text", text: "Looking." },
					{ type: "tool-call", toolCallId: "c1", toolName: "web_fetch", input: { url: "https://a.co" }, providerOptions: { openai: { itemId: "fc_1" } } },
					{ type: "tool-approval-request", approvalId: "a1", toolCallId: "c2" },
				],
			},
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "web_fetch", output: { type: "text", value: "Page" }, providerOptions: { openai: {} } }] },
		];
		expect(keptStep(step)).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool-call", toolCallId: "c1", toolName: "web_fetch", input: { url: "https://a.co" } }] },
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "web_fetch", output: { type: "text", value: "Page" } }] },
		]);
		// The answer step calls nothing: it's kept as the turn's decision instead.
		expect(keptStep([{ role: "assistant", content: [{ type: "text", text: '{"message":"Hi"}' }] }])).toEqual([]);
	});

	it("cuts long results and inputs, saying so", () => {
		const [, kept] = keptStep([call("c1", "web_fetch", { body: "x".repeat(REPLAY_INPUT_CHARS) }), result("c1", "web_fetch", { page: "y".repeat(REPLAY_RESULT_CHARS) })]);
		const output = (kept as { content: { output: { type: string; value: string } }[] }).content[0]!.output;
		expect(output.type).toBe("text");
		expect(output.value).toHaveLength(REPLAY_RESULT_CHARS + "\n[Cut to 4,000 characters for later replies. Call again for the rest.]".length);
		const input = (keptStep([call("c1", "pages_write", { body: "x".repeat(REPLAY_INPUT_CHARS) }), result("c1", "pages_write", {})])[0] as { content: { input: { cut: string } }[] }).content[0]!.input;
		expect(input.cut).toMatch(/\[Cut to 20,000 characters/);
	});

	it("gives a call with no result (held for approval) one, as providers require", () => {
		expect(paired([call("c1", "crm_send_sms"), call("c2", "memory_search"), result("c2", "memory_search", [])])).toEqual([
			call("c1", "crm_send_sms"),
			{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "crm_send_sms", output: { type: "text", value: HELD_RESULT } }] },
			call("c2", "memory_search"),
			result("c2", "memory_search", []),
		]);
	});

	it("hides results from someone the turn didn't act for, and everything but widgets without details", () => {
		const steps = [{ role: "assistant", content: [{ type: "text", text: "Found it." }, ...(call("c1", "records_find").content as never[]), ...(call("w1", "widgets_record").content as never[])] }, { role: "tool", content: [...(result("c1", "records_find", { rows: ["Acme"] }).content as never[]), ...(result("w1", "widgets_record", { widget: {} }).content as never[])] }] as ModelMessage[];
		expect(stepsFor(steps, { details: true, results: true })).toEqual(steps);
		const hidden = stepsFor(steps, { details: true, results: false });
		expect(JSON.stringify(hidden)).not.toContain("Acme");
		expect(JSON.stringify(hidden)).toContain(PRIVATE_RESULT);
		expect(calledTools(hidden)).toEqual(["records_find", "widgets_record"]);
		const bare = stepsFor(steps, { details: false, results: false });
		expect(calledTools(bare)).toEqual(["widgets_record"]);
		expect(JSON.stringify(bare)).not.toContain("Found it.");
	});
});
