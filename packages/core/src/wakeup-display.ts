import type { WakeDuration } from "./wakeups";

/** "every week", "every 2 weeks", "every 1 day, 6 hours". */
export function repeatLabel(d: WakeDuration) {
	const parts = Object.entries(d).filter(([, n]) => n) as [string, number][];
	if (parts.length === 1 && parts[0]![1] === 1) return `every ${parts[0]![0].slice(0, -1)}`;
	return "every " + parts.map(([unit, n]) => `${n} ${n === 1 ? unit.slice(0, -1) : unit}`).join(", ");
}

