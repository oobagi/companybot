import { Output, experimental_decide as decide, generateText, isStepCount, tool } from "ai";
import { it } from "vitest";
import { z } from "zod";
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
import { type PlaceMessage, type PostDecision, type TurnPlace, buildTurnPrompt, postDecision, publishes, systemPrompt } from "../src/turn-input";
import { gatewayCost } from "../src/usage";
import { type Outcome, type Transcript, anchors, fullPathCases, handBacks, transcripts } from "./router-cases";

// Scores what actually gets posted: the dispatcher (Jev, the production call) wakes agents, and each
// woken agent runs its quiet turn (the production prompt, system prompt and final decision, on its
// model) and posts only if its decision does (core `publishes`). A post whose decision names another
// agent (`to`) wakes it next, as production does. Misses: "butted in" (posted when it shouldn't) and
// "silent" (should have answered, didn't). Hand-backs run "who goes next" (also production) on an
// agent's result in a handoff's thread, then the quiet hop. Costs a turn per woken agent, a few cents a run:
//   AI_GATEWAY_API_KEY=… pnpm --filter @companybot/core eval:full
// FULL_EVAL_RUNS repeats it. Not modeled: session replay (each turn sees the place's messages, its own
// posts included, but not its earlier turns' private text), @mention handoffs a post starts, and real
// tool results (other tools answer "not available", so an agent that would look something up answers
// from what it has).

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

/** One woken agent's quiet turn: what it posted, if its decision posts it, and to whom. */
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
	/** A hop another agent's decision named it for. */
	by?: string;
}) {
	const started = Date.now();
	const { agent } = turn.woken;
	const config = configOf(agent);
	const available = resolveTools(config, { userId: "u", role: "member" });
	let reacted = false;
	const tools = Object.fromEntries(
		available.map((t) => [
			modelToolName(t.id),
			tool({
				description: t.description,
				inputSchema: t.input,
				execute: async (input: unknown) => {
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
			...turn.agents.map((a) => ({ type: "agent" as const, id: a.key, name: a.name, role: a.description })),
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
		routed: { band: turn.woken.band, ...(turn.by && { by: turn.by }), ...(turn.before?.length && { before: turn.before }) },
		...(turn.from && { handoff: { from: turn.from, ask: false } }),
	});
	const result = await generateText({
		model: config.model,
		instructions: systemPrompt(config, [], available),
		prompt,
		tools,
		stopWhen: isStepCount(6),
		output: Output.object({ schema: postDecision, name: "decision" }),
		providerOptions: { gateway: { caching: "auto" } },
		maxRetries: 1,
	});
	const decision = await Promise.resolve(result.output).then((d) => d as PostDecision, () => null);
	const posted = publishes(decision) ? [decision!.message] : [];
	// What it did, for a miss: its tool calls and its decision (shown only if it posts).
	const did = [...result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)), decision ? `decided ${JSON.stringify(decision).slice(0, 160)}` : "no decision"].join(", ");
	TOKENS.input += result.totalUsage.inputTokens ?? 0;
	TOKENS.cached += result.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0;
	TOKENS.output += result.totalUsage.outputTokens ?? 0;
	return { posted, to: posted.length ? decision!.to : undefined, reacted, did, ms: Date.now() - started, costUsd: result.steps.reduce((sum, s) => sum + gatewayCost(s.providerMetadata), 0) };
}

/** Agent turns' tokens: the cache hit rate swings run to run, so $ alone doesn't compare two prompts. */
const TOKENS = { input: 0, cached: 0, output: 0 };
type Tally = {
	errors: number;
	decisions: number;
	right: number;
	butted: number;
	/** Of the butted in: a second answer where one was enough. */
	duplicates: number;
	silent: number;
	/** Posts that say nothing: "(No reply.)", "Nothing to add". */
	filler: number;
	/** Posts too long where a line was asked for. */
	long: number;
	/** Later agents' posts judged against the earlier ones on the same message: built on them / all. */
	together: { built: number; pairs: number };
	costUsd: number;
	messages: number;
	turns: number;
	ms: number[];
	woken: Record<ConfidenceBand, number>;
	misses: string[];
};
type Turn = Woken & Awaited<ReturnType<typeof quietTurn>>;

/** Scores who posted against `expect`. "one": exactly one of those agents posts. */
function score(tally: Tally, label: string, agents: RouterAgent[], turns: Turn[], expect: Record<string, Outcome>) {
	// An agent may have run twice on one message: picked, then named by another agent's post.
	const turnOf = (a: RouterAgent) => turns.find((t) => t.agent.key === a.key && t.posted.length > 0) ?? turns.find((t) => t.agent.key === a.key);
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
			else if (posted(a) && a !== onePosted[0]) (tally.duplicates++, butted(a));
			else tally.right++;
		} else if (want === "either") tally.right++;
		else if (want === "respond") {
			if (posted(a) || turns.some((t) => t.agent.key === a.key && t.reacted)) tally.right++;
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
	for (const t of turns) (tally.woken[t.band]++, (tally.costUsd += t.costUsd), tally.ms.push(t.ms));
}

/** Eval-only: a post that says nothing. The product never matches text; its decision gate keeps these hidden. */
const FILLER = /^\W*(no reply|no response|nothing to add|nothing new to add|nothing further|n\/a|none|pass|skip)\W*$/i;
/** Most characters in a post where a line or two was asked for. */
const SHORT_MAX = 200;

/** A judge reads two posts on the same message: does the later one answer or build on the earlier, or start over? */
async function buildsOn(person: string, message: string, earlier: { name: string; text: string }[], later: { name: string; text: string }) {
	const { output } = await generateText({
		model: defaultModel,
		instructions: "You judge a team chat where people and AI agents work together. Answer only from the messages given.",
		prompt: [
			`${person} wrote: ${JSON.stringify(message)}`,
			...earlier.map((e) => `Then ${e.name} (an agent) wrote: ${JSON.stringify(e.text)}`),
			`Then ${later.name} (an agent) wrote: ${JSON.stringify(later.text)}`,
			`Does ${later.name}'s message respond to what was said before it: answer a question asked there, use or extend an idea from it, or address its author? Or is it a fresh standalone pitch that ignores it?`,
		].join("\n\n"),
		output: Output.object({ schema: z.object({ builds_on: z.boolean() }), name: "judgement" }),
		maxRetries: 1,
	});
	return output.builds_on;
}

/** Group checks on one message's posts: filler, length, and whether later posts build on earlier ones. */
async function checkPosts(tally: Tally, label: string, person: string, message: string, posts: { agent: RouterAgent; text: string }[], s: Pick<Transcript["steps"][number], "short" | "together">) {
	for (const p of posts) {
		if (!p.text.trim() || FILLER.test(p.text)) (tally.filler++, tally.misses.push(`  ${label}: ${p.agent.name} posted filler: ${JSON.stringify(p.text.slice(0, 80))}`));
		if (s.short && p.text.length > SHORT_MAX) (tally.long++, tally.misses.push(`  ${label}: ${p.agent.name} posted ${p.text.length} characters where a line was asked for`));
	}
	if (!s.together) return;
	for (const [i, later] of posts.entries()) {
		if (i === 0) continue;
		tally.together.pairs++;
		const earlier = posts.slice(0, i).map((p) => ({ name: p.agent.name, text: p.text }));
		if (await buildsOn(person, message, earlier, { name: later.agent.name, text: later.text })) tally.together.built++;
		else tally.misses.push(`  ${label}: ${later.agent.name} ignored ${earlier.map((e) => e.name).join(", ")}: ${JSON.stringify(later.text.slice(0, 100))}`);
	}
}

/** A person's message through the whole path: the dispatcher, then each woken agent's quiet turn. */
async function step(tally: Tally, label: string, input: RouterInput, said: Said[], expect: Record<string, Outcome>, checks: Pick<Transcript["steps"][number], "short" | "together"> = {}) {
	tally.messages++;
	const { woken, costUsd } = await dispatch(input);
	tally.costUsd += costUsd;
	// One after another, best fit first, each seeing what the ones before posted (router.apply).
	const turns: Turn[] = [];
	const seen = [...said];
	const picks = [...woken].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
	for (const [i, w] of picks.entries()) {
		const before = turns.map((t) => t.agent.name);
		const turn = { ...w, ...(await quietTurn({ woken: w, agents: input.agents, people: input.people, channel: input.place.name, said: seen, triggerId: said.at(-1)!.id, before })) };
		turns.push(turn);
		// Its posts come after the message, so the trigger stays the one to answer.
		for (const text of turn.posted) seen.push({ author: w.agent.name, agent: w.agent.key, text, id: `${said.at(-1)!.id}-${seen.length}` });
		// Named another agent: it answers next, as a hop on the post (chains.ts), unless it's a pick still to run.
		const named = input.agents.find((a) => a.name === turn.to && a !== w.agent);
		if (!named || picks.slice(i + 1).some((p) => p.agent === named)) continue;
		const hop: Woken = { agent: named, band: "clearly" };
		const post = seen.at(-1)!;
		const answer = { ...hop, ...(await quietTurn({ woken: hop, agents: input.agents, people: input.people, channel: input.place.name, said: seen, triggerId: post.id, person: input.message.author, from: w.agent.name, by: w.agent.name })) };
		turns.push(answer);
		for (const text of answer.posted) seen.push({ author: named.name, agent: named.key, text, id: `${said.at(-1)!.id}-${seen.length}` });
	}
	count(tally, turns);
	score(tally, label, input.agents, turns, expect);
	const posts = turns.flatMap((t) => t.posted.map((text) => ({ agent: t.agent, text })));
	await checkPosts(tally, label, input.message.author, input.message.text, posts, checks);
	return { posts, reacted: turns.filter((t) => t.reacted).map((t) => t.agent) };
}

it("scores the full path: dispatcher, then the agent's quiet turn", { timeout: 20 * 60_000 }, async () => {
	if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Set AI_GATEWAY_API_KEY: the eval calls real models.");
	const runs = Number(process.env.FULL_EVAL_RUNS ?? 1);
	const tally: Tally = { errors: 0, decisions: 0, right: 0, butted: 0, duplicates: 0, silent: 0, filler: 0, long: 0, together: { built: 0, pairs: 0 }, costUsd: 0, messages: 0, turns: 0, ms: [], woken: { clearly: 0, probably: 0, might: 0 }, misses: [] };
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
				const { posts, reacted } = await step(tally, `${transcript.name}, step ${i + 1} ${JSON.stringify(s.message.text)}`, input, said, s.expect(posted, responded), s);
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
			await checkPosts(tally, `hand-back: ${h.name}`, from.name, h.message.text, turns.flatMap((t) => t.posted.map((text) => ({ agent: t.agent, text }))), {});
			print(`hand-back: ${h.name} → ${turns.map((t) => `${t.agent.name} (${t.band}): ${t.posted.length ? JSON.stringify(t.posted[0]!.slice(0, 80)) : "nothing posted"}`).join("; ") || "nobody woken"}`);
		});
		// The second pick on a message, after the first posted: builds on it, or stays out.
		const anchored = anchors.map(async (a) => {
			const agents = transcripts[0]!.agents;
			tally.messages++;
			const said = [{ ...a.message, id: "m" }, { ...a.earlier, id: "e" }];
			const woken: Woken = { agent: a.next, band: "probably" };
			const turn = { ...woken, ...(await quietTurn({ woken, agents, people: ["j", "Dana"], channel: "general", said, triggerId: "m", before: [a.earlier.author] })) };
			count(tally, [turn]);
			await checkPosts(tally, `anchor: ${a.name}`, a.message.author, a.message.text, [{ agent: agents.find((x) => x.key === a.earlier.agent)!, text: a.earlier.text }, ...turn.posted.map((text) => ({ agent: a.next, text }))], { together: true });
			print(`anchor: ${a.name} → ${a.next.name}: ${turn.posted.length ? JSON.stringify(turn.posted[0]!.slice(0, 100)) : "nothing posted"}`);
		});
		// A failed call (the gateway has bad moments) skips its moment, counted apart.
		await Promise.all([...moments, ...conversations, ...backs, ...anchored].map((p) => p.catch((e: unknown) => (tally.errors++, print(`  error: ${e instanceof Error ? e.message.slice(0, 120) : e}`)))));
	}
	print(`\n${tally.misses.length ? `Misses:\n${tally.misses.join("\n")}` : "No misses."}`);
	const steps = transcripts.reduce((n, t) => n + t.steps.length, 0) + anchors.length;
	const ms = [...tally.ms].sort((a, b) => a - b);
	const p = (q: number) => `${((ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0) / 1000).toFixed(1)}s`;
	print(
		[
			"",
			`Full path, ${fullPathCases.length} moments + ${steps} transcript steps + ${handBacks.length} hand-backs × ${runs} run(s), ${new Date().toISOString().slice(0, 10)}, dispatcher ${ROUTER_MODEL}, agents on ${defaultModel}`,
			"| Decisions right | Butted in (duplicates) | Silent misses | Filler posted | Too long | Built on earlier | Agent turns (clearly / probably / might) | Turn p50 / p90 | Tokens per turn in (cached) / out | $ per message | $ total | Errors |",
			"|---|---|---|---|---|---|---|---|---|---|---|---|",
			`| ${tally.right}/${tally.decisions} (${((100 * tally.right) / tally.decisions).toFixed(0)}%) | ${tally.butted} (${tally.duplicates}) | ${tally.silent} | ${tally.filler} | ${tally.long} | ${tally.together.built}/${tally.together.pairs} | ${tally.turns} (${tally.woken.clearly} / ${tally.woken.probably} / ${tally.woken.might}) | ${p(0.5)} / ${p(0.9)} | ${Math.round(TOKENS.input / tally.turns)} (${Math.round((100 * TOKENS.cached) / TOKENS.input)}%) / ${Math.round(TOKENS.output / tally.turns)} | $${(tally.costUsd / tally.messages).toFixed(5)} | $${tally.costUsd.toFixed(4)} | ${tally.errors} |`,
		].join("\n"),
	);
});
