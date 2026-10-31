import { z } from "zod";
import { CUSTOM_NAME_MAX, CUSTOM_PROMPT_MAX } from "./automations";
import { MIN_SCHEDULE_MINUTES } from "./schedules";
import { type ToolDef, defineTool } from "./tools";

/**
 * Agents set up automations for the person they're helping, in chat: "every Monday,
 * send me a summary of recent conversations". The backend applies the same rules as the app
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

/** How agents write schedules; also the automations_create and automations_manage schema text. */
export const cronHelp = `Standard 5-part cron, "minute hour day-of-month month day-of-week", in the person's time zone (days: 0 = Sunday). Examples: "0 9 * * 1-5" weekdays at 9:00 AM; "0 9,16 * * 1-5" weekdays at 9:00 AM and 4:00 PM; "30 8 * * *" every day at 8:30 AM; "0 8-18/2 * * 1-5" every 2 hours from 8 AM to 6 PM on weekdays; "0 9 * * 1" Mondays at 9; "0 9 1 * *" the 1st of each month; "0 9 * * 1#1" the first Monday of the month; "0 17 * * 5L" the last Friday. Several times a day share their minutes ("0 9,13"); times with different minutes need two automations. At most every ${MIN_SCHEDULE_MINUTES} minutes.`;

const toolInput = z.object({
	name: z.string().max(CUSTOM_NAME_MAX).describe("Short name, e.g. \"Monday team update\""),
	prompt: z
		.string()
		.max(CUSTOM_PROMPT_MAX)
		.describe("What the agent is asked each run, written as the person asking, e.g. \"Summarize recent conversations and highlight follow-ups.\""),
	trigger: z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("schedule"), cron: z.string().describe(cronHelp) }),
			z.object({ type: z.literal("message_posted"), channel: z.string().describe('Channel to watch, like "#support"') }),
			z.object({ type: z.literal("member_joined") }),
			z.object({ type: z.literal("webhook").describe("Only when the person has an outside app that will send it") }),
		])
		.describe("When it runs"),
	runsFor: z
		.string()
		.optional()
		.describe('"me" (just the person; default), "anyone" (each person who turns it on), or a channel like "#sales" to post there'),
});
export type AutomationToolInput = z.infer<typeof toolInput>;

export const automationTools: ToolDef[] = [
	defineTool({
		id: "automations.list",
		title: "List automations",
		description: "List the automations the person can see: theirs, the team's, and installed library ones, with whether each is on for them.",
		input: z.object({}),
		readOnly: true,
		returnsData: true,
		execute: (_input, { automations }) => automations.list(),
	}),
	defineTool({
		id: "automations.create",
		title: "Create an automation",
		description:
			"Set up an automation for the person: a trigger, a prompt you run each time, and who it runs for. Schedules are cron, so any regular timing works: several times a day, every few hours during work hours, chosen weekdays, a day of the month, the first Monday. The reply's `when` says it in words; tell them that. Only after they've confirmed the summary you showed them.",
		input: toolInput,
		execute: (input, { automations }) => automations.create(input),
	}),
	defineTool({
		id: "automations.set_mine",
		title: "Turn an automation on or off",
		description: 'Turn an automation on or off for the person. Only works on ones that run for "anyone who turns it on".',
		input: z.object({ id: z.string().describe("From automations_list"), on: z.boolean() }),
		execute: (input, { automations }) => automations.setMine(input),
	}),
];
