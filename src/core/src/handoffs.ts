// Agents handing work to each other (wiki/chat.md, Agents working together). An agent's @mention of
// another queues that agent's turn, for the same person; an agent can ask another privately
// (chat.ask_agent). Every handoff in a chain is checked against these limits first; the backend
// (backend/convex/chains.ts) keeps the counts and pauses the chain visibly when one is hit.

/** Asks inside asks: an asked agent may ask another, up to this deep. */
export const CHAIN_MAX_DEPTH = 3;
/** Agent turns one chain may start before it pauses. */
export const CHAIN_MAX_TURNS = 10;
/** Handoffs the dispatcher picks (nobody @mentioned the next agent) per chain. */
export const CHAIN_MAX_HOPS = 3;
/** Back-and-forths between the same two agents per chain. */
export const CHAIN_MAX_ROUND_TRIPS = 2;
/** Agent messages in a place since a person last wrote there, before agents stop handing off there. */
export const PLACE_MAX_AGENT_POSTS = 4;
/** The dispatcher wakes the agent it picks only this sure; else nobody goes next. */
export const NEXT_MIN_PROBABILITY = 0.6;

/** What a chain has used of its budget since it started, a person wrote in it, or someone pressed Continue. */
export interface ChainBudget<Id extends string = string> {
	turns: number;
	hops: number;
	/** Handoffs between each pair of agents, either way. */
	pairs: { a: Id; b: Id; n: number }[];
}

export interface Handoff<Id extends string = string> {
	from: Id;
	to: Id;
	/** The agents from the chain's start to `from`, `from` last. */
	path: Id[];
	/** The dispatcher picked `to`: nobody @mentioned it. */
	dispatched?: boolean;
	/** A private ask (chat.ask_agent): the asked agent's depth, and its answer coming back. */
	ask?: { depth: number };
	/** Agent messages in the place it lands in since a person last wrote there. Unset for asks (a new thread). */
	agentPosts?: number;
}

export type PauseReason =
	| { kind: "ring" }
	| { kind: "pair"; a: string; b: string }
	| { kind: "turns" }
	| { kind: "hops" }
	| { kind: "posts" }
	| { kind: "depth" };

/** A handoff counts once between its pair; an ask twice, since its answer comes back. */
const pairCount = <Id extends string>(budget: ChainBudget<Id>, a: Id, b: Id) => budget.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.n ?? 0;

/** Why a handoff can't go ahead, or null if it can. Checked in this order, so the clearest reason wins. */
export function handoffLimit<Id extends string>(budget: ChainBudget<Id>, h: Handoff<Id>): PauseReason | null {
	if (h.ask && h.ask.depth > CHAIN_MAX_DEPTH) return { kind: "depth" };
	// Handing back to whoever handed you the work is a round trip, counted by pair; any other return is a ring.
	if (h.path.includes(h.to) && h.path.at(-2) !== h.to) return { kind: "ring" };
	if (pairCount(budget, h.from, h.to) + (h.ask ? 2 : 1) > CHAIN_MAX_ROUND_TRIPS * 2) return { kind: "pair", a: h.from, b: h.to };
	if (budget.turns + (h.ask ? 2 : 1) > CHAIN_MAX_TURNS) return { kind: "turns" };
	if (h.dispatched && budget.hops + 1 > CHAIN_MAX_HOPS) return { kind: "hops" };
	if (h.agentPosts !== undefined && h.agentPosts >= PLACE_MAX_AGENT_POSTS) return { kind: "posts" };
	return null;
}

/** The budget after a handoff that went ahead. */
export function spend<Id extends string>(budget: ChainBudget<Id>, h: Handoff<Id>): ChainBudget<Id> {
	const n = h.ask ? 2 : 1;
	const pairs = budget.pairs.filter((p) => !((p.a === h.from && p.b === h.to) || (p.a === h.to && p.b === h.from)));
	return {
		turns: budget.turns + n,
		hops: budget.hops + (h.dispatched ? 1 : 0),
		pairs: [...pairs, { a: h.from, b: h.to, n: pairCount(budget, h.from, h.to) + n }],
	};
}

export const freshBudget = <Id extends string = never>(turns = 0): ChainBudget<Id> => ({ turns, hops: 0, pairs: [] });

/** The paused line's words, for people ("Agents paused after 10 turns") and for the agents who read it later. */
export function pauseText(reason: PauseReason, name: (id: string) => string) {
	switch (reason.kind) {
		case "ring":
			return "Agents paused: the work came back around to an agent that already had it.";
		case "pair":
			return `Agents paused: ${name(reason.a)} and ${name(reason.b)} went back and forth ${CHAIN_MAX_ROUND_TRIPS} times.`;
		case "turns":
			return `Agents paused after ${CHAIN_MAX_TURNS} turns.`;
		case "hops":
			return `Agents paused after ${CHAIN_MAX_HOPS} handoffs nobody asked for.`;
		case "posts":
			return `Agents paused after ${PLACE_MAX_AGENT_POSTS} messages in a row with no reply from a person.`;
		case "depth":
			return `Agents paused: asks can only go ${CHAIN_MAX_DEPTH} deep.`;
	}
}

/** Why an ask was refused, for the asking agent's tool result. */
export function askRefusal(reason: PauseReason, name: (id: string) => string) {
	const why = {
		ring: "it would send the work back around to an agent that already had it",
		pair: reason.kind === "pair" ? `${name(reason.a)} and ${name(reason.b)} already went back and forth ${CHAIN_MAX_ROUND_TRIPS} times` : "",
		turns: `agents already took ${CHAIN_MAX_TURNS} turns on this`,
		hops: `agents already handed this on ${CHAIN_MAX_HOPS} times unasked`,
		posts: `agents already wrote ${PLACE_MAX_AGENT_POSTS} messages in a row here`,
		depth: `asks can only go ${CHAIN_MAX_DEPTH} deep`,
	}[reason.kind];
	return `Not asked: ${why}. Answer with what you have, or ask the person.`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Agents an agent's text @mentions, by full name (longest first, so "@Scout Pro" isn't "@Scout"),
 * in the order written. Not inside code, where an @name is an example, not a handoff.
 */
export function mentionedAgents<A extends { id: string; name: string }>(text: string, agents: A[]): A[] {
	const named = agents.filter((a) => a.name.trim());
	if (named.length === 0) return [];
	const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
	const names = [...named].sort((a, b) => b.name.length - a.name.length);
	const pattern = new RegExp(`(?<![\\w@])@(${names.map((a) => escape(a.name.trim())).join("|")})(?![\\w-])`, "gi");
	const found: A[] = [];
	for (const match of prose.matchAll(pattern)) {
		const agent = names.find((a) => a.name.trim().toLowerCase() === match[1]!.toLowerCase());
		if (agent && !found.includes(agent)) found.push(agent);
	}
	return found;
}
