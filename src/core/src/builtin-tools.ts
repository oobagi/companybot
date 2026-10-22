import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/** Tools every workspace has. Not plugins: no outside service involved. */
export const builtinTools: ToolDef[] = [
	defineTool({
		id: "memory.search",
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
		id: "clock.now",
		description: "Get the current date and time (ISO 8601, UTC).",
		input: z.object({}),
		async execute() {
			return { now: new Date().toISOString() };
		},
	}),
	defineTool({
		id: "skills.load",
		description: "Load an installed skill's full instructions by id.",
		input: z.object({ id: z.string() }),
		async execute({ id }, { skills }) {
			const skill = skills.find((s) => s.id === id);
			return skill ? { instructions: skill.instructions } : { error: `No installed skill "${id}".` };
		},
	}),
];
