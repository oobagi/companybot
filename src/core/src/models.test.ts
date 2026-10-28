import { describe, expect, it } from "vitest";
import { validateAgentConfig } from "./agents";
import { scribe } from "../test/fixtures";
import { fallbackModels, modelNote, parseGatewayModels, searchModels } from "./models";

const sonnet = { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", type: "language", tags: ["reasoning", "tool-use"], context_window: 1_000_000, pricing: { input: "0.000003", output: "0.000015" } };

describe("models", () => {
	it("keeps only language models that call tools", () => {
		const body = { data: [
			sonnet,
			{ id: "openai/gpt-no-tools", name: "No tools", type: "language", tags: ["reasoning"] },
			{ id: "openai/text-embedding-3", name: "Embedding", type: "embedding", tags: ["tool-use"] },
			{ id: "meta/llama", type: "language", tags: ["tool-use"], pricing: null },
			{ name: "No id", type: "language", tags: ["tool-use"] },
		] };
		expect(parseGatewayModels(body)).toEqual([
			{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic", contextWindow: 1_000_000, input: 3, output: 15 },
			{ id: "meta/llama", name: "meta/llama", provider: "meta" },
		]);
		expect(parseGatewayModels({ error: "nope" })).toEqual([]);
		expect(parseGatewayModels(null)).toEqual([]);
	});

	it("writes a short note from context and price", () => {
		const [m] = parseGatewayModels({ data: [sonnet] });
		expect(modelNote(m!)).toBe("1M context · $3 / $15 per M tokens");
		expect(modelNote({ id: "a/b", name: "B", provider: "a", contextWindow: 128_000, input: 0.075, output: 0.3 })).toBe("128K context · $0.075 / $0.3 per M tokens");
		expect(modelNote(fallbackModels[0]!)).toBe("");
	});

	it("searches by every word in the name or id", () => {
		expect(searchModels(fallbackModels, "claude HAIKU").map((m) => m.id)).toEqual(["anthropic/claude-haiku-5.5"]);
		expect(searchModels(fallbackModels, "anthropic")).toHaveLength(3);
		expect(searchModels(fallbackModels, "")).toHaveLength(4);
	});

	it("validates against the models it's given, the fallback list by default", () => {
		expect(validateAgentConfig({ ...scribe, model: "openai/gpt-x" })).toMatch("model");
		expect(validateAgentConfig({ ...scribe, model: "openai/gpt-x" }, [{ id: "openai/gpt-x" }])).toBeNull();
		expect(validateAgentConfig(scribe, [{ id: "openai/gpt-x" }])).toMatch("model");
	});
});
