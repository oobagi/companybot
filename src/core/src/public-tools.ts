import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { INBOX_TEXT_MAX } from "./inbox";
import type { PublicAbility } from "./public-role";

// The only tools an agent has while it answers someone outside the workspace (Inbox, backend
// inboxAgent.ts). No built-in, connector or skill tool is ever in this set, whatever the agent is
// granted in chat. Two kinds:
// - Conversation tools, from Public's abilities (public-role.ts): reply, take a message, hand off.
// - Data tools, from what owners shared with Public in pages' and databases' Who can access lists
//   (backend publicPlaces.ts): read shared pages and records, and add records where Public has Add.
//   They're offered only when something is shared, and every call is checked against the lists again.

export const conversationTools = ["reply", "take_message", "hand_off"] as const;
export type ConversationTool = (typeof conversationTools)[number];

/** The ability each conversation tool needs. Replying always works: without `public.reply` the reply waits for staff. */
export const publicToolNeeds: Record<ConversationTool, PublicAbility | null> = {
	reply: null,
	take_message: "public.message",
	hand_off: "public.handoff",
};

/** What's shared with Public, so a reply gets only the data tools it can use. */
export interface PublicShared {
	/** Some page is shared at View. */
	pages: boolean;
	/** Some database is shared at View. */
	view: boolean;
	/** Some database is shared at Add. */
	add: boolean;
}

export const NOTHING_SHARED: PublicShared = { pages: false, view: false, add: false };

/** Runs each call (the backend rechecks the conversation, the ability and the lists when it does) and says what happened. */
export interface PublicActs {
	act(name: ConversationTool, input: { text: string }): Promise<string>;
	shared(input: { search?: string }): Promise<unknown>;
	readPage(input: { page: string; start?: number }): Promise<unknown>;
	findRecords(input: { database: string; search?: string; cursor?: string }): Promise<unknown>;
	saveRecord(input: { database?: string; record?: string; values?: Record<string, unknown>; cancel?: boolean }): Promise<unknown>;
}

const value = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** The tools for one reply to an outsider, from what Public may do now. */
export function publicTools(abilities: readonly PublicAbility[], shared: PublicShared, acts: PublicActs): ToolSet {
	const tools: ToolSet = {
		reply: tool({
			description: abilities.includes("public.reply") ? "Send your reply to the customer. It goes out at once." : "Write your reply to the customer. Someone on staff checks it, then sends it.",
			inputSchema: z.object({ text: z.string().min(1).max(INBOX_TEXT_MAX).describe("The whole reply, ready to send") }),
			execute: ({ text }) => acts.act("reply", { text }),
		}),
	};
	if (abilities.includes("public.message"))
		tools.take_message = tool({
			description: "Leave a note for staff on this conversation: who they are, what they want, how to reach them. The customer never sees it.",
			inputSchema: z.object({ text: z.string().min(1).max(2_000).describe("The message for staff") }),
			execute: ({ text }) => acts.act("take_message", { text }),
		});
	if (abilities.includes("public.handoff"))
		tools.hand_off = tool({
			description: "Pass this conversation to staff. You stop replying to it until someone hands it back.",
			inputSchema: z.object({ text: z.string().min(1).max(500).describe("Why someone on staff should take it, in a sentence") }),
			execute: ({ text }) => acts.act("hand_off", { text }),
		});
	if (!shared.pages && !shared.view && !shared.add) return tools;
	tools.shared = tool({
		description: "What the business shares with customers: pages you can read (by title, or matching search) and databases, with their fields and what you may do in each.",
		inputSchema: z.object({ search: z.string().max(200).optional().describe("Words in a page's title") }),
		execute: (input) => acts.shared(input),
	});
	if (shared.pages)
		tools.read_page = tool({
			description: "Read a shared page (an id from shared) as Markdown, 20,000 characters at a time (more and next: call again with start). Its shared sub-pages are listed.",
			inputSchema: z.object({ page: z.string().describe("The page's id"), start: z.number().int().min(0).optional() }),
			execute: (input) => acts.readPage(input),
		});
	if (shared.view || shared.add)
		tools.find_records = tool({
			description: "List records in a shared database, newest first, or search it. Where you may only add, it lists only this customer's own records.",
			inputSchema: z.object({ database: z.string().describe("Its key, from shared"), search: z.string().max(200).optional(), cursor: z.string().optional() }),
			execute: (input) => acts.findRecords(input),
		});
	if (shared.add)
		tools.save_record = tool({
			description:
				"Where shared lets you add: add a record for this customer (database and values), change one of theirs (record and values; null clears), or cancel one of theirs (record and cancel: true). Only with what they told you, and only when they asked. Never anyone else's.",
			inputSchema: z.object({
				database: z.string().optional().describe("Its key, from shared, to add a record"),
				record: z.string().optional().describe("One of this customer's records' ids, from find_records, to change or cancel"),
				values: z.record(z.string(), value.nullable()).optional().describe("Field key or label → value, as people write it; choices by label"),
				cancel: z.boolean().optional(),
			}),
			execute: (input) => acts.saveRecord(input),
		});
	return tools;
}
