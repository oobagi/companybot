import { z } from "zod";
import { chatTools } from "./chat";
import { type ToolDef, defineTool } from "./tools";
import { widgetTools } from "./widgets";

/**
 * Tools every workspace has. Not plugins: no outside service involved.
 * Memory tools go through ctx.memory, which enforces memory permissions, so a
 * tool never needs its own permission check.
 */
export const builtinTools: ToolDef[] = [
	defineTool({
		id: "memory.search",
		description: "Search your memories that the current person can see. Empty query lists all.",
		input: z.object({ query: z.string().describe("Words to match; empty for all") }),
		readOnly: true,
		returnsData: true,
		async execute({ query }, { actor, memory }) {
			const words = query.toLowerCase().split(/\s+/).filter(Boolean);
			const all = await memory.list(actor);
			return all
				.filter((m) => words.every((w) => m.content.toLowerCase().includes(w)))
				.map(({ id, scope, content }) => ({ id, scope, content }));
		},
	}),
	defineTool({
		id: "memory.remember",
		description: "Save a personal memory for the current person only.",
		input: z.object({ content: z.string() }),
		async execute({ content }, { actor, memory }) {
			const saved = await memory.create(actor, { scope: "personal", content });
			return { saved: saved.id };
		},
	}),
	defineTool({
		id: "memory.remember_for_team",
		description: "Save a memory the whole workspace can see.",
		input: z.object({ content: z.string() }),
		roles: ["owner"],
		async execute({ content }, { actor, memory }) {
			const saved = await memory.create(actor, { scope: "workspace", content });
			return { saved: saved.id };
		},
	}),
	defineTool({
		id: "memory.update",
		description: "Correct a memory you found with memory_search. Replaces its content.",
		input: z.object({ id: z.string(), content: z.string() }),
		async execute({ id, content }, { actor, memory }) {
			const saved = await memory.update(actor, id, content);
			return { updated: saved.id };
		},
	}),
	defineTool({
		id: "memory.forget",
		description: "Delete a memory you found with memory_search, when it's wrong or the person asks you to forget it.",
		input: z.object({ id: z.string() }),
		async execute({ id }, { actor, memory }) {
			await memory.remove(actor, id);
			return { forgotten: id };
		},
	}),
	defineTool({
		id: "clock.now",
		description: "Get the current date and time (ISO 8601, UTC).",
		input: z.object({}),
		readOnly: true,
		async execute() {
			return { now: new Date().toISOString() };
		},
	}),
	defineTool({
		id: "skills.load",
		description: "Load an installed skill's full instructions by id.",
		input: z.object({ id: z.string() }),
		readOnly: true,
		async execute({ id }, { skills }) {
			const skill = skills.find((s) => s.id === id);
			return skill ? { instructions: skill.instructions } : { error: `No installed skill "${id}".` };
		},
	}),
	...widgetTools,
	...chatTools,
];
