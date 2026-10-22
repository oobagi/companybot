import { z } from "zod";
import { defineAgent } from "./agents";
import { definePlugin, defineTool } from "./plugins";

export const memoryPlugin = definePlugin({
	id: "memory",
	name: "Memory",
	description: "Search and save what the workspace should remember.",
	version: "0.1.0",
	connection: { kind: "none" },
	tools: [
		defineTool({
			name: "search",
			description: "Search memories visible to the current person. Empty query lists all.",
			input: z.object({ query: z.string().describe("Words to match; empty for all") }),
			async execute({ query }, { actor, memory }) {
				const q = query.trim().toLowerCase();
				const all = await memory.list(actor);
				return all
					.filter((m) => !q || m.content.toLowerCase().includes(q))
					.map(({ id, scope, content }) => ({ id, scope, content }));
			},
		}),
		defineTool({
			name: "remember",
			description: "Save a personal memory for the current person only.",
			input: z.object({ content: z.string() }),
			async execute({ content }, { actor, memory }) {
				const saved = await memory.create(actor, { scope: "personal", content });
				return { saved: saved.id };
			},
		}),
		defineTool({
			name: "remember_for_team",
			description: "Save a memory the whole workspace can see.",
			input: z.object({ content: z.string() }),
			roles: ["owner"],
			async execute({ content }, { actor, memory }) {
				const saved = await memory.create(actor, { scope: "workspace", content });
				return { saved: saved.id };
			},
		}),
	],
});

export const clockPlugin = definePlugin({
	id: "clock",
	name: "Clock",
	description: "Tells agents the current date and time.",
	version: "0.1.0",
	connection: { kind: "none" },
	tools: [
		defineTool({
			name: "now",
			description: "Get the current date and time (ISO 8601, UTC).",
			input: z.object({}),
			async execute() {
				return { now: new Date().toISOString() };
			},
		}),
	],
});

export const builtinPlugins = [memoryPlugin, clockPlugin];

export const companybot = defineAgent({
	id: "companybot",
	name: "Companybot",
	description: "Your main teammate. Remembers things and keeps work moving.",
	model: "anthropic/claude-sonnet-5.5",
	instructions:
		"You are Companybot, an AI teammate inside the user's company workspace. Be brief and plain-spoken. Use memory to recall and save facts worth keeping. Only save team memories when the fact matters to everyone.",
	tools: ["memory.search", "memory.remember", "memory.remember_for_team", "clock.now"],
});

export const scribe = defineAgent({
	id: "scribe",
	name: "Scribe",
	description: "Drafts and edits writing. Can read memory, can't change it.",
	model: "anthropic/claude-haiku-5.5",
	instructions:
		"You are Scribe, a writing helper. Draft and edit text in a clear, friendly voice. Search memory for context when useful.",
	tools: ["memory.search"],
});

export const defaultAgents = [companybot, scribe];
