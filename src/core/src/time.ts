/**
 * A person's time zone: the one they picked, else their computer's ("automatic"),
 * else UTC. Unknown names fall through, so a bad value never breaks a reply.
 */
export function resolveTimeZone(chosen?: string | null, device?: string | null): string {
	for (const zone of [chosen, device]) if (zone && isValidTimeZone(zone)) return zone;
	return "UTC";
}

/** "Thursday, October 22, 2026 at 8:01 AM PDT" in `timeZone`. */
export function formatLocalTime(time: Date | number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	}).format(time);
}

export const isValidTimeZone = (timeZone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
};

export const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One formatter per zone: a prompt stamps dozens of chat lines, and building one is slow. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The date ("2026-10-22"), weekday (0 = Sunday), and "HH:MM" time it is at `now` in a time zone. */
export function localTime(now: number, timeZone: string) {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
		formatters.set(timeZone, formatter);
	}
	const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		weekday: dayNames.indexOf(parts.weekday!),
		time: `${parts.hour}:${parts.minute}`,
	};
}

/** "10-22 08:01" in `timeZone`, for chat lines in prompts. */
export function shortStamp(time: number, timeZone: string): string {
	const { date, time: clock } = localTime(time, timeZone);
	return `${date.slice(5)} ${clock}`;
}
