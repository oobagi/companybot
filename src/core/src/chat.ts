import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/**
 * How long a thread stays under its channel in the sidebar after its last reply, in hours: an
 * owner's pick per workspace (`workspaces.threadHours`), like Discord's auto-archive duration.
 */
export const threadWindows = [
	{ hours: 1, label: "1 hour" },
	{ hours: 24, label: "1 day" },
	{ hours: 72, label: "3 days" },
	{ hours: 168, label: "1 week" },
] as const;
export const THREAD_HOURS_DEFAULT = 72;
export const isThreadWindow = (hours: number) => threadWindows.some((w) => w.hours === hours);

/** A person or agent in a chat, with a display name. */
export interface Participant {
	type: "user" | "agent";
	id: string;
	name: string;
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
	/** Emoji and who added each. */
	reactions?: { emoji: string; by: string[] }[];
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

export type ChatResult = { messages: ChatLine[] } | { error: string };

/** One page of an attached file's text. */
export type FileResult = { name: string; type: string; page: number; pages: number; text: string } | { error: string };

/**
 * Chats as the person the agent acts for sees them. Implementations must check
 * visibility on every call (re-reading membership); tools rely on that.
 */
export interface ChatStore {
	/** Toggles a reaction on the message this turn answers. */
	react(emoji: string): Promise<{ reacted: boolean } | { error: string }>;
	read(input: ChatReadInput): Promise<ChatResult>;
	search(input: { query: string; chat?: string }): Promise<ChatResult>;
	/** A file attached to a message in a chat they can see. */
	readFile(input: { id: string; page?: number }): Promise<FileResult>;
}

export const chatTools: ToolDef[] = [
	defineTool({
		id: "chat.react",
		title: "React",
		description: "React with one emoji to the message you're answering. The same emoji again removes it.",
		input: z.object({ emoji: z.string().min(1).max(16) }),
		// Only on the message it answers, as the agent: nothing to ask about.
		risk: "none",
		execute: ({ emoji }, { chat }) => chat.react(emoji),
	}),
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
];
