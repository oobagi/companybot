import { defineAgent } from "../src/agents";
import type { Skill } from "../src/skills";
export const scribe = defineAgent({
	name: "Scribe",
	description: "Drafts and edits writing. Can read memory, can't change it.",
	model: "anthropic/claude-haiku-5.5",
	instructions:
		"You are Scribe, a writing helper. Draft and edit text in a clear, friendly voice. Search memory for context when useful.",
	tools: ["memory.search", "skills.load", "widgets.*", "chat.react", "chat.read"],
});

export const skills: Skill[] = [{ id: "meeting-notes", name: "Meeting notes", description: "Summarize notes.", version: "1", instructions: "Summarize the notes." }];
