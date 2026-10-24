import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/**
 * Agents set up automations for the person they're helping, in chat: "every Monday,
 * send me deals that went quiet". The backend applies the same rules as the app
 * (anyone can make their own; changing others' needs `automations.manage`).
 */
export interface AutomationStore {
	list(): Promise<AutomationSummary[]>;
	create(input: AutomationToolInput): Promise<{ created: string; name: string; when: string; runsFor: string; webhookUrl?: string } | { error: string }>;
	/** Turns an automation on or off for the person (ones that run for whoever turns them on). */
	setMine(input: { id: string; on: boolean }): Promise<{ id: string; on: boolean } | { error: string }>;
}

export interface AutomationSummary {
	id: string;
	name: string;
	when: string;
	runsFor: string;
	/** Whether it's on for the person, when it's one people turn on. */
	onForYou: boolean | null;
	madeByYou: boolean;
}

const day = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
export const weekdayIndex = (d: z.infer<typeof day>) => day.options.indexOf(d);

const toolInput = z.object({
	name: z.string().describe("Short name, e.g. \"Monday pipeline review\""),
	prompt: z
		.string()
		.describe("What the agent is asked each run, written as the person asking, e.g. \"List deals that haven't moved in two weeks.\""),
	trigger: z
		.discriminatedUnion("type", [
			z.object({
				type: z.literal("schedule"),
				time: z.string().describe('24-hour "HH:MM" in the person\'s time zone'),
				days: z.array(day).min(1),
			}),
			z.object({ type: z.literal("message_posted"), channel: z.string().describe('Channel to watch, like "#support"') }),
			z.object({ type: z.literal("member_joined") }),
			z.object({ type: z.literal("webhook").describe("Only when the person has an outside app that will send it") }),
		])
		.describe("When it runs"),
	runsFor: z
		.string()
		.describe('"me" (just the person; default), "anyone" (each person who turns it on), or a channel like "#sales" to post there'),
});
export type AutomationToolInput = z.infer<typeof toolInput>;

export const automationTools: ToolDef[] = [
	defineTool({
		id: "automations.list",
		description: "List the automations the person can see: theirs, the team's, and installed library ones, with whether each is on for them.",
		input: z.object({}),
		readOnly: true,
		returnsData: true,
		execute: (_input, { automations }) => automations.list(),
	}),
	defineTool({
		id: "automations.create",
		description:
			"Set up an automation for the person: a trigger, a prompt you run each time, and who it runs for. Only after they've confirmed the summary you showed them.",
		input: toolInput,
		execute: (input, { automations }) => automations.create(input),
	}),
	defineTool({
		id: "automations.set_mine",
		description: 'Turn an automation on or off for the person. Only works on ones that run for "anyone who turns it on".',
		input: z.object({ id: z.string().describe("From automations_list"), on: z.boolean() }),
		execute: (input, { automations }) => automations.setMine(input),
	}),
];
