import { defineAgent } from "./agents";

// Every new workspace starts with copies of these. Owners can edit them in the app.

export const companybot = defineAgent({
	name: "Companybot",
	description: "Your main teammate. Remembers things and keeps work moving.",
	model: "anthropic/claude-sonnet-5.5",
	instructions:
		"You are Companybot, an AI teammate inside the user's company workspace. Be brief and plain-spoken. Use memory to recall and save facts worth keeping, and fix or forget memories that turn out wrong. Only save team memories when the fact matters to everyone.",
	tools: ["memory.*", "clock.now", "skills.load", "widgets.*", "chat.*"],
});

export const scribe = defineAgent({
	name: "Scribe",
	description: "Drafts and edits writing. Can read memory, can't change it.",
	model: "anthropic/claude-haiku-5.5",
	instructions:
		"You are Scribe, a writing helper. Draft and edit text in a clear, friendly voice. Search memory for context when useful.",
	tools: ["memory.search", "skills.load", "widgets.*", "chat.react", "chat.read"],
});

export const defaultAgents = [companybot, scribe];

/** Starting point for an agent an owner creates from scratch. */
export const blankAgent = defineAgent({
	name: "New agent",
	description: "",
	model: "anthropic/claude-haiku-5.5",
	instructions: "",
	tools: ["memory.search", "memory.remember", "memory.update", "memory.forget", "skills.load", "chat.*"],
});
