import type { AgentConfig } from "./agent-config";
import type { ApprovalOutcome } from "./approvals";
import type { Participant } from "./chat";
import { platformGuide } from "./guide";
import { type Skill, skillsIndex } from "./skills";
import { shortStamp } from "./time";
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
	/** The person the agent acts for. `timeZone` is resolved (see resolveTimeZone). */
	actor: { name: string; email: string; role: Role; timeZone: string };
	/** "personal" only in a DM with exactly one person. */
	memory: "personal" | "team";
	/** Services the agent can reach this turn through connectors_search, and ones that failed to connect. */
	connectors: { connected: { name: string; description: string }[]; unavailable: string[] };
	/** Everything said in the place since the agent's last reply, oldest first, trigger included. */
	messages: PlaceMessage[];
	triggerId: string;
	/** Set when this turn follows an approval decision: it answers that instead of a message. */
	approval?: ApprovalOutcome;
}

/** The new user message for one turn. Stored as `agentTurns.prompt` and replayed byte-identical later. */
export function buildTurnPrompt(input: TurnPromptInput): string {
	const { place, actor, messages } = input;
	const others = (type: Participant["type"]) =>
		place.members.filter((m) => m.type === type && m.id !== input.agentId).map((m) => m.name);
	const people = others("user");
	const agents = others("agent");
	const here =
		[people.length > 0 && `${people.join(", ")} (people)`, agents.length > 0 && `${agents.join(", ")} (agents)`]
			.filter(Boolean)
			.join("; ") || "just you";

	const header = [
		`Where you are: ${describePlace(place, people, agents)}${place.thread ? ", in a thread" : ""}.`,
		`Here: ${here}.`,
		`${actor.name} <${actor.email}>, a workspace ${actor.role}, asked for you. You act with their access. Their time zone: ${actor.timeZone}.`,
		input.memory === "personal"
			? "Memory: personal and team memories."
			: "Memory: team memories only. 2+ people can read this chat, so personal memories are off.",
		input.connectors.connected.length > 0 &&
			`Connected services (find their tools with connectors_search): ${input.connectors.connected.map((p) => `${p.name}: ${p.description}`).join(" ")}`,
		input.connectors.unavailable.length > 0 &&
			`Unavailable this turn, so you can't use them: ${input.connectors.unavailable.join(", ")}.`,
	];

	const trigger = messages.find((m) => m.id === input.triggerId);
	const rest = messages.filter((m) => m.id !== input.triggerId);
	const shown = rest.slice(-PROMPT_MESSAGE_CAP);
	const hidden = rest.length - shown.length;

	const sections = [header.filter(Boolean).join("\n")];
	const line = (m: PlaceMessage) => chatLine(m, actor.timeZone);
	if (place.thread?.first) sections.push(`The thread is under this message:\n${line(place.thread.parent)}`);
	if (shown.length > 0) {
		sections.push(
			[
				`New here since your last reply (times in ${actor.timeZone}):`,
				hidden > 0 && `(${hidden} earlier messages not shown. Use chat_read for them.)`,
				...shown.map(line),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	if (input.approval) sections.push(approvalSection(input.approval));
	else if (trigger) sections.push(`Reply to this message from ${trigger.author.name}:\n${line(trigger)}`);
	return sections.join("\n\n");
}

/** What the agent hears after someone decides on a call it held for approval. */
function approvalSection({ tool, by, decision, result, error }: ApprovalOutcome) {
	if (decision === "denied") {
		return `${by} denied your ${tool} call, so it didn't run. Don't try it again unless they ask. Acknowledge briefly, or ask what to change if that's unclear.`;
	}
	if (error !== undefined) return `${by} approved your ${tool} call, but it failed: ${error}\nTell them briefly and suggest a next step.`;
	return `${by} approved your ${tool} call and it ran with exactly the input you sent. Result:\n\`\`\`json\n${result ?? "null"}\n\`\`\`\nTell them briefly what happened, then finish what they asked.`;
}

/** "#sales, a public channel. Topic: …", "a DM with Ada", or "a group DM". */
function describePlace(place: TurnPlace, people: string[], agents: string[]) {
	if (place.kind === "channel") {
		const topic = place.topic ? `. Topic: ${place.topic.replace(/\.$/, "")}` : "";
		return `#${place.name}, a ${place.private ? "private" : "public"} channel${topic}`;
	}
	return people.length === 1 && agents.length === 0 ? `a DM with ${people[0]}` : "a group DM";
}

/** `[Ada 10-22 15:04] text` (time in `timeZone`), plus edit and thread notes. */
function chatLine(m: PlaceMessage, timeZone: string) {
	const notes = [
		m.edited && "(edited)",
		m.replyCount && `(${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"} in thread ${m.id})`,
	].filter(Boolean);
	return [`[${m.author.name} ${shortStamp(m.time, timeZone)}] ${m.text}`, ...notes].join(" ");
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
