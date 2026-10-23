import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

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
}

export interface ChatReadInput {
	/** A channel name like "#sales". Omit for the place this turn is in. */
	chat?: string;
	/** A message id: read its thread. */
	threadOf?: string;
	/** ISO time: only messages before it. */
	before?: string;
	limit?: number;
}

export type ChatResult = { messages: ChatLine[] } | { error: string };

/**
 * Chats as the person the agent acts for sees them. Implementations must check
 * visibility on every call (re-reading membership); tools rely on that.
 */
export interface ChatStore {
	/** Toggles a reaction on the message this turn answers. */
	react(emoji: string): Promise<{ reacted: boolean } | { error: string }>;
	read(input: ChatReadInput): Promise<ChatResult>;
	search(input: { query: string; chat?: string }): Promise<ChatResult>;
}

export const chatTools: ToolDef[] = [
	defineTool({
		id: "chat.react",
		description: "React with one emoji to the message you're answering. The same emoji again removes it.",
		input: z.object({ emoji: z.string().min(1).max(16) }),
		execute: ({ emoji }, { chat }) => chat.react(emoji),
	}),
	defineTool({
		id: "chat.read",
		description:
			"Read chat messages, oldest first: earlier ones here, a channel (\"#sales\"), or a thread (threadOf: message id).",
		input: z.object({
			chat: z.string().optional().describe('Channel like "#sales". Omit for here.'),
			threadOf: z.string().optional().describe("Message id whose thread to read"),
			before: z.string().optional().describe("ISO time; only messages before it"),
			limit: z.number().int().min(1).max(100).optional().describe("Default 30"),
		}),
		readOnly: true,
		execute: (input, { chat }) => chat.read(input),
	}),
	defineTool({
		id: "chat.search",
		description: "Search messages in chats the person can see.",
		input: z.object({ query: z.string().min(1), chat: z.string().optional().describe('Limit to a channel like "#sales"') }),
		readOnly: true,
		returnsData: true,
		execute: (input, { chat }) => chat.search(input),
	}),
];
