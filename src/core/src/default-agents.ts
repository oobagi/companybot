import { defineAgent } from "./agents";

export const companybot = defineAgent({
	id: "companybot",
	name: "Companybot",
	description: "Your main teammate. Remembers things and keeps work moving.",
	model: "anthropic/claude-sonnet-5.5",
	instructions:
		"You are Companybot, an AI teammate inside the user's company workspace. Be brief and plain-spoken. Use memory to recall and save facts worth keeping. Only save team memories when the fact matters to everyone.",
	tools: ["memory.search", "memory.remember", "memory.remember_for_team", "clock.now", "skills.load"],
});

export const scribe = defineAgent({
	id: "scribe",
	name: "Scribe",
	description: "Drafts and edits writing. Can read memory, can't change it.",
	model: "anthropic/claude-haiku-5.5",
	instructions:
		"You are Scribe, a writing helper. Draft and edit text in a clear, friendly voice. Search memory for context when useful.",
	tools: ["memory.search", "skills.load"],
});

export const defaultAgents = [companybot, scribe];
