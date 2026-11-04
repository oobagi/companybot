import { repeatLabel } from "./wakeup-display";
export { repeatLabel } from "./wakeup-display";
import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { type ToolDef, defineTool, resultText } from "./tools";

/**
 * Wakeups: an agent wakes later in a place, acting for the same person (backend wakeups.ts).
 * One system: when (a time, once or repeating, or a job finishing, #114) plus what (a note: a
 * follow-up the agent set, "chase Acme's invoice in 3 days if it's unpaid"; no note: look around,
 * #162's heartbeat). The agent checks when it wakes whether there's anything to do, so there's
 * no condition to set up. A wake turn is quiet: its reply shows only if its decision says to post (turn-input.ts `postDecision`).
 */

/** How one wake went, for its line in Activity: queued a turn, skipped (and why), finished quietly, spoke up, or failed. */
export const wakeOutcomes = ["fired", "skipped", "ran", "notified", "failed"] as const;
export type WakeOutcome = (typeof wakeOutcomes)[number];

export interface WakeupStore {
	create(input: FollowupInput): Promise<{ created: string; when: string; record?: string } | { error: string }>;
	list(input: { recordId?: string }): Promise<{ followups: FollowupSummary[] } | { error: string }>;
	cancel(input: { id: string }): Promise<{ cancelled: string } | { error: string }>;
}

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

const durationInput = z.object({
	years: z.number().int().nonnegative().max(2).optional().describe("Calendar years; keeps local clock time."),
	months: z.number().int().nonnegative().max(24).optional().describe("Calendar months; keeps local clock time and clamps month ends."),
	weeks: z.number().int().nonnegative().max(104).optional().describe("Calendar weeks; keeps local clock time."),
	days: z.number().int().nonnegative().max(FOLLOWUP_MAX_DAYS).optional().describe("Calendar days; keeps local clock time."),
	hours: z.number().int().nonnegative().max(FOLLOWUP_MAX_DAYS * 24).optional().describe("Elapsed hours, including across DST changes."),
	minutes: z.number().int().nonnegative().max(FOLLOWUP_MAX_DAYS * 1440).optional().describe("Elapsed minutes, including across DST changes."),
}).strict().refine((d) => Object.values(d).some((n) => n > 0), "Give a positive duration.");
const timeInput = z.object({
	year: z.number().int().min(1).max(9999).describe("Calendar year (1–9999)."),
	month: z.number().int().min(1).max(12).describe("Calendar month (1–12)."),
	day: z.number().int().min(1).max(31).describe("Day of month (1–31); must exist in that month."),
	hour: z.number().int().min(0).max(23).optional().describe("Local hour (0–23); defaults to 9."),
	minute: z.number().int().min(0).max(59).optional().describe("Local minute (0–59); defaults to 0."),
	timeZone: z.string().optional().describe("IANA time zone, e.g. America/New_York for ET; defaults to the person's zone."),
}).strict();
export type WakeDuration = z.infer<typeof durationInput>;
export type WakeAnchor = { local: string; timeZone: string };
const zoned = (time: number, timeZone: string) => Temporal.Instant.fromEpochMilliseconds(time).toZonedDateTimeISO(timeZone);
export function wakeAnchor(time: number, timeZone: string, at?: z.infer<typeof timeInput>): WakeAnchor {
	return { local: at ? Temporal.PlainDateTime.from({ ...at, hour: at.hour ?? 9, minute: at.minute ?? 0 }).toString() : zoned(time, timeZone).toPlainDateTime().toString(), timeZone: at?.timeZone ?? timeZone };
}

/** What a model sent wrong, field by field, so it can fix the call. */
const invalid = (error: z.ZodError) => `Fix the time: ${error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message).replace(/\.$/, "")).join("; ")}.`;

/** IANA names only ("America/New_York", or UTC): abbreviations like EST are fixed offsets with no daylight saving. */
export function timeZoneError(zone: string) {
	try {
		if (zone === "UTC" || (zone.includes("/") && new Intl.DateTimeFormat("en", { timeZone: zone }))) return null;
	} catch {}
	return `Unknown time zone "${zone}"; use an IANA name like America/New_York.`;
}

/** Structured wall time, or calendar duration from now. */
export function followupTime(when: { at?: z.infer<typeof timeInput>; in?: WakeDuration }, now: number, timeZone: string): number | string {
	if ((when.at === undefined) === (when.in === undefined)) return 'Give either "at" or "in".';
	const checked = when.at !== undefined ? timeInput.safeParse(when.at) : durationInput.safeParse(when.in);
	if (!checked.success) return invalid(checked.error);
	if (when.at?.timeZone !== undefined) {
		const error = timeZoneError(when.at.timeZone);
		if (error) return error;
	}
	try {
		if (when.at) {
			const at = timeInput.parse(when.at);
			const month = Temporal.PlainYearMonth.from({year: at.year, month: at.month});
			if (at.day > month.daysInMonth) return `${new Intl.DateTimeFormat("en", {month: "long", timeZone: "UTC"}).format(new Date(Date.UTC(at.year, at.month - 1, 1)))} has ${month.daysInMonth} days in ${at.year}.`;
		}
		const time = when.in !== undefined
			? zoned(now, timeZone).add(durationInput.parse(when.in), { overflow: "constrain" }).epochMilliseconds
			: Temporal.ZonedDateTime.from({ ...timeInput.parse(when.at), hour: when.at!.hour ?? 9, minute: when.at!.minute ?? 0, timeZone: when.at!.timeZone ?? timeZone }, { overflow: "reject", disambiguation: "compatible" }).epochMilliseconds;
		if (time < now + FOLLOWUP_MIN_MS) return "Pick a time at least a minute from now.";
		if (time > now + FOLLOWUP_MAX_DAYS * 86_400_000) return "Pick a time within 2 years.";
		return time;
	} catch { return "Give a valid structured time or positive duration within 2 years."; }
}

export function repeatEvery(input: WakeDuration): WakeDuration | string {
	const parsed = durationInput.safeParse(input);
	if (!parsed.success) return invalid(parsed.error).replace("Fix the time", "Fix the repeat");
	const d = parsed.data;
	const days = Temporal.Duration.from(d).total({unit: "days", relativeTo: "2027-01-01"});
	if (days > FOLLOWUP_MAX_DAYS) return "Repeat within 2 years.";
	if (days * 86_400_000 < REPEAT_MIN_MS) return "Repeat at most once an hour.";
	return d;
}

/** Calendar arithmetic happens before zone resolution: a gap shifts only that occurrence. */
export function nextRepeat(anchor: WakeAnchor, every: WakeDuration, now: number) {
	const start = Temporal.PlainDateTime.from(anchor.local);
	const {hours = 0, minutes = 0, ...calendar} = every;
	const occurrence = (n: number) => (Object.keys(calendar).length ? start.add(Object.fromEntries(Object.entries(calendar).map(([k, v]) => [k, v * n])), { overflow: "constrain" }) : start)
		.toZonedDateTime(anchor.timeZone, {disambiguation: "compatible"}).add({hours: hours * n, minutes: minutes * n}).epochMilliseconds;
	let low = 1, high = 1;
	while (occurrence(high) <= now) high *= 2;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (occurrence(mid) <= now) low = mid + 1; else high = mid;
	}
	return occurrence(low);
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
	at: timeInput.optional().describe("Local calendar date and time in the specified zone (or the person's); defaults to 09:00."),
	in: durationInput.optional().describe('Duration from now, e.g. {days: 3}. Give at or in.'),
	every: durationInput.optional().describe('Repeat duration, e.g. {weeks: 1} or {months: 1}; at most hourly and within 2 years.'),
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
		description: "Cancel a pending follow-up by id (from followups_list), so nothing runs. Its person, whoever made it, or someone who can change agents can.",
		input: z.object({ id: z.string() }),
		execute: (input, { wakeups }) => wakeups.cancel(input),
	}),
];
