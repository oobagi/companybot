import { describe, expect, it } from "vitest";
import { describeTrigger, isValidTimeZone, scheduleDue } from "./automations";

describe("automations", () => {
	const brief = { trigger: { type: "schedule" as const, time: "08:00", weekdays: [1, 2, 3, 4, 5] } };
	// Thu 2026-10-22, 15:30 UTC = 08:30 in Los Angeles.
	const thursday = Date.UTC(2026, 9, 22, 15, 30);
	const la = "America/Los_Angeles";

	it("runs a schedule once a day, after its time, on its days", () => {
		expect(scheduleDue(brief.trigger, thursday, la, undefined)).toBe("2026-10-22");
		expect(scheduleDue(brief.trigger, thursday, la, "2026-10-22")).toBeNull();
		expect(scheduleDue(brief.trigger, thursday - 60 * 60_000, la, undefined)).toBeNull(); // 7:30
		expect(scheduleDue(brief.trigger, thursday + 2 * 86_400_000, la, undefined)).toBeNull(); // Saturday
	});

	it("never schedules event automations", () => {
		expect(scheduleDue({ type: "event", event: "member.joined", label: "When someone joins" }, thursday, la, undefined)).toBeNull();
	});

	it("describes triggers plainly", () => {
		expect(describeTrigger(brief.trigger)).toBe("Weekdays at 8:00 AM");
		expect(isValidTimeZone(la)).toBe(true);
		expect(isValidTimeZone("Mars/Base")).toBe(false);
	});
});
