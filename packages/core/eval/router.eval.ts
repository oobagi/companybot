import { Output, experimental_decide as decide, generateText } from "ai";
import { it } from "vitest";
import { defaultModel } from "../src/models";
import { ROUTER_MIN_PROBABILITY, ROUTER_MODEL, type RouterAction, type RouterInput, forSomeoneElse, justAnsweredKey, routerAnswers, routerDecisions, routerQuestions, routerRequest, routerSchema } from "../src/router";
import { gatewayCost } from "../src/usage";
import { routerCases } from "./router-cases";

// Scores reply-router models on the chat moments in router-cases.ts (wiki/chat.md has the latest
// scores): the dispatcher alone. It's a wide net, so what counts is recall (no "missed": every reply
// expected wakes its agent) and how many extra agents it wakes (each costs a quiet turn, where the
// agent decides). full-path.eval.ts scores what actually gets posted. Costs real money, a few cents a
// run, so it's not part of `pnpm test`:
//   AI_GATEWAY_API_KEY=… pnpm --filter @companybot/core eval:router
// Jev (ROUTER_MODEL) runs the exact production call (routerQuestions: a choice per agent, plus its
// reaction): through AI Gateway, and also through OpenRouter's Decisions API when OPENROUTER_API_KEY
// is set. Language models, for comparison, answer the same rules as JSON (routerSchema).
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

const jev = (id: string): Model => ({
	id: `${id} (gateway)`,
	run: async (input) => {
		const { instructions, prompt } = routerRequest(input);
		// The exact production call (backend router.ts).
		const { answers, providerMetadata } = await decide({ model: id, state: `${instructions}\n\n${prompt}`, questions: routerQuestions(input), maxRetries: 1 });
		const answer = new Map([...routerAnswers(answers as Parameters<typeof routerAnswers>[0], input.agents, justAnsweredKey(input))].map(([key, d]) => [key, d.action]));
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
			body: JSON.stringify({ model: id, state: `${instructions}\n\n${prompt}`, questions: routerQuestions(input) }),
		});
		if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
		const body = (await response.json()) as { answers: Parameters<typeof routerAnswers>[0]; usage?: { cost?: number } };
		const answer = new Map([...routerAnswers(body.answers, input.agents, justAnsweredKey(input))].map(([key, d]) => [key, d.action]));
		return { answer, costUsd: body.usage?.cost ?? 0 };
	},
});

function models(): Model[] {
	const picked = process.env.ROUTER_EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
	const all = [jev(ROUTER_MODEL), language(defaultModel), language("openai/gpt-5-nano"), language("alibaba/qwen3.7-flash")];
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
		let decisions = 0, right = 0, woke = 0, missed = 0, reacts = 0, reactsRight = 0;
		const misses: string[] = [];
		for (const { c, answer, error } of results) {
			for (const [key, expected] of Object.entries(c.expect)) {
				const got = answer.get(key) ?? "quiet";
				decisions++;
				if (got === expected) right++;
				else misses.push(`  ${c.name}: ${key} expected ${expected}, got ${error ? `error (${error.slice(0, 80)})` : got}`);
				if (got === "reply" && expected !== "reply") woke++;
				if (expected === "reply" && got !== "reply") missed++;
				if (expected === "react") (reacts++, got === "react" && reactsRight++);
			}
		}
		const exact = results.filter(({ c, answer }) => Object.entries(c.expect).every(([k, e]) => (answer.get(k) ?? "quiet") === e)).length;
		const ms = results.filter((r) => !r.error).map((r) => r.ms);
		const cost = results.reduce((s, r) => s + r.costUsd, 0) / results.length;
		const errors = results.filter((r) => r.error).length;
		rows.push(
			`| ${model.id} | ${((100 * right) / decisions).toFixed(0)}% | ${exact}/${results.length} | ${woke} | ${missed} | ${reactsRight}/${reacts} | ${percentile(ms, 0.5)} | ${percentile(ms, 0.9)} | $${cost.toFixed(5)} | ${errors} |`,
		);
		print(`\n${model.id}: ${right}/${decisions} decisions right${misses.length ? `. Misses:\n${misses.join("\n")}` : ""}`);
	}
	print(
		[
			"",
			`${routerCases.length} moments × ${runs} run(s), ${new Date().toISOString().slice(0, 10)}`,
			"| Model | Decisions right | Moments all right | Woke extra | Missed replies | Reactions | p50 ms | p90 ms | $/call | Errors |",
			"|---|---|---|---|---|---|---|---|---|---|",
			...rows,
		].join("\n"),
	);
});

// Jev alone on "someone other than whoever answered": right after an agent answered, its chance of
// "reply" (after someone_else, see core forSomeoneElse) must keep it from being woken, and be under every
// agent that is woken, so a wrong pick isn't left to the agent to catch. Prints the numbers either way.
const SOMEONE_ELSE = ["\"anyone else?\" after the bot answered", "\"anyone else?\" when it's another agent's line", "\"can anyone validate that?\" after the bot answered"];

it("ranks whoever just answered last for \"anyone else?\"", { timeout: 5 * 60_000 }, async () => {
	if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Set AI_GATEWAY_API_KEY: the eval calls real models.");
	const runs = Number(process.env.ROUTER_EVAL_RUNS ?? 1);
	const failed: string[] = [];
	for (const name of SOMEONE_ELSE) {
		const c = routerCases.find((x) => x.name === name)!;
		const answered = c.input.before.findLast((m) => m.agent)!.agent!;
		for (let run = 0; run < runs; run++) {
			const { instructions, prompt } = routerRequest(c.input);
			const { answers } = await decide({ model: ROUTER_MODEL, state: `${instructions}\n\n${prompt}`, questions: routerQuestions(c.input), maxRetries: 1 });
			const adjusted = forSomeoneElse(answers as Parameters<typeof forSomeoneElse>[0], justAnsweredKey(c.input));
			const reply = Object.fromEntries(c.input.agents.map((a) => [a.name, adjusted[a.key]?.probabilities?.reply ?? 0]));
			const mine = reply[c.input.agents.find((a) => a.key === answered)!.name]!;
			const ok = mine < ROUTER_MIN_PROBABILITY && Object.values(reply).every((p) => p === mine || p < ROUTER_MIN_PROBABILITY || p > mine);
			if (!ok) failed.push(name);
			const raw = (answers as Record<string, { probabilities?: Record<string, number>; probability?: number }>);
			print(`${ok ? "ok  " : "MISS"} ${name}: ${Object.entries(reply).map(([agent, p]) => `${agent} ${p.toFixed(2)}`).join(", ")} (someone_else ${raw.someone_else?.probability?.toFixed(2) ?? "—"}, ${c.input.agents.find((a) => a.key === answered)!.name} before it ${raw[answered]?.probabilities?.reply?.toFixed(2)})`);
		}
	}
	if (failed.length) throw new Error(`Whoever just answered would be woken, or over one that is: ${failed.join("; ")}`);
});
