import { Cron } from "croner";
import cronstrue from "cronstrue";

/**
 * Automation schedules are standard 5-field cron ("minute hour day-of-month month day-of-week",
 * like "0 9,13 * * 1-5"), run in the time zone of whoever set them up. croner reads them
 * (time zones through Intl, so it runs in Convex's runtime); cronstrue describes the ones the
 * app's form can't. The form (`ScheduleForm`) is a friendlier way to write the same cron.
 */

/** Fastest a schedule may repeat: each run is a full agent reply for each person it runs for. */
export const MIN_SCHEDULE_MINUTES = 15;

/** A new schedule: weekdays at 9:00 AM. */
export const DEFAULT_CRON = "0 9 * * 1-5";

const formatHint = 'Use 5 parts: minute, hour, day of month, month, day of week, like "0 9 * * 1-5" (weekdays at 9:00 AM).';

const parse = (cron: string, timeZone = "UTC") => new Cron(cron, { timezone: timeZone, mode: "5-part", paused: true });

/** One space between parts, so the same schedule always reads the same. */
export const normalizeCron = (cron: string) => cron.trim().split(/\s+/).join(" ");

/** The first problem with a cron schedule, in a line, or null. */
export function scheduleError(cron: string): string | null {
	const parts = normalizeCron(cron).split(" ");
	if (!cron.trim()) return "Pick when it runs.";
	// "?" means "now" to croner, and "@daily"-style names aren't standard: keep to the 5 parts.
	if (parts.length !== 5 || /[?@]/.test(cron)) return `That schedule doesn't look right. ${formatHint}`;
	let runs: Date[];
	try {
		runs = parse(normalizeCron(cron)).nextRuns(1);
	} catch {
		return `That schedule doesn't look right. ${formatHint}`;
	}
	if (runs.length === 0) return "That schedule never runs.";
	return tooOften(parts[0]!, parts[1]!)
		? `Schedules can run at most every ${MIN_SCHEDULE_MINUTES} minutes: each run is a full agent reply for everyone it runs for.`
		: null;
}

/**
 * Whether two runs on one day (or across midnight) come closer than the floor. Only the minute
 * and hour parts decide that, so this walks one UTC day of just those.
 */
function tooOften(minute: string, hour: string) {
	const start = Date.UTC(2000, 0, 1);
	const day = 86_400_000;
	// More than 96 runs in a day can't all be 15 minutes apart, so the walk stops there.
	const most = (24 * 60) / MIN_SCHEDULE_MINUTES;
	const runs = parse(`${minute} ${hour} * * *`)
		.nextRuns(most + 2, new Date(start - 1000))
		.map((d) => d.getTime());
	const today = runs.filter((t) => t < start + day);
	if (today.length > most) return true;
	const times = [...today, today[0]! + day];
	return times.some((t, i) => i > 0 && t - times[i - 1]! < MIN_SCHEDULE_MINUTES * 60_000);
}

/** The next `count` runs after `after` (ms), soonest first. */
export function nextRuns(cron: string, timeZone: string, after: number, count: number): number[] {
	return parse(normalizeCron(cron), timeZone)
		.nextRuns(count, new Date(after))
		.map((d) => d.getTime());
}

/** The latest run at or before `now`, or null if it never ran before then. */
export function latestRun(cron: string, timeZone: string, now: number): number | null {
	// Runs fall on whole minutes; a second past `now` counts a run at exactly `now`.
	const [run] = parse(normalizeCron(cron), timeZone).previousRuns(1, new Date(now + 1000));
	return run && run.getTime() <= now ? run.getTime() : null;
}

/**
 * The run a schedule is due for now, or null: its latest run at or before `now`, if that's after
 * `last` (the run it last did, or when it was set up). Several missed runs come out as one.
 */
export function cronDue(cron: string, timeZone: string, now: number, last: number): number | null {
	const latest = latestRun(cron, timeZone, now);
	return latest !== null && latest > last ? latest : null;
}

// ---- The form ----

/**
 * A schedule as the app's form shows it. Days: 0 = Sunday. Times: "HH:MM", 24-hour.
 * Daily and weekly are the same shape; they only open differently.
 */
export type ScheduleForm =
	| { repeats: "daily" | "weekly"; times: string[]; days: number[] }
	/** Every `every` hours from `from` to `to` (hours, 0–23), at `minute` past. */
	| { repeats: "hours"; every: number; from: number; to: number; minute: number; days: number[] }
	| { repeats: "monthly"; on: MonthDay; times: string[] };

/** A day of the month (1–31), or the nth (1–4, or "last") weekday. */
export type MonthDay = number | { nth: 1 | 2 | 3 | 4 | "last"; weekday: number };

export const allDays = [0, 1, 2, 3, 4, 5, 6];
export const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const nthNames = { 1: "first", 2: "second", 3: "third", 4: "fourth", last: "last" } as const;

const pad = (n: number) => String(n).padStart(2, "0");
const sortNumbers = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** "1,3-5" → [1, 3, 4, 5]; null for steps, wildcards, or anything out of range. */
function numbers(part: string, min: number, max: number): number[] | null {
	const out: number[] = [];
	for (const piece of part.split(",")) {
		const m = piece.match(/^(\d+)(?:-(\d+))?$/);
		if (!m) return null;
		const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
		if (a < min || b > max || a > b) return null;
		for (let i = a; i <= b; i++) out.push(i);
	}
	return sortNumbers(out);
}

/** The days part: "*", or days (7 is Sunday too). */
function days(part: string) {
	if (part === "*") return allDays;
	const list = numbers(part, 0, 7);
	return list && sortNumbers(list.map((d) => d % 7));
}

/** "1-5", "*", "1,3,5": the shortest days part. */
function daysPart(list: number[]) {
	const ds = sortNumbers(list);
	if (ds.length === 7) return "*";
	const contiguous = ds.length >= 3 && ds.every((d, i) => i === 0 || d === ds[i - 1]! + 1);
	return contiguous ? `${ds[0]}-${ds.at(-1)}` : ds.join(",");
}

const timesOf = (minutes: number[], hours: number[]) => hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`));

/**
 * The form for a cron, or null when the form can't show it (it still runs). `prefer` keeps daily
 * or weekly as it was, so the form doesn't jump between them as days change.
 */
export function scheduleForm(cron: string, prefer?: ScheduleForm["repeats"]): ScheduleForm | null {
	if (scheduleError(cron)) return null;
	const [minute, hour, dom, month, dow] = normalizeCron(cron).split(" ") as [string, string, string, string, string];
	if (month !== "*") return null;
	const minutes = numbers(minute, 0, 59);
	const hours = numbers(hour, 0, 23);
	const nth = dow.match(/^([0-7])(?:#([1-4])|(L))$/);
	if (dom !== "*" || nth) {
		if (!minutes || !hours) return null;
		const times = timesOf(minutes, hours);
		if (nth && dom === "*") return { repeats: "monthly", on: { nth: nth[3] ? "last" : (Number(nth[2]) as 1 | 2 | 3 | 4), weekday: Number(nth[1]) % 7 }, times };
		const day = numbers(dom, 1, 31);
		return day?.length === 1 && dow === "*" ? { repeats: "monthly", on: day[0]!, times } : null;
	}
	const ds = days(dow);
	if (!ds) return null;
	const range = hour.match(/^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/);
	if (range && minutes?.length === 1) {
		const [from, to, every] = [Number(range[1] ?? 0), Number(range[2] ?? 23), Number(range[3] ?? 1)];
		if (to > 23 || from >= to || every < 1 || every > 23) return null;
		return { repeats: "hours", every, from, to, minute: minutes[0]!, days: ds };
	}
	if (!minutes || !hours) return null;
	const repeats = prefer === "daily" || prefer === "weekly" ? prefer : ds.length === 1 ? "weekly" : "daily";
	return { repeats, times: timesOf(minutes, hours), days: ds };
}

/** The cron a form writes, or why it can't: one cron is every minute it lists at every hour it lists. */
export function formCron(form: ScheduleForm): string | { error: string } {
	if (form.repeats === "hours") {
		if (form.days.length === 0) return { error: "Pick at least one day." };
		if (form.to <= form.from) return { error: "End after it starts." };
		const step = form.every === 1 ? "" : `/${form.every}`;
		const hours = form.from === 0 && form.to === 23 ? `*${step}` : `${form.from}-${form.to}${step}`;
		return `${form.minute} ${hours} * * ${daysPart(form.days)}`;
	}
	const times = [...new Set(form.times)].sort();
	if (times.length === 0) return { error: "Add a time." };
	const hours = sortNumbers(times.map((t) => Number(t.slice(0, 2))));
	const minutes = sortNumbers(times.map((t) => Number(t.slice(3, 5))));
	if (hours.length * minutes.length !== times.length)
		return { error: "Times in one schedule share their minutes, like 9:00 and 1:00, or 9:30 and 1:30. Make another automation for the rest." };
	const at = `${minutes.join(",")} ${hours.join(",")}`;
	if (form.repeats !== "monthly") return form.days.length === 0 ? { error: "Pick at least one day." } : `${at} * * ${daysPart(form.days)}`;
	const on = form.on;
	return typeof on === "number" ? `${at} ${on} * *` : `${at} * * ${on.weekday}${on.nth === "last" ? "L" : `#${on.nth}`}`;
}

/** The cron for a schedule from before cron: one time on some weekdays. */
export const legacyCron = (time: string, weekdays: number[]) => {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return `${m} ${h} * * ${daysPart(weekdays.map((d) => d % 7))}`;
};

// ---- Describing ----

/** "9:00 AM". */
export const formatTime = (time: string) => {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};

/** "a", "a and b", "a, b and c". */
const listOf = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** "Every day", "Weekdays", "Mondays", "Mon, Wed and Fri". */
function daysLabel(ds: number[]) {
	const key = sortNumbers(ds).join();
	if (key === "0,1,2,3,4,5,6") return "Every day";
	if (key === "1,2,3,4,5") return "Weekdays";
	if (key === "0,6") return "Weekends";
	if (ds.length === 1) return `${dayNames[ds[0]!]}s`;
	return listOf(sortNumbers(ds).map((d) => shortDays[d]!));
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/**
 * "Weekdays at 9:00 AM and 1:00 PM", "Every 2 hours from 8:00 AM to 6:00 PM", "Monthly on the first
 * Monday at 9:00 AM". `time` writes each "HH:MM" (the app passes the person's locale).
 */
export function describeCron(cron: string, time: (time: string) => string = formatTime): string {
	const form = scheduleForm(cron);
	if (!form) {
		try {
			// "At 09:00 AM, only on Sunday" → "At 9:00 AM, only on Sunday".
			return cronstrue.toString(normalizeCron(cron), { use24HourTimeFormat: false, verbose: false }).replace(/\b0(\d:\d\d)/g, "$1");
		} catch {
			return cron;
		}
	}
	if (form.repeats === "hours") {
		const every = form.every === 1 ? "Every hour" : `Every ${form.every} hours`;
		const allDay = form.from === 0 && form.to === 23;
		const span = allDay && form.minute === 0 ? "" : ` from ${time(`${pad(form.from)}:${pad(form.minute)}`)} to ${time(`${pad(form.to)}:${pad(form.minute)}`)}`;
		const label = daysLabel(form.days);
		const on = form.days.length === 7 ? "" : ` on ${label === "Weekdays" || label === "Weekends" ? label.toLowerCase() : label}`;
		return `${every}${span}${on}`;
	}
	const at = `at ${listOf(form.times.map(time))}`;
	if (form.repeats !== "monthly") return `${daysLabel(form.days)} ${at}`;
	const on = form.on;
	return `Monthly on the ${typeof on === "number" ? ordinal(on) : `${nthNames[on.nth]} ${dayNames[on.weekday]}`} ${at}`;
}
