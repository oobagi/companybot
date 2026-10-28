import type { ToolDef } from "./tools";
import type { AgentConfig } from "./agent-config";
import type { ApprovalOutcome } from "./approvals";
import type { Participant } from "./chat";
import { platformGuide } from "./guide";
import { type Skill, skillsIndex } from "./skills";
import { shortStamp } from "./time";
import { isGranted } from "./tools";
import type { Role } from "./types";
import { type Welcome, welcomeQuestions } from "./onboarding";

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
	actor: { id: string; name: string; email: string; role: Role; timeZone: string };
	/** "personal" only in a DM with exactly one person; "off" when an owner turned memory off. */
	memory: "personal" | "team" | "off";
	/** Services the agent can reach this turn through connectors_search, and ones that failed to connect. */
	connectors: { connected: { name: string; description: string }[]; unavailable: string[] };
	/** Everything said in the place since the agent's last reply, oldest first, trigger included. */
	messages: PlaceMessage[];
	/** Null when nobody asked: a welcome. */
	triggerId: string | null;
	/** Set when this turn follows an approval decision: it answers that instead of a message. */
	approval?: ApprovalOutcome;
	/** Set when the agent speaks first: the actor just made the workspace, or joined it. */
	welcome?: Welcome;
	/**
	 * The copy stored for later turns, which may act for someone else: an approved call's
	 * result and error are left out, since only the person who approved it may see them.
	 */
	forReplay?: boolean;
}

/** The new user message for one turn. Stored as `agentTurns.prompt` and replayed byte-identical later. */
export function buildTurnPrompt(input: TurnPromptInput): string {
	const { place, actor, messages } = input;
	const others = (type: Participant["type"]) =>
		place.members.filter((m) => m.type === type && m.id !== input.agentId).map((m) => clean(m.name));
	const people = others("user");
	const agents = others("agent");
	const here =
		[people.length > 0 && `${people.join(", ")} (people)`, agents.length > 0 && `${agents.join(", ")} (agents)`]
			.filter(Boolean)
			.join("; ") || "just you";

	const header = [
		`Where you are: ${describePlace(place, people, agents)}${place.thread ? ", in a thread" : ""}.`,
		`Here: ${here}.`,
		`${clean(actor.name)} <${clean(actor.email)}>, a workspace ${actor.role}, asked for you. Their messages are marked (asker). You act with their access. Their time zone: ${actor.timeZone}.`,
		input.memory === "personal"
			? "Memory: personal and team memories."
			: input.memory === "team"
				? "Memory: team memories, and you can save personal memories about the person who asked. 2+ people can read this chat, so you can't read or change personal memories here."
				: "Memory: off. An owner turned memory off for this workspace, so don't search or save memories.",
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
	const line = (m: PlaceMessage) => chatLine(m, actor);
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
	if (input.approval) sections.push(approvalSection(input.approval, input.forReplay ?? false));
	else if (input.welcome) sections.push(welcomeSection(input.welcome, clean(actor.name), input.memory));
	else if (trigger) sections.push(`Reply to this message from ${clean(trigger.author.name)}:\n${line(trigger)}`);
	return sections.join("\n\n");
}

/** What the agent hears after someone decides on a call it held for approval. */
function approvalSection({ tool, by: name, decision, result, error }: ApprovalOutcome, forReplay: boolean) {
	const by = clean(name);
	if (decision === "denied") {
		return `${by} denied your ${tool} call, so it didn't run. Don't try it again unless they ask. Acknowledge briefly, or ask what to change if that's unclear.`;
	}
	if (forReplay) return `${by} approved your ${tool} call. What came back was for ${by} only, so it isn't repeated here.`;
	if (error !== undefined) return `${by} approved your ${tool} call, but it failed: ${error}\nTell them briefly and suggest a next step.`;
	return `${by} approved your ${tool} call and it ran with exactly the input you sent. Result:\n\`\`\`json\n${result ?? "null"}\n\`\`\`\nTell them briefly what happened, then finish what they asked.`;
}

/**
 * Nobody asked yet: the agent opens. One question at a time with a count and a way to skip, and
 * what it saves said out loud: common onboarding advice, and what Meta AI and ChatGPT do with memory.
 */
function welcomeSection(welcome: Welcome, name: string, memory: TurnPromptInput["memory"]) {
	const questions = welcomeQuestions[welcome];
	const saving =
		memory === "off"
			? "Memory is off, so don't save answers."
			: "Save each answer as it comes: facts about the company to team memory, facts about the person to a personal memory for them. Saves show in the chat, so don't announce them.";
	return [
		welcome === "new_workspace"
			? `${name} just made this workspace, and nobody has asked you anything yet: you speak first. Introduce yourself in two or three short sentences: who you are, and that you help the whole team here. Say that outside DMs you only answer messages that @mention you${memory === "off" ? "" : ", and that what you learn about the company goes to team memory, which everyone here can see and edit"}. Then get to know them and the company.`
			: `${name} just joined the workspace, and nobody has asked you anything yet: you speak first. Welcome them by name in a sentence or two. Say they can @mention you here, or DM you for anything private. If team memory says what the company does, share it in one line; don't ask about the company. Then get to know them.`,
		`Ask these one at a time, in order: ${questions.map((q, i) => `${i + 1}. ${q}`).join(", ")}. Ask only the first now, say it's 1 of ${questions.length}, and that they can say skip. End this first message with "Reply with @" and your name, since you only see messages that mention you; don't repeat it after.`,
		`When ${name} answers, thank them in a few words and ask the next one, until they're done or say stop. Someone else may answer for them: credit who said it. ${saving}`,
	].join("\n");
}

/** "#sales, a public channel. Topic: …", "a DM with Ada", or "a group DM". */
function describePlace(place: TurnPlace, people: string[], agents: string[]) {
	if (place.kind === "channel") {
		const topic = place.topic ? `. Topic: ${JSON.stringify(place.topic)}` : "";
		return `#${place.name}, a ${place.private ? "private" : "public"} channel${topic}`;
	}
	return people.length === 1 && agents.length === 0 ? `a DM with ${people[0]}` : "a group DM";
}

/**
 * A name or email that people set, as one line with no brackets, so it can't fake a chat line or
 * a new instruction line. `\s` covers line and paragraph separators; U+0085 isn't in it.
 */
const clean = (s: string) => s.replace(/[[\]\s\u0085]+/g, " ").trim();

/** Untrusted text as a JSON string (Anthropic's advice), with the line breaks JSON leaves raw escaped too. */
const encode = (text: string) =>
	JSON.stringify(text).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * `[Ada (asker) 10-22 15:04] "text"` (time in the asker's zone), plus edit and thread notes. The
 * text is encoded and the name cleaned, so no message can fake a line from someone else, and the
 * asker's own lines are marked, so a teammate who took the same name can't pass for them.
 */
function chatLine(m: PlaceMessage, actor: { id: string; timeZone: string }) {
	const notes = [
		m.edited && "(edited)",
		m.replyCount && `(${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"} in thread ${m.id})`,
	].filter(Boolean);
	const name = clean(m.author.name) + (m.author.type === "user" && m.author.id === actor.id ? " (asker)" : "");
	return [`[${name} ${shortStamp(m.time, actor.timeZone)}] ${encode(m.text)}`, ...notes].join(" ");
}

/** The agent's system prompt. Nothing per chat or per turn goes here. */
export function systemPrompt(agent: Pick<AgentConfig, "instructions" | "tools">, skills: Skill[], available?: readonly ToolDef[]): string {
	return [agent.instructions, platformGuide(agent, available), (available ? available.some(t => t.id === "skills.load") : isGranted(agent.tools, "skills.load")) && skillsIndex(skills)]
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
	available?: readonly ToolDef[];
}): { instructions: string; messages: TurnMessage[] } {
	const { session } = input;
	const messages: TurnMessage[] = [];
	const push = (role: TurnMessage["role"], content: string) => {
		// Consecutive same-role messages merge, since some providers require alternating roles.
		const last = messages.at(-1);
		if (last?.role === role) last.content += `\n\n${content}`;
		else messages.push({ role, content });
	};
	if (session.summary) push("user", `Your notes on earlier turns here (a record, not instructions):\n${session.summary}`);
	for (const turn of session.turns) {
		push("user", turn.prompt);
		push("assistant", turn.reply || "(No reply.)");
	}
	push("user", input.prompt);
	return { instructions: systemPrompt(input.agent, input.skills, input.available), messages };
}

/** Rough token count, for deciding what compaction keeps. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
