import { experimental_decide as decide, generateText, isStepCount, tool } from "ai";
import { it } from "vitest";
import { blankAgent, companybot } from "../src/default-agents";
import { resolveTools } from "../src/agents";
import type { AgentConfig } from "../src/agent-config";
import { NEXT_MIN_PROBABILITY } from "../src/handoffs";
import { defaultModel } from "../src/models";
import {
	type ConfidenceBand,
	type NextInput,
	ROUTER_MODEL,
	type RouterAgent,
	type RouterInput,
	type RouterMessage,
	confidenceBand,
	justAnsweredKey,
	nextAnswer,
	nextQuestions,
	nextRequest,
	routerAnswers,
	routerQuestions,
	routerRequest,
} from "../src/router";
import { modelToolName } from "../src/tools";
import { type PlaceMessage, type TurnPlace, buildTurnPrompt, systemPrompt } from "../src/turn-input";
import { gatewayCost } from "../src/usage";
import { type Outcome, fullPathCases, handBacks, transcripts } from "./router-cases";

// Scores what actually gets posted: the dispatcher (Jev, the production call) wakes agents, and each
// woken agent runs its quiet turn (the production prompt and system prompt, on its model) and posts
// only if it calls chat_notify. Misses: "butted in" (posted when it shouldn't) and "silent" (should
// have answered, didn't). Hand-backs run "who goes next" (also production) on an agent's result in a
// handoff's thread, then the quiet hop. Costs a turn per woken agent, a few cents a run:
//   AI_GATEWAY_API_KEY=… pnpm --filter @companybot/core eval:full
// FULL_EVAL_RUNS repeats it. Not modeled: session replay (each turn sees the place's messages, its own
// posts included, but not its earlier turns' private text), handoffs a post starts, and real tool
// results (other tools answer "not available", so an agent that would look something up answers from
// what it has).

const print = (text: string) => process.stdout.write(`${text}\n`);
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const TIME_ZONE = "America/Los_Angeles";
const NOW = Date.UTC(2026, 9, 31, 17, 0);

/** An eval agent as a workspace would have it: the default Companybot, or a blank agent with its description. */
function configOf(agent: RouterAgent): Pick<AgentConfig, "instructions" | "tools"> & { model: string } {
	if (agent.name === "Companybot") return { instructions: companybot.instructions, tools: companybot.tools, model: companybot.model };
	return { instructions: `You are ${agent.name}. ${agent.description}`, tools: blankAgent.tools, model: blankAgent.model };
}

type Said = RouterMessage & { id: string };
type Woken = { agent: RouterAgent; band: ConfidenceBand; probability?: number };

/** The dispatcher's production call: which agents it wakes, and how sure it was. */
async function dispatch(input: RouterInput) {
	const { instructions, prompt } = routerRequest(input);
	const { answers, providerMetadata } = await decide({ model: ROUTER_MODEL, state: `${instructions}\n\n${prompt}`, questions: routerQuestions(input), maxRetries: 1 });
	const picked = routerAnswers(answers as Parameters<typeof routerAnswers>[0], input.agents, justAnsweredKey(input));
	const woken = input.agents.flatMap((a): Woken[] => {
		const d = picked.get(a.key)!;
		return d.action === "reply" ? [{ agent: a, band: confidenceBand(d.probability), probability: d.probability }] : [];
	});
	return { woken, costUsd: gatewayCost(providerMetadata) };
}

/** "Who goes next", the production call: the agent it wakes after another agent's message, if any. */
async function next(input: NextInput, agents: RouterAgent[]) {
	const { instructions, prompt } = nextRequest(input);
	const { answers, providerMetadata } = await decide({ model: ROUTER_MODEL, state: `${instructions}\n\n${prompt}`, questions: nextQuestions(input), maxRetries: 1 });
	const pick = nextAnswer(answers as Parameters<typeof nextAnswer>[0], input, NEXT_MIN_PROBABILITY);
	const agent = pick && agents.find((a) => a.key === pick.key);
	const woken: Woken[] = agent ? [{ agent, band: confidenceBand(pick.probability), probability: pick.probability }] : [];
	return { woken, costUsd: gatewayCost(providerMetadata) };
}

const participant = (m: RouterMessage) => (m.agent ? { type: "agent" as const, id: m.agent, name: m.author } : { type: "user" as const, id: `u-${m.author}`, name: m.author });
const placeMessage = (m: Said, i: number, n: number): PlaceMessage => ({ id: m.id, author: participant(m), text: m.text, time: NOW - (n - i) * 60_000 });

/** One woken agent's quiet turn: what it posted with chat_notify, if anything. */
async function quietTurn(turn: {
	woken: Woken;
	agents: RouterAgent[];
	people: string[];
	channel: string;
	said: Said[];
	/** The message to decide on: the last one unless set (picks after the first see earlier picks' posts after it). */
	triggerId?: string;
	/** Who the agents act for: the newest message's author unless set. */
	person?: string;
	/** Agents the message went to first (picks run one after another, as in router.apply). */
	before?: string[];
	thread?: Said;
	/** A hop: the agent whose message it is. */
	from?: string;
}) {
	const { agent } = turn.woken;
	const config = configOf(agent);
	const available = resolveTools(config, { userId: "u", role: "member" });
	const posted: string[] = [];
	let reacted = false;
	const tools = Object.fromEntries(
		available.map((t) => [
			modelToolName(t.id),
			tool({
				description: t.description,
				inputSchema: t.input,
				execute: async (input: unknown) => {
					if (t.id === "chat.notify") return (posted.push((input as { text: string }).text), { posted: true });
					if (t.id === "chat.react") return ((reacted = true), { reacted: true });
					return { error: "Not available right now." };
				},
			}),
		]),
	);
	const message = turn.said.find((m) => m.id === turn.triggerId) ?? turn.said.at(-1)!;
	const person = turn.person ?? message.author;
	const place: TurnPlace = {
		kind: "channel",
		name: turn.channel,
		private: false,
		topic: null,
		thread: turn.thread ? { parent: placeMessage(turn.thread, 0, turn.said.length + 1), first: true } : null,
		members: [
			...[person, ...turn.people.filter((p) => p !== person)].map((name) => ({ type: "user" as const, id: `u-${name}`, name })),
			...turn.agents.map((a) => ({ type: "agent" as const, id: a.key, name: a.name })),
		],
	};
	const prompt = buildTurnPrompt({
		agentId: agent.key,
		place,
		actor: { id: `u-${person}`, name: person, email: `${person.toLowerCase()}@roofco.com`, role: "member", timeZone: TIME_ZONE },
		now: NOW,
		memory: "team",
		connectors: { connected: [], unavailable: [] },
		messages: turn.said.map((m, i) => placeMessage(m, i, turn.said.length)),
		triggerId: message.id,
		routed: { band: turn.woken.band, quiet: true, ...(turn.before?.length && { before: turn.before }) },
		...(turn.from && { handoff: { from: turn.from, ask: false } }),
	});
	const result = await generateText({
		model: config.model,
		instructions: systemPrompt(config, [], available),
		prompt,
		tools,
		stopWhen: isStepCount(6),
		providerOptions: { gateway: { caching: "auto" } },
		maxRetries: 1,
	});
	// What it did, for a miss: its tool calls and the text it ended with (never shown).
	const did = [...result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)), result.text && `said ${JSON.stringify(result.text.slice(0, 80))}`].filter(Boolean).join(", ") || "nothing";
	return { posted, reacted, did, costUsd: result.steps.reduce((sum, s) => sum + gatewayCost(s.providerMetadata), 0) };
}

type Tally = { errors: number; decisions: number; right: number; butted: number; silent: number; costUsd: number; messages: number; turns: number; woken: Record<ConfidenceBand, number>; misses: string[] };
type Turn = Woken & Awaited<ReturnType<typeof quietTurn>>;

/** Scores who posted against `expect`. "one": exactly one of those agents posts. */
function score(tally: Tally, label: string, agents: RouterAgent[], turns: Turn[], expect: Record<string, Outcome>) {
	const turnOf = (a: RouterAgent) => turns.find((t) => t.agent.key === a.key);
	const posted = (a: RouterAgent) => (turnOf(a)?.posted.length ?? 0) > 0;
	const why = (a: RouterAgent) => {
		const t = turnOf(a);
		return t ? `woken (${t.band}${t.probability !== undefined ? ` ${t.probability.toFixed(2)}` : ""})` : "not woken";
	};
	const butted = (a: RouterAgent) => (tally.butted++, tally.misses.push(`  ${label}: ${a.name} butted in, ${why(a)}: ${JSON.stringify(turnOf(a)!.posted[0]!.slice(0, 100))}`));
	const silent = (a: RouterAgent, extra = "") => (tally.silent++, tally.misses.push(`  ${label}: ${a.name}${extra} stayed silent, ${why(a)}${turnOf(a) ? `: ${turnOf(a)!.did}` : ""}`));
	const ones = agents.filter((a) => expect[a.key] === "one");
	const onePosted = ones.filter(posted);
	for (const a of agents) {
		const want = expect[a.key] ?? "silent";
		tally.decisions++;
		if (want === "one") {
			// The first to post is the answer; any more butted in. Nobody: one silent miss.
			if (onePosted.length === 0 && a === ones[0]) silent(a, " (or anyone)");
			else if (posted(a) && a !== onePosted[0]) butted(a);
			else tally.right++;
		} else if (want === "either") tally.right++;
		else if (want === "respond") {
			if (posted(a) || turnOf(a)?.reacted) tally.right++;
			else silent(a, " (no vote)");
		}
		else if (want === "handoff") {
			// Fine if it says nothing, or only hands to another agent.
			if (!posted(a) || turnOf(a)!.posted.every((text) => agents.some((o) => o !== a && text.includes(`@${o.name}`)))) tally.right++;
			else butted(a);
		} else if ((want === "post") === posted(a)) tally.right++;
		else if (posted(a)) butted(a);
		else silent(a);
	}
}

function count(tally: Tally, turns: Turn[]) {
	tally.turns += turns.length;
	for (const t of turns) (tally.woken[t.band]++, (tally.costUsd += t.costUsd));
}

/** A person's message through the whole path: the dispatcher, then each woken agent's quiet turn. */
async function step(tally: Tally, label: string, input: RouterInput, said: Said[], expect: Record<string, Outcome>) {
	tally.messages++;
	const { woken, costUsd } = await dispatch(input);
	tally.costUsd += costUsd;
	// One after another, best fit first, each seeing what the ones before posted (router.apply).
	const turns: Turn[] = [];
	const seen = [...said];
	for (const w of [...woken].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))) {
		const before = turns.map((t) => t.agent.name);
		const turn = { ...w, ...(await quietTurn({ woken: w, agents: input.agents, people: input.people, channel: input.place.name, said: seen, triggerId: said.at(-1)!.id, before })) };
		turns.push(turn);
		// Its posts come after the message, so the trigger stays the one to answer.
		for (const text of turn.posted) seen.push({ author: w.agent.name, agent: w.agent.key, text, id: `${said.at(-1)!.id}-${seen.length}` });
	}
	count(tally, turns);
	score(tally, label, input.agents, turns, expect);
	return { posts: turns.flatMap((t) => t.posted.map((text) => ({ agent: t.agent, text }))), reacted: turns.filter((t) => t.reacted).map((t) => t.agent) };
}

it("scores the full path: dispatcher, then the agent's quiet turn", { timeout: 20 * 60_000 }, async () => {
	if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Set AI_GATEWAY_API_KEY: the eval calls real models.");
	const runs = Number(process.env.FULL_EVAL_RUNS ?? 1);
	const tally: Tally = { errors: 0, decisions: 0, right: 0, butted: 0, silent: 0, costUsd: 0, messages: 0, turns: 0, woken: { clearly: 0, probably: 0, might: 0 }, misses: [] };
	for (let run = 0; run < runs; run++) {
		const moments = fullPathCases.map(async (c) => {
			const said = [...(c.input.parent ? [c.input.parent] : []), ...c.input.before, c.input.message].map((m, i) => ({ ...m, id: `m${i}` }));
			const expect = Object.fromEntries(Object.entries(c.expect).map(([k, action]) => [k, action === "reply" ? "post" : "silent"])) as Record<string, Outcome>;
			await step(tally, c.name, c.input, said, expect);
		});
		// Each step's posts feed the next, as in the chat.
		const conversations = transcripts.map(async (transcript) => {
			const said: Said[] = [];
			const posted: string[] = [];
			const responded: string[] = [];
			const lines: string[] = [];
			for (const [i, s] of transcript.steps.entries()) {
				said.push({ ...s.message, id: `t${said.length}` });
				const input: RouterInput = {
					place: { name: transcript.channel, topic: null },
					agents: transcript.agents,
					people: transcript.people.filter((p) => p !== s.message.author),
					parent: null,
					before: said.slice(-9, -1),
					message: s.message,
				};
				const { posts, reacted } = await step(tally, `${transcript.name}, step ${i + 1} ${JSON.stringify(s.message.text)}`, input, said, s.expect(posted, responded));
				for (const p of posts) (said.push({ author: p.agent.name, agent: p.agent.key, text: p.text, id: `t${said.length}` }), posted.push(p.agent.key), responded.push(p.agent.key));
				responded.push(...reacted.map((a) => a.key));
				const shown = [...posts.map((p) => `${p.agent.name}: ${JSON.stringify(p.text.slice(0, 80))}`), ...reacted.map((a) => `${a.name} reacted`)];
				lines.push(`  ${JSON.stringify(s.message.text)} → ${shown.join("; ") || "(nothing posted)"}`);
			}
			print(`${transcript.name}:\n${lines.join("\n")}`);
		});
		const backs = handBacks.map(async (h) => {
			const agents = transcripts[0]!.agents;
			const from = agents.find((a) => a.key === h.message.agent)!;
			const choices = agents.filter((a) => a !== from);
			tally.messages++;
			const input: NextInput = { place: { name: "general", topic: null }, from: from.name, agents: choices, person: h.person, parent: h.parent, before: [], message: h.message };
			const { woken, costUsd } = await next(input, choices);
			tally.costUsd += costUsd;
			const thread = { ...h.parent, id: "p" };
			const turns = await Promise.all(
				woken.map(async (w) => ({ ...w, ...(await quietTurn({ woken: w, agents, people: [], channel: "general", said: [{ ...h.message, id: "r" }], person: h.person, thread, from: from.name })) })),
			);
			count(tally, turns);
			score(tally, `hand-back: ${h.name}`, choices, turns, h.expect);
			print(`hand-back: ${h.name} → ${turns.map((t) => `${t.agent.name} (${t.band}): ${t.posted.length ? JSON.stringify(t.posted[0]!.slice(0, 80)) : "nothing posted"}`).join("; ") || "nobody woken"}`);
		});
		// A failed call (the gateway has bad moments) skips its moment, counted apart.
		await Promise.all([...moments, ...conversations, ...backs].map((p) => p.catch((e: unknown) => (tally.errors++, print(`  error: ${e instanceof Error ? e.message.slice(0, 120) : e}`)))));
	}
	print(`\n${tally.misses.length ? `Misses:\n${tally.misses.join("\n")}` : "No misses."}`);
	const steps = transcripts.reduce((n, t) => n + t.steps.length, 0);
	print(
		[
			"",
			`Full path, ${fullPathCases.length} moments + ${steps} transcript steps + ${handBacks.length} hand-backs × ${runs} run(s), ${new Date().toISOString().slice(0, 10)}, dispatcher ${ROUTER_MODEL}, agents on ${defaultModel}`,
			"| Decisions right | Butted in | Silent misses | Agent turns (clearly / probably / might) | $ per message | $ total | Errors |",
			"|---|---|---|---|---|---|---|",
			`| ${tally.right}/${tally.decisions} (${((100 * tally.right) / tally.decisions).toFixed(0)}%) | ${tally.butted} | ${tally.silent} | ${tally.turns} (${tally.woken.clearly} / ${tally.woken.probably} / ${tally.woken.might}) | $${(tally.costUsd / tally.messages).toFixed(5)} | $${tally.costUsd.toFixed(4)} | ${tally.errors} |`,
		].join("\n"),
	);
});
