import { isValidTimeZone } from "./automations";

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

/** "10-22 08:01" in `timeZone`, for chat lines in prompts. */
export function shortStamp(time: number, timeZone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(time)
			.map((p) => [p.type, p.value]),
	);
	return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
