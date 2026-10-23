/**
 * An automation is a short, ready-made job: a trigger (a schedule or an event) that
 * sends an agent a prompt. The agent replies in its chat with each person the
 * automation runs for, with that person's permissions, as if they'd asked.
 *
 * Lifecycle: an owner installs it → picks the agent → it runs on its trigger until
 * turned off. Schedules run for every member; events run for the person they're about.
 */
export interface Automation {
	id: string;
	name: string;
	/** One line for the library. */
	description: string;
	/** What it does, in more depth, for its detail page. Markdown. */
	details: string;
	version: string;
	publisher: string;
	trigger: AutomationTrigger;
	/** Plugins that must be installed first, and that the agent should be granted. */
	plugins: string[];
	/** What the agent is asked to do each run. */
	prompt: string;
}

export type AutomationTrigger =
	/** Local time in the workspace's time zone. Weekdays: 0 = Sunday. */
	| { type: "schedule"; time: string; weekdays: number[] }
	/** Fired by the backend when the event happens (see automations.fire). */
	| { type: "event"; event: AutomationEvent; label: string };

export type AutomationEvent = "call.ended";

export const defineAutomation = (automation: Automation) => automation;

/** The automations library. */
export const automationCatalog: Automation[] = [
	defineAutomation({
		id: "morning-brief",
		name: "Morning brief",
		description: "Every weekday at 8am, each person gets their day at a glance.",
		details: `Each weekday morning the agent messages every member with:
- **Today** — meetings and deadlines it knows about.
- **Open tasks** — follow-ups and action items still waiting on them.
- **Overnight** — anything that changed since yesterday.

It uses the agent's memory and whatever plugins the agent is granted, so it gets better as you connect more.`,
		version: "0.1.0",
		publisher: "Companybot",
		trigger: { type: "schedule", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
		plugins: [],
		prompt: `Morning brief. Give me my day at a glance, in this order:
1. **Today** — meetings, deadlines, and anything time-sensitive.
2. **Open tasks** — follow-ups and action items still waiting on me.
3. **Overnight** — what changed since yesterday.
Use your memory and any tools you have. Skip a section if there's nothing for it. Keep it short.`,
	}),
	defineAutomation({
		id: "after-call-summary",
		name: "After-call summary",
		description: "When a call ends, get a summary with next steps and action items.",
		details: `After each call, the agent pulls the call from Night Owl and messages the person who took it with:
- **Summary** — two or three sentences.
- **Next steps** — what was agreed.
- **Action items** — who does what, by when.

Needs the Night Owl plugin installed and connected, and the agent granted Night Owl.`,
		version: "0.1.0",
		publisher: "Companybot",
		trigger: { type: "event", event: "call.ended", label: "When a call ends in Night Owl" },
		plugins: ["night-owl"],
		prompt: `A call just ended. Find my most recent finished call in Night Owl and write:
1. **Summary** — two or three sentences.
2. **Next steps** — what was agreed.
3. **Action items** — "- [ ] Owner: task (due date if mentioned)".
Don't invent owners or dates. If you can't reach Night Owl, say so in one line.`,
	}),
];

export const findAutomation = (id: string) => automationCatalog.find((a) => a.id === id);

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Weekdays at 8:00 AM", "When a call ends in Night Owl". */
export function describeTrigger(trigger: AutomationTrigger): string {
	if (trigger.type === "event") return trigger.label;
	const [h, m] = trigger.time.split(":").map(Number) as [number, number];
	const time = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
	const days = [...trigger.weekdays].sort().join();
	const when =
		days === "1,2,3,4,5" ? "Weekdays" : days === "0,1,2,3,4,5,6" ? "Every day" : trigger.weekdays.map((d) => dayNames[d]).join(", ");
	return `${when} at ${time}`;
}

/** The date ("2026-10-22"), weekday, and "HH:MM" time it is now in a time zone. */
export function localTime(now: number, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(now)
			.map((p) => [p.type, p.value]),
	);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		weekday: dayNames.indexOf(parts.weekday!),
		time: `${parts.hour}:${parts.minute}`,
	};
}

/**
 * The local date a schedule is due for right now, or null. Due once per day, any
 * time after its start time, so a late check still runs it; `lastRunDate` stops repeats.
 */
export function scheduleDue(
	trigger: AutomationTrigger,
	now: number,
	timeZone: string,
	lastRunDate: string | undefined,
): string | null {
	if (trigger.type !== "schedule") return null;
	const local = localTime(now, timeZone);
	if (!trigger.weekdays.includes(local.weekday)) return null;
	if (local.time < trigger.time || local.date === lastRunDate) return null;
	return local.date;
}

export const isValidTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
};
