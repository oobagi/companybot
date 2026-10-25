import { z } from "zod";
import { automationTools } from "./automation-tools";
import { chatTools } from "./chat";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from "./skills";
import { recordTools } from "./record-tools";
import { formatLocalTime } from "./time";
import { type ToolDef, defineTool } from "./tools";
import { widgetTools } from "./widgets";

/**
 * Tools every workspace has. Not connectors: no outside service involved.
 * Memory tools go through ctx.memory, which enforces memory permissions, so a
 * tool never needs its own permission check.
 */
export const builtinTools: ToolDef[] = [
	defineTool({
		id: "memory.search",
		title: "Search memory",
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
		title: "Remember",
		description: "Save a personal memory for the current person only.",
		input: z.object({ content: z.string() }),
		async execute({ content }, { actor, memory }) {
			const saved = await memory.create(actor, { scope: "personal", content });
			return { saved: saved.id };
		},
	}),
	defineTool({
		id: "memory.remember_for_team",
		title: "Remember for the team",
		description: "Save a memory the whole workspace can see.",
		input: z.object({ content: z.string() }),
		permission: "memory.team.write",
		async execute({ content }, { actor, memory }) {
			const saved = await memory.create(actor, { scope: "workspace", content });
			return { saved: saved.id };
		},
	}),
	defineTool({
		id: "memory.update",
		title: "Update a memory",
		description: "Correct a memory you found with memory_search. Replaces its content.",
		input: z.object({ id: z.string(), content: z.string() }),
		async execute({ id, content }, { actor, memory }) {
			const saved = await memory.update(actor, id, content);
			return { updated: saved.id };
		},
	}),
	defineTool({
		id: "memory.forget",
		title: "Forget a memory",
		description: "Delete a memory you found with memory_search, when it's wrong or the person asks you to forget it.",
		input: z.object({ id: z.string() }),
		async execute({ id }, { actor, memory }) {
			await memory.remove(actor, id);
			return { forgotten: id };
		},
	}),
	defineTool({
		id: "clock.now",
		title: "Check the time",
		description: "Get the current date and time, in the person's time zone and as ISO 8601 UTC.",
		input: z.object({}),
		readOnly: true,
		async execute(_input, { timeZone = "UTC" }) {
			const now = new Date();
			return { local: formatLocalTime(now, timeZone), timeZone, utc: now.toISOString() };
		},
	}),
	defineTool({
		id: "skills.load",
		title: "Load a skill",
		description: "Load an installed skill's full instructions by id.",
		input: z.object({ id: z.string() }),
		readOnly: true,
		async execute({ id }, { skills }) {
			const skill = skills.list.find((s) => s.id === id);
			return skill ? { instructions: skill.instructions } : { error: `No installed skill "${id}".` };
		},
	}),
	defineTool({
		id: "skills.create",
		title: "Create a skill",
		description:
			"Save a skill for the whole team: instructions any agent here loads when a task calls for it. Only after the person confirmed the name, description, and instructions you showed them.",
		input: z.object({
			name: z.string().describe(`Short display name, under ${SKILL_NAME_MAX} characters`),
			description: z
				.string()
				.describe(`What it does and when to use it, in one line under ${SKILL_DESCRIPTION_MAX} characters. Agents see only this until they load it.`),
			instructions: z.string().describe("The steps, rules, and examples, in Markdown, written to an agent"),
		}),
		execute: (input, { skills }) => skills.create(input),
	}),
	...widgetTools,
	...chatTools,
	...automationTools,
	...recordTools,
];
