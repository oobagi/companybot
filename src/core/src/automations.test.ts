import { describe, expect, it } from "vitest";
import { customAutomationError, describeTrigger, isValidTimeZone, normalizeCustomAutomation, scheduleCron, scheduleDue } from "./automations";

describe("automations", () => {
	const brief = { type: "schedule" as const, cron: "0 8 * * 1-5" };
	// Thu 2026-10-22, 15:30 UTC = 08:30 in Los Angeles.
	const thursday = Date.UTC(2026, 9, 22, 15, 30);
	const eight = Date.UTC(2026, 9, 22, 15, 0);
	const la = "America/Los_Angeles";

	it("runs a schedule's latest time once, even when the check is late", () => {
		expect(scheduleDue(brief, thursday, la, eight - 1)).toBe(eight);
		expect(scheduleDue(brief, thursday, la, eight)).toBeNull();
		expect(scheduleDue(brief, thursday - 60 * 60_000, la, eight - 2 * 86_400_000)).toBe(eight - 86_400_000); // 7:30: Wednesday's, if it missed it
		// Saturday: Friday's ran, nothing since.
		expect(scheduleDue(brief, thursday + 2 * 86_400_000, la, eight + 86_400_000)).toBeNull();
	});

	it("never schedules event automations", () => {
		expect(scheduleDue({ type: "event", event: "member.joined", label: "When someone joins" }, thursday, la, 0)).toBeNull();
	});

	it("checks schedules people make", () => {
		const config = (trigger: { type: "schedule"; cron: string }) => ({ name: "Daily", prompt: "Do it", trigger });
		expect(customAutomationError(config({ type: "schedule", cron: "0 9,13 * * 1-5" }))).toBeNull();
		expect(customAutomationError(config({ type: "schedule", cron: "*/5 * * * *" }))).toMatch(/every 15 minutes/);
		expect(customAutomationError(config({ type: "schedule", cron: "nine every day" }))).toMatch(/doesn't look right/);
	});

	it("describes triggers plainly", () => {
		expect(describeTrigger(brief)).toBe("Weekdays at 8:00 AM");
		expect(describeTrigger({ type: "webhook", label: "When a call ends", sample: { id: "x" } })).toBe("When a call ends");
		expect(isValidTimeZone(la)).toBe(true);
		expect(isValidTimeZone("Mars/Base")).toBe(false);
	});
});
