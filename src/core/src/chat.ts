import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/**
 * How long a thread stays under its channel in the sidebar after its last reply, in hours: an
 * owner's pick per workspace (`workspaces.threadHours`), like Discord's auto-archive duration.
 * 0 is forever: every thread with a reply stays.
 */
export const threadWindows = [
	{ hours: 1, label: "1 hour" },
	{ hours: 24, label: "1 day" },
	{ hours: 72, label: "3 days" },
	{ hours: 168, label: "1 week" },
	{ hours: 0, label: "Forever" },
] as const;
export const THREAD_HOURS_DEFAULT = 72;
/** Longest channel topic, in characters, like Slack. Every writer (app, agents, tools) holds to it. */
export const TOPIC_MAX = 250;
/** Messages per page of a chat or thread: the app loads this many at a time, older ones as you scroll up. */
export const MESSAGE_PAGE = 50;

export const isThreadWindow = (hours: number) => threadWindows.some((w) => w.hours === hours);

/** A person or agent in a chat, with a display name. */
export interface Participant {
	type: "user" | "agent";
	id: string;
	name: string;
}

/** One emoji on a message and who added it, in the order they did: chat tools and turn prompts both show these. */
export interface ReactionGroup {
	emoji: string;
	by: string[];
}

/** A message as chat tools return it. */
export interface ChatLine {
	id: string;
	/** "#sales", or "DM with Ada, Ben". */
	chat: string;
	/** Set for thread replies: the parent message's id. */
	threadOf?: string;
	author: string;
	/** ISO 8601, UTC. */
	time: string;
	text: string;
	/** Thread parents only. */
	replies?: number;
	reactions?: ReactionGroup[];
	/** Attached files. `id` is what chat.read_file takes. */
	files?: { id: string; name: string; type: string; size: number }[];
}

const readInput = z.object({
	chat: z.string().optional().describe('Channel like "#sales". Omit for here.'),
	threadOf: z.string().optional().describe("Message id whose thread to read"),
	before: z.string().optional().describe("ISO time; only messages before it"),
	limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
});
export type ChatReadInput = z.infer<typeof readInput>;

export type ChatResult = { messages: ChatLine[]; notice?: string } | { error: string };

/** One page of an attached file's text. */
export type FileResult = { name: string; type: string; page: number; pages: number; text: string } | { error: string };

/**
 * Chats as the person the agent acts for sees them. Implementations must check
 * visibility on every call (re-reading membership); tools rely on that.
 */
export interface ChatStore {
	read(input: ChatReadInput): Promise<ChatResult>;
	search(input: { query: string; chat?: string }): Promise<ChatResult>;
	/** A file attached to a message in a chat they can see. */
	readFile(input: { id: string; page?: number }): Promise<FileResult>;
	/** Asks another agent privately, for the same person: a thread kept out of the chat. Its answer comes back as a new turn. */
	ask(input: { agent: string; message: string }): Promise<AskResult>;
}

export type AskResult = { asked: string; thread: { chatId: string; messageId: string }; note: string } | { error: string };

/** Longest question one ask carries. */
export const ASK_TEXT_MAX = 4000;

/**
 * Exactly one emoji, any of them, checked by its structure (Unicode's emoji sequences: one emoji with
 * an optional variation selector or skin tone, joined into a ZWJ sequence or ending in a subdivision
 * flag's tags; a two-letter flag; a keycap), never against a list or as text. The one rule for an
 * agent's reaction (its decision's `emoji`) and for a person's.
 */
const EMOJI_PART = String.raw`(?!\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?`;
const ONE_EMOJI = new RegExp(String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${EMOJI_PART}(?:\u200D${EMOJI_PART})*[\u{E0020}-\u{E007E}]*\u{E007F}?)$`, "u");
// Unicode tag text is invisible. Only the three standardized subdivision flags may carry it.
const SUBDIVISIONS = ["gbeng", "gbsct", "gbwls"].map((tag) => "🏴" + [...tag].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("") + "\u{e007f}");
export const isEmoji = (s: unknown): s is string => typeof s === "string" && ONE_EMOJI.test(s) && (!/[\u{E0020}-\u{E007F}]/u.test(s) || SUBDIVISIONS.includes(s));
/**
 * The one emoji in `s`, fully qualified (Unicode's form, and the picker's), or null: "❤" and "❤️" are the
 * same reaction, stored once. Each part shown as text by default gets U+FE0F, and no other part keeps one.
 */
export const emojiOf = (s: unknown) =>
	isEmoji(s) ? s.replace(/\uFE0F/g, "").replace(/[#*0-9](?=\u20E3)|(?=\p{Extended_Pictographic})(?!\p{Emoji_Presentation})\p{Emoji}(?!\p{Emoji_Modifier})/gu, "$&\uFE0F") : null;

export const chatTools: ToolDef[] = [
	defineTool({
		id: "chat.read",
		title: "Read the chat",
		description:
			"Read chat messages, oldest first: earlier ones here, a channel (\"#sales\"), or a thread (threadOf: message id).",
		input: readInput,
		readOnly: true,
		// Can read their private channels and DMs.
		risk: "inside",
		execute: (input, { chat }) => chat.read(input),
	}),
	defineTool({
		id: "chat.search",
		title: "Search the chat",
		description: "Search messages in chats the person can see.",
		input: z.object({ query: z.string().min(1), chat: z.string().optional().describe('Limit to a channel like "#sales"') }),
		readOnly: true,
		risk: "inside",
		returnsData: true,
		execute: (input, { chat }) => chat.search(input),
	}),
	defineTool({
		id: "chat.read_file",
		title: "Read a file",
		description: "Read the text of a file attached to a message (PDF, Word, Excel, CSV, text), by the file id shown with it. Long files come in pages: ask for the next with page.",
		input: z.object({
			id: z.string().describe('The file id, like "<message id>/0"'),
			page: z.number().int().min(1).optional().describe("Default 1"),
		}),
		readOnly: true,
		// Can read files in their private channels and DMs.
		risk: "inside",
		label: (_input, output) => {
			const name = output && typeof output === "object" && "name" in output ? String(output.name) : undefined;
			return name && `Read ${JSON.stringify(name)}`;
		},
		execute: (input, { chat }) => chat.readFile(input),
	}),
	defineTool({
		id: "chat.ask_agent",
		title: "Ask an agent",
		description:
			"Ask another agent a question privately, for the person you act for, when you need what it knows or does to finish their request. It answers out of the chat (the person can open the exchange from your reply, read-only); its answer comes back to you later in a new message here, and then you finish the reply. Ask once, with everything it needs. To hand work over in the open instead, @mention the agent in your reply.",
		input: z.object({
			agent: z.string().describe("The agent's name"),
			message: z.string().min(1).max(ASK_TEXT_MAX).describe("What you need, in one message"),
		}),
		// Another agent works for the same person, here; it asks for anything it would ask for itself.
		risk: "none",
		label: ({ agent }) => (typeof agent === "string" && agent.trim() ? `Ask ${agent.trim().replace(/^@/, "")}` : undefined),
		opens: (output) => {
			const thread = output && typeof output === "object" && "thread" in output ? (output as { thread: unknown }).thread : undefined;
			return thread && typeof thread === "object" && "chatId" in thread && "messageId" in thread ? (thread as { chatId: string; messageId: string }) : undefined;
		},
		execute: (input, { chat }) => chat.ask(input),
	}),
];
