import { manageTools } from "./manage-tools";
import { z } from "zod";
import { automationTools } from "./automation-tools";
import { chatTools } from "./chat";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from "./skills";
import { pageTools } from "./page-tools";
import { recordTools } from "./record-tools";
import { readHelp } from "./help";
import { formatLocalTime } from "./time";
import type { MemoryScope } from "./memory";
import type { Permission } from "./permissions";
import { type ToolDef, defineTool } from "./tools";
import { imageTools } from "./image-tools";
import { webTools } from "./web";
import { widgetTools } from "./widgets";

/** "abc…": a memory as its tool line quotes it. */
const quote = (text: string) => JSON.stringify(text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text);

/**
 * Saves a memory in `scope`, for you or another agent. Its tool line quotes what was saved, so
 * a save is never silent (like Meta AI's "Memory updated"), and in a shared chat everyone sees it.
 */
const remember = (id: string, title: string, description: string, scope: MemoryScope, permission?: Permission) =>
	defineTool({
		id,
		title,
		description,
		input: z.object({ content: z.string(), agentId: z.string().optional().describe("Target agent id; defaults to you") }),
		...(permission && { permission }),
		// Only once it's saved: a refused or failed save doesn't publish what it would have said.
		label: ({ content }, output) =>
			typeof content === "string" && output && typeof output === "object" && "saved" in output
				? `Save ${scope === "personal" ? "a personal memory" : "to team memory"}: ${quote(content)}`
				: undefined,
		async execute({ content, agentId }, { memory }) {
			const saved = await memory.create({ scope, content, ...(agentId && { agentId }) });
			return { saved: saved.id };
		},
	});

/**
 * Tools every workspace has. Not connectors: no outside service involved.
 * Memory tools go through ctx.memory, which enforces memory permissions, so a
 * tool never needs its own permission check.
 */
export const builtinTools: ToolDef[] = [
	defineTool({
		id: "memory.search",
		title: "Search memory",
		description: "Search memories the current person can see; optionally target another workspace agent by agentId. Empty query lists all.",
		input: z.object({ query: z.string().describe("Words to match; empty for all"), agentId: z.string().optional() }),
		readOnly: true,
		// Includes the person's personal memories.
		risk: "inside",
		returnsData: true,
		async execute({ query, agentId }, { memory }) {
			return (await memory.search(query, agentId)).map(({ id, scope, content }) => ({ id, scope, content }));
		},
	}),
	remember("memory.remember", "Remember", "Save a personal memory for the current person only: a fact about them or what they prefer, from what they said themselves.", "personal"),
	remember("memory.remember_for_team", "Remember for the team", "Save a memory the whole workspace can see.", "workspace", "memory.team.write"),
	defineTool({
		id: "memory.update",
		title: "Update a memory",
		description: "Correct any accessible memory found with memory_search, including another agent's. Replaces its content.",
		input: z.object({ id: z.string(), content: z.string() }),
		async execute({ id, content }, { memory }) {
			const saved = await memory.update(id, content);
			return { updated: saved.id };
		},
	}),
	defineTool({
		id: "memory.forget",
		title: "Forget a memory",
		description: "Delete any accessible memory found with memory_search, when it's wrong or the person asks you to forget it.",
		input: z.object({ id: z.string() }),
		async execute({ id }, { memory }) {
			await memory.remove(id);
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
		id: "help.read",
		title: "Read help",
		description:
			"Read Companybot's help for people: what it is, where each setting lives, how to do things. No arguments lists the topics. topic reads one page. query searches by keywords. Pages link screens as #/settings/<tab>; pass those links on to the person.",
		input: z.object({
			topic: z.string().optional().describe("A topic id from the list"),
			query: z.string().optional().describe("Keywords, like \"invite someone\""),
		}),
		readOnly: true,
		async execute(input) {
			return readHelp(input);
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
		// Every agent here reads skills, so a new one is checked by a person first.
		risk: "outside",
		execute: (input, { skills }) => skills.create(input),
	}),
	...manageTools,
	...widgetTools,
	...chatTools,
	...automationTools,
	...recordTools,
	...pageTools,
	...webTools,
	...imageTools,
];
