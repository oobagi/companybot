import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { INBOX_TEXT_MAX } from "./inbox";
import type { PublicAbility } from "./public-role";

// The only tools an agent has while it answers someone outside the workspace (Inbox, backend
// inboxAgent.ts). They come from the Public role's abilities and nothing else: no built-in, connector or
// skill tool is ever in this set, whatever the agent is granted in chat.

export const publicToolNames = ["reply", "take_message", "hand_off"] as const;
export type PublicToolName = (typeof publicToolNames)[number];

/** The ability each tool needs. Replying always works: without `public.reply` the reply waits for staff. */
export const publicToolNeeds: Record<PublicToolName, PublicAbility | null> = {
	reply: null,
	take_message: "public.message",
	hand_off: "public.handoff",
};

/** Runs one call (the backend rechecks the ability and the conversation when it does) and says what happened. */
export type PublicAct = (name: PublicToolName, input: { text: string }) => Promise<string>;

/** The tools for one reply to an outsider, from what Public may do now. */
export function publicTools(abilities: readonly PublicAbility[], act: PublicAct): ToolSet {
	const all: Record<PublicToolName, ToolSet[string]> = {
		reply: tool({
			description: abilities.includes("public.reply") ? "Send your reply to the customer. It goes out at once." : "Write your reply to the customer. Someone on staff checks it, then sends it.",
			inputSchema: z.object({ text: z.string().min(1).max(INBOX_TEXT_MAX).describe("The whole reply, ready to send") }),
			execute: ({ text }) => act("reply", { text }),
		}),
		take_message: tool({
			description: "Leave a note for staff on this conversation: who they are, what they want, how to reach them. The customer never sees it.",
			inputSchema: z.object({ text: z.string().min(1).max(2_000).describe("The message for staff") }),
			execute: ({ text }) => act("take_message", { text }),
		}),
		hand_off: tool({
			description: "Pass this conversation to staff. You stop replying to it until someone hands it back.",
			inputSchema: z.object({ text: z.string().min(1).max(500).describe("Why someone on staff should take it, in a sentence") }),
			execute: ({ text }) => act("hand_off", { text }),
		}),
	};
	return Object.fromEntries(publicToolNames.filter((n) => !publicToolNeeds[n] || abilities.includes(publicToolNeeds[n])).map((n) => [n, all[n]]));
}
