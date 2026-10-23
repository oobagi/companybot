import type { AgentConfig } from "./agent-config";
import type { Participant } from "./chat";
import { platformGuide } from "./guide";
import { type Skill, skillsIndex } from "./skills";
import { isGranted } from "./tools";
import type { Role } from "./types";

// What the model is fed each turn, built for prompt caching (wiki/chat.md):
// 1. `instructions`: the same for every chat and turn, so it caches everywhere.
// 2. The session: each past turn replayed exactly as sent (stored prompt + reply).
// 3. One new user message: where you are, what was said since the last reply, the trigger.
// Nothing earlier in the prompt changes between turns, so only the new message is uncached.

/** Messages shown in a turn's prompt before the rest are left to chat.read. */
export const PROMPT_MESSAGE_CAP = 50;

/** A message in the place, display-ready. */
export interface PlaceMessage {
	id: string;
	author: Participant;
	/** Text plus a note for each widget it showed. */
	text: string;
	/** Epoch ms. */
	time: number;
	edited?: boolean;
	/** Main-timeline thread parents only. */
	replyCount?: number;
}

export interface TurnPlace {
	kind: "channel" | "dm";
	/** Channels only. */
	name: string | null;
	private: boolean;
	topic: string | null;
	/** Set when the turn is in a thread. */
	thread: { parent: PlaceMessage; first: boolean } | null;
	/** Everyone in the chat, the agent included. */
	members: Participant[];
}

export interface TurnPromptInput {
	agentId: string;
	place: TurnPlace;
	/** The person the agent acts for. */
	actor: { name: string; email: string; role: Role };
	/** "personal" only in a DM with exactly one person. */
	memory: "personal" | "team";
	/** Services the agent can reach this turn through plugins_search, and ones that failed to connect. */
	plugins: { connected: { name: string; description: string }[]; unavailable: string[] };
	/** Everything said in the place since the agent's last reply, oldest first, trigger included. */
	messages: PlaceMessage[];
	triggerId: string;
}

/** The new user message for one turn. Stored as `agentTurns.prompt` and replayed byte-identical later. */
export function buildTurnPrompt(input: TurnPromptInput): string {
	const { place, actor, messages } = input;
	const others = (type: Participant["type"]) =>
		place.members.filter((m) => m.type === type && m.id !== input.agentId).map((m) => m.name);
	const people = others("user");
	const agents = others("agent");

	const where =
		place.kind === "channel"
			? `#${place.name}, a ${place.private ? "private" : "public"} channel${place.topic ? `. Topic: ${place.topic.replace(/\.$/, "")}` : ""}`
			: people.length === 1 && agents.length === 0
				? `a DM with ${people[0]}`
				: `a group DM`;
	const header = [
		`Where you are: ${where}${place.thread ? ", in a thread" : ""}.`,
		`Here: ${[people.length > 0 && `${people.join(", ")} (people)`, agents.length > 0 && `${agents.join(", ")} (agents)`]
			.filter(Boolean)
			.join("; ") || "just you"}.`,
		`${actor.name} <${actor.email}>, a workspace ${actor.role}, asked for you. You act with their access.`,
		input.memory === "personal"
			? "Memory: personal and team memories."
			: "Memory: team memories only. 2+ people can read this chat, so personal memories are off.",
		input.plugins.connected.length > 0 &&
			`Connected services (find their tools with plugins_search): ${input.plugins.connected.map((p) => `${p.name}: ${p.description}`).join(" ")}`,
		input.plugins.unavailable.length > 0 &&
			`Unavailable this turn, so you can't use them: ${input.plugins.unavailable.join(", ")}.`,
	];

	const trigger = messages.find((m) => m.id === input.triggerId);
	const rest = messages.filter((m) => m.id !== input.triggerId);
	const shown = rest.slice(-PROMPT_MESSAGE_CAP);
	const hidden = rest.length - shown.length;

	const sections = [header.filter(Boolean).join("\n")];
	if (place.thread?.first) sections.push(`The thread is under this message:\n${line(place.thread.parent)}`);
	if (shown.length > 0) {
		sections.push(
			[
				`New here since your last reply (times UTC):`,
				hidden > 0 && `(${hidden} earlier messages not shown. Use chat_read for them.)`,
				...shown.map(line),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	if (trigger) sections.push(`Reply to this message from ${trigger.author.name}:\n${line(trigger)}`);
	return sections.join("\n\n");
}

/** `[Ada 10-22 15:04] text`, plus edit and thread notes. */
function line(m: PlaceMessage) {
	const iso = new Date(m.time).toISOString();
	const notes = [
		m.edited && "(edited)",
		m.replyCount && `(${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"} in thread ${m.id})`,
	].filter(Boolean);
	return [`[${m.author.name} ${iso.slice(5, 10)} ${iso.slice(11, 16)}] ${m.text}`, ...notes].join(" ");
}

/** The agent's system prompt. Nothing per chat or per turn goes here. */
export function systemPrompt(agent: Pick<AgentConfig, "instructions" | "tools">, skills: Skill[]): string {
	return [agent.instructions, platformGuide(agent), isGranted(agent.tools, "skills.load") && skillsIndex(skills)]
		.filter(Boolean)
		.join("\n\n");
}

/** A finished turn in the session, as it was sent and answered. */
export interface SessionTurn {
	prompt: string;
	/** The reply's text plus widget notes. */
	reply: string;
}

export type TurnMessage = { role: "user" | "assistant"; content: string };

/**
 * Everything the model gets for one turn. The only place that decides context;
 * change the strategy here.
 */
export function buildTurnInput(input: {
	agent: Pick<AgentConfig, "instructions" | "tools">;
	skills: Skill[];
	session: { summary: string | null; turns: SessionTurn[] };
	prompt: string;
}): { instructions: string; messages: TurnMessage[] } {
	const { session } = input;
	const messages: TurnMessage[] = [];
	const push = (role: TurnMessage["role"], content: string) => {
		// Consecutive same-role messages merge, since some providers require alternating roles.
		const last = messages.at(-1);
		if (last?.role === role) last.content += `\n\n${content}`;
		else messages.push({ role, content });
	};
	if (session.summary) push("user", `Summary of your earlier turns here:\n${session.summary}`);
	for (const turn of session.turns) {
		push("user", turn.prompt);
		push("assistant", turn.reply || "(No reply.)");
	}
	push("user", input.prompt);
	return { instructions: systemPrompt(input.agent, input.skills), messages };
}

/** Rough token count, for deciding what compaction keeps. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
