import { z } from "zod";
import { type ToolDef, defineTool, resultText } from "./tools";

/**
 * Wakeups: an agent wakes later in a place, acting for the same person (backend wakeups.ts).
 * One system: when (a time, once or repeating, or a job finishing, #114) plus what (a note: a
 * follow-up the agent set, "chase Acme's invoice in 3 days if it's unpaid"; no note: look around,
 * #162's heartbeat). The agent checks when it wakes whether there's anything to do, so there's
 * no condition to set up. A wake turn is quiet: nothing it writes shows unless it calls `chat.notify`.
 */

/** How one wake went, for its line in Activity: queued a turn, skipped (and why), finished quietly, spoke up, or failed. */
export const wakeOutcomes = ["fired", "skipped", "ran", "notified", "failed"] as const;
export type WakeOutcome = (typeof wakeOutcomes)[number];

export interface WakeupStore {
	create(input: FollowupInput): Promise<{ created: string; when: string; record?: string } | { error: string }>;
	list(input: { recordId?: string }): Promise<{ followups: FollowupSummary[] } | { error: string }>;
	cancel(input: { id: string }): Promise<{ cancelled: string } | { error: string }>;
	/** Posts in the wake turn's place, as the agent. Only in a wake turn. */
	notify(input: { text: string }): Promise<{ posted: true } | { error: string }>;
}

/** Messages one wake turn can post with chat.notify. */
export const NOTIFY_MAX = 3;
export const NOTIFY_TEXT_MAX = 4000;

export interface FollowupSummary {
	id: string;
	/** In the person's time zone: "Thu, Apr 1, 2027, 9:00 AM PDT". */
	when: string;
	/** None: a check-in that looks around. */
	note?: string;
	agent: string;
	/** Who it runs for. */
	for: string;
	record?: string;
}

/** Soonest and latest a follow-up can be set for. */
export const FOLLOWUP_MIN_MS = 60_000;
export const FOLLOWUP_MAX_DAYS = 731;
export const FOLLOWUP_NOTE_MAX = 1000;
/** Pending follow-ups one record, or one agent across the workspace, can have. */
export const FOLLOWUPS_PER_RECORD = 10;
export const FOLLOWUPS_PER_AGENT = 200;
/** A repeating follow-up: at most this often, and this many wakes. */
export const REPEAT_MIN_MS = 60 * 60_000;
export const REPEAT_TIMES_MAX = 100;

const units: Record<string, "minute" | "hour" | "day" | "week" | "month" | "year"> = {
	m: "minute", min: "minute", mins: "minute", minute: "minute", minutes: "minute",
	h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
	d: "day", day: "day", days: "day",
	w: "week", wk: "week", wks: "week", week: "week", weeks: "week",
	mo: "month", month: "month", months: "month",
	y: "year", yr: "year", yrs: "year", year: "year", years: "year",
};

/** The time `when` names, after `now`, or a one-line reason it can't be used. */
export function followupTime(when: { at?: string; in?: string }, now: number, timeZone: string): number | string {
	if ((when.at === undefined) === (when.in === undefined)) return 'Give either "at" or "in".';
	const time = when.in !== undefined ? afterInterval(when.in, now, timeZone) : atTime(when.at!, timeZone);
	if (typeof time === "string") return time;
	if (time < now + FOLLOWUP_MIN_MS) return "Pick a time at least a minute from now.";
	if (time > now + FOLLOWUP_MAX_DAYS * 86_400_000) return "Pick a time within 2 years.";
	return time;
}

/** "3 days", "an hour", "2 hours 30 minutes", "5 months" as amounts of each unit, or a reason. */
function intervalParts(text: string) {
	// "a"/"an" only as a word, so "and" isn't "an d(ay)".
	const pair = /\b(\d+|an?(?=\s))\s*([a-z]+)\b/g;
	const pairs = [...text.toLowerCase().matchAll(pair)];
	const leftover = text.toLowerCase().replace(pair, "").replace(/\band\b|[\s,]/g, "");
	if (pairs.length === 0 || leftover) return `Couldn't read "${text}". Use something like "3 days" or "2 hours".`;
	const add = { minute: 0, hour: 0, day: 0, month: 0 };
	for (const [, count, word] of pairs) {
		const unit = units[word!];
		if (!unit) return `Couldn't read "${text}". Use minutes, hours, days, weeks, months or years.`;
		const n = count === "a" || count === "an" ? 1 : Number(count);
		if (unit === "week") add.day += 7 * n;
		else if (unit === "year") add.month += 12 * n;
		else add[unit] += n;
	}
	return add;
}

/** "3 days", "5 months" from `now`: calendar units keep the local time of day. */
function afterInterval(text: string, now: number, timeZone: string): number | string {
	const add = intervalParts(text);
	if (typeof add === "string") return add;
	let time = now;
	if (add.day || add.month) {
		const p = localParts(now, timeZone);
		const month = p.month - 1 + add.month;
		const year = p.year + Math.floor(month / 12);
		const inMonth = ((month % 12) + 12) % 12;
		// Jan 31 + 1 month is the last day of February, not March 3.
		const day = Math.min(p.day, daysIn(year, inMonth));
		time = zonedTime(year, inMonth + 1, day + add.day, p.hour, p.minute, timeZone);
	}
	return time + (add.hour * 60 + add.minute) * 60_000;
}

/** "2027-04-01" (9:00 in the morning), "2027-04-01 14:30" or "2027-04-01T14:30" in `timeZone`, or an ISO time with its own offset. */
function atTime(text: string, timeZone: string): number | string {
	const local = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/);
	if (local) {
		const [, y, mo, d, h = "9", mi = "0"] = local;
		return zonedTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), timeZone);
	}
	const parsed = /\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:?\d{2})$/.test(text.trim()) ? Date.parse(text) : Number.NaN;
	return Number.isNaN(parsed) ? `Couldn't read "${text}". Use "YYYY-MM-DD" or "YYYY-MM-DD HH:MM".` : parsed;
}

const DAY_MS = 86_400_000;

/** How often a follow-up repeats ("1 week", "2 days", "6 hours"), in ms, or a reason. Months vary, so they're refused. */
export function repeatEvery(text: string): number | string {
	const add = intervalParts(text);
	if (typeof add === "string") return add;
	if (add.month) return 'Repeat in days or weeks: "4 weeks" for about a month.';
	const every = add.day * DAY_MS + (add.hour * 60 + add.minute) * 60_000;
	if (every < REPEAT_MIN_MS) return "Repeat at most once an hour.";
	return every;
}

/**
 * The next time after `now` for a wakeup that started at `at` and repeats `every` ms, skipping
 * missed ones. Whole days step in `timeZone`'s calendar, so "every Monday at 9" stays at 9 across
 * clock changes.
 */
export function nextRepeat(at: number, every: number, now: number, timeZone: string) {
	const steps = Math.max(Math.floor((now - at) / every) + 1, 1);
	if (every % DAY_MS !== 0) return at + steps * every;
	const p = localParts(at, timeZone);
	const next = zonedTime(p.year, p.month, p.day + steps * (every / DAY_MS), p.hour, p.minute, timeZone);
	// Right after a clock change the calendar step can land an hour short of `now`.
	return next > now ? next : zonedTime(p.year, p.month, p.day + (steps + 1) * (every / DAY_MS), p.hour, p.minute, timeZone);
}

const daysIn = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

function localParts(time: number, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
			.formatToParts(time)
			.map((p) => [p.type, Number(p.value)]),
	);
	return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}

/** How far `timeZone` is ahead of UTC at `time`, in ms. */
function offsetAt(time: number, timeZone: string) {
	const p = localParts(time, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(time / 60_000) * 60_000;
}

/** A wall-clock time in `timeZone` as epoch ms. Days past the month's end roll over, like Date.UTC. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	const first = wall - offsetAt(wall, timeZone);
	// Near a clock change the offset at the answer can differ from the guess's.
	return wall - offsetAt(first, timeZone);
}

/** "Thu, Apr 1, 2027, 9:00 AM PDT" in `timeZone`. */
export const followupWhen = (time: number, timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(time);

/** Checks a follow-up's note before it's stored. Note-less wakeups look around instead (#162); follow-ups always say what to do. */
export function followupNoteError(note: string) {
	if (!note.trim()) return "Say what to check when it's time.";
	if (note.length > FOLLOWUP_NOTE_MAX) return `Keep the note under ${FOLLOWUP_NOTE_MAX} characters.`;
	return null;
}

const createInput = z.object({
	note: z
		.string()
		.max(FOLLOWUP_NOTE_MAX)
		.describe('What to check or do when it\'s time, with the condition, e.g. "Chase the invoice if it\'s still unpaid."'),
	at: z.string().optional().describe('A date "YYYY-MM-DD" (9:00 AM) or "YYYY-MM-DD HH:MM", in the person\'s time zone'),
	in: z.string().optional().describe('How long from now, e.g. "2 hours", "3 days", "5 months". Give "at" or "in".'),
	every: z.string().optional().describe('Repeat this often after the first time, e.g. "1 week" (days or weeks; at most hourly). Leave out for once.'),
	times: z.number().int().min(2).max(REPEAT_TIMES_MAX).optional().describe("With every: how many times in all, e.g. 4 for weekly over a month. Leave out to repeat until cancelled."),
	recordId: z.string().optional().describe("The record it's about (id from the records tools): it shows on that record, and you get its current values when it's time"),
});
export type FollowupInput = z.infer<typeof createInput>;

export const wakeupTools: ToolDef[] = [
	defineTool({
		id: "followups.create",
		title: "Set a follow-up",
		description:
			"Check back later, here in this chat, acting for the same person: you get the note (and the record's current values) at that time and decide then whether it still applies. Use it for \"remind me…\", \"chase … in 3 days if…\", \"reach out in April\", or with every/times \"check this deal every Monday for a month\".",
		input: createInput,
		label: (_input, output) => {
			const when = resultText(output, "when");
			return when ? `Set a follow-up for ${when}` : undefined;
		},
		execute: (input, { wakeups }) => wakeups.create(input),
	}),
	defineTool({
		id: "followups.list",
		title: "List follow-ups",
		description: "Pending follow-ups and check-ins the person can see, soonest first, optionally for one record.",
		input: z.object({ recordId: z.string().optional() }),
		readOnly: true,
		// Notes can come from the person's private chats.
		risk: "inside",
		returnsData: true,
		execute: (input, { wakeups }) => wakeups.list(input),
	}),
	defineTool({
		id: "followups.cancel",
		title: "Cancel a follow-up",
		description: "Cancel a pending follow-up by id (from followups_list), so nothing runs. Its person, its maker or an owner can.",
		input: z.object({ id: z.string() }),
		execute: (input, { wakeups }) => wakeups.cancel(input),
	}),
	defineTool({
		id: "chat.notify",
		title: "Post a message",
		description:
			"Only when you woke up on your own (a follow-up, check-in or finished job): post a message in this chat. Nothing else you write then is shown, so use it only when there's something worth telling them.",
		input: z.object({ text: z.string().max(NOTIFY_TEXT_MAX).describe("The message, in Markdown") }),
		// Like a reply: it says something where the agent was already talking.
		risk: "none",
		label: () => "Posted a message",
		execute: (input, { wakeups }) => wakeups.notify(input),
	}),
];
