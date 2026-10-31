import { Output, experimental_decide as decide, generateText } from "ai";
import { it } from "vitest";
import { ROUTER_MODEL, type RouterAction, type RouterInput, routerActions, routerDecisions, routerRequest, routerSchema } from "../src/router";
import { gatewayCost } from "../src/usage";
import { routerCases } from "./router-cases";

// Scores reply-router models on the chat moments in router-cases.ts (wiki/chat.md has the latest
// scores). Costs real money, a few cents a run, so it's not part of `pnpm test`:
//   AI_GATEWAY_API_KEY=… pnpm --filter @companybot/core eval:router
// Language models run the exact production call (routerRequest + routerSchema). Jev, TypeSafe's
// decision model, answers one choice question per agent instead: through AI Gateway with the same
// key, and also through OpenRouter's Decisions API when OPENROUTER_API_KEY is set.
// ROUTER_EVAL_MODELS (comma-separated) picks models; ROUTER_EVAL_RUNS repeats the set.

type Answer = Map<string, RouterAction>;
type Model = { id: string; run: (input: RouterInput) => Promise<{ answer: Answer; costUsd: number }> };

const language = (id: string): Model => ({
	id,
	run: async (input) => {
		const { instructions, prompt } = routerRequest(input);
		const { output, providerMetadata } = await generateText({
			model: id,
			instructions,
			prompt,
			output: Output.object({ schema: routerSchema(input.agents), name: "decisions" }),
			providerOptions: { gateway: { caching: "auto" } },
			maxRetries: 1,
		});
		const answer = new Map([...routerDecisions(output, input.agents)].map(([key, d]) => [key, d.action]));
		return { answer, costUsd: gatewayCost(providerMetadata) };
	},
});

/** The same rules as the language models' instructions, split into one choice per agent. */
function jevQuestions(input: RouterInput) {
	return Object.fromEntries(
		input.agents.map((a) => [
			a.key,
			{
				type: "choice" as const,
				instructions: `Nobody @mentioned an agent in the newest message. What should ${a.name} (agent ${a.key}) do about it?`,
				criteria: {
					reply: `The message asks ${a.name} to do something, or asks a question that ${a.name}'s job covers and that no person here was asked, or follows up on what ${a.name} just said. ${a.name} is the best agent for it.`,
					react: `The message thanks or acknowledges ${a.name}, or answers ${a.name}'s question, with nothing left to do.`,
					quiet: "Anything else: people talking to each other, small talk, news, a question to a named person, a message for another agent, or unsure.",
				},
			},
		]),
	);
}

const jev = (id: string): Model => ({
	id: `${id} (gateway)`,
	run: async (input) => {
		const { instructions, prompt } = routerRequest(input);
		const { answers, providerMetadata } = await decide({ model: id, state: `${instructions}\n\n${prompt}`, questions: jevQuestions(input), maxRetries: 1 });
		const answer = new Map(input.agents.map((a) => [a.key, pick((answers[a.key] as { choice?: string } | undefined)?.choice)]));
		return { answer, costUsd: gatewayCost(providerMetadata) };
	},
});

const jevOpenRouter = (id: string, key: string): Model => ({
	id: `${id} (OpenRouter)`,
	run: async (input) => {
		const { instructions, prompt } = routerRequest(input);
		const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model: id, state: `${instructions}\n\n${prompt}`, questions: jevQuestions(input) }),
		});
		if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
		const body = (await response.json()) as { answers: Record<string, { choice?: string }>; usage?: { cost?: number } };
		return { answer: new Map(input.agents.map((a) => [a.key, pick(body.answers[a.key]?.choice)])), costUsd: body.usage?.cost ?? 0 };
	},
});

const pick = (choice: string | undefined): RouterAction => ((routerActions as readonly string[]).includes(choice ?? "") ? (choice as RouterAction) : "quiet");

function models(): Model[] {
	const picked = process.env.ROUTER_EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
	const all = [language(ROUTER_MODEL), language("openai/gpt-5-nano"), language("alibaba/qwen3.7-flash"), jev("typesafe-ai/jev-1.14.0")];
	if (process.env.OPENROUTER_API_KEY) all.push(jevOpenRouter("typesafe/jev-1.14", process.env.OPENROUTER_API_KEY));
	return picked ? all.filter((m) => picked.some((p) => m.id.startsWith(p))) : all;
}

/** At most `n` at once, in order. */
async function pool<T, R>(items: T[], n: number, f: (item: T) => Promise<R>) {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: n }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await f(items[i]!);
		}
	}));
	return results;
}

/** Straight to the terminal: vitest holds back console output. */
const print = (text: string) => process.stdout.write(`${text}\n`);

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

it("scores reply-router models", { timeout: 20 * 60_000 }, async () => {
	if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Set AI_GATEWAY_API_KEY: the eval calls real models.");
	const runs = Number(process.env.ROUTER_EVAL_RUNS ?? 1);
	const rows: string[] = [];
	for (const model of models()) {
		const results = await pool(Array.from({ length: runs }, () => routerCases).flat(), 6, async (c) => {
			const started = Date.now();
			try {
				const { answer, costUsd } = await model.run(c.input);
				return { c, answer, costUsd, ms: Date.now() - started, error: null };
			} catch (e) {
				return { c, answer: new Map<string, RouterAction>(), costUsd: 0, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
			}
		});
		let decisions = 0, right = 0, butted = 0, missed = 0, reacts = 0, reactsRight = 0;
		const misses: string[] = [];
		for (const { c, answer, error } of results) {
			for (const [key, expected] of Object.entries(c.expect)) {
				const got = answer.get(key) ?? "quiet";
				decisions++;
				if (got === expected) right++;
				else misses.push(`  ${c.name}: ${key} expected ${expected}, got ${error ? `error (${error.slice(0, 80)})` : got}`);
				if (got === "reply" && expected !== "reply") butted++;
				if (expected === "reply" && got !== "reply") missed++;
				if (expected === "react") (reacts++, got === "react" && reactsRight++);
			}
		}
		const exact = results.filter(({ c, answer }) => Object.entries(c.expect).every(([k, e]) => (answer.get(k) ?? "quiet") === e)).length;
		const ms = results.filter((r) => !r.error).map((r) => r.ms);
		const cost = results.reduce((s, r) => s + r.costUsd, 0) / results.length;
		const errors = results.filter((r) => r.error).length;
		rows.push(
			`| ${model.id} | ${((100 * right) / decisions).toFixed(0)}% | ${exact}/${results.length} | ${butted} | ${missed} | ${reactsRight}/${reacts} | ${percentile(ms, 0.5)} | ${percentile(ms, 0.9)} | $${cost.toFixed(5)} | ${errors} |`,
		);
		print(`\n${model.id}: ${right}/${decisions} decisions right${misses.length ? `. Misses:\n${misses.join("\n")}` : ""}`);
	}
	print(
		[
			"",
			`${routerCases.length} moments × ${runs} run(s), ${new Date().toISOString().slice(0, 10)}`,
			"| Model | Decisions right | Moments all right | Butted in | Missed replies | Reactions | p50 ms | p90 ms | $/call | Errors |",
			"|---|---|---|---|---|---|---|---|---|---|",
			...rows,
		].join("\n"),
	);
});
