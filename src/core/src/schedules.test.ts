import { describe, expect, it } from "vitest";
import { type ScheduleForm, cronDue, describeCron, formCron, latestRun, legacyCron, nextRuns, scheduleError, scheduleForm } from "./schedules";

const ny = "America/New_York";
const iso = (ms: number[]) => ms.map((t) => new Date(t).toISOString());

describe("schedules", () => {
	it("turns old one-time schedules into cron", () => {
		expect(legacyCron("08:00", [1, 2, 3, 4, 5])).toBe("0 8 * * 1-5");
		expect(legacyCron("09:05", [0, 1, 2, 3, 4, 5, 6])).toBe("5 9 * * *");
		expect(legacyCron("17:30", [5, 1, 3])).toBe("30 17 * * 1,3,5");
	});

	it("describes schedules in words", () => {
		expect(describeCron("0 9,13 * * 1-5")).toBe("Weekdays at 9:00 AM and 1:00 PM");
		expect(describeCron("0 9,13,16 * * *")).toBe("Every day at 9:00 AM, 1:00 PM and 4:00 PM");
		expect(describeCron("30 8 * * 1")).toBe("Mondays at 8:30 AM");
		expect(describeCron("0 9 * * 1,3,5")).toBe("Mon, Wed and Fri at 9:00 AM");
		expect(describeCron("0 10 * * 0,6")).toBe("Weekends at 10:00 AM");
		expect(describeCron("0 8-18/2 * * 1-5")).toBe("Every 2 hours from 8:00 AM to 6:00 PM on weekdays");
		expect(describeCron("0 */3 * * *")).toBe("Every 3 hours");
		expect(describeCron("0 9-17 * * *")).toBe("Every hour from 9:00 AM to 5:00 PM");
		expect(describeCron("0 9 1 * *")).toBe("Monthly on the 1st at 9:00 AM");
		expect(describeCron("0 9 22 * *")).toBe("Monthly on the 22nd at 9:00 AM");
		expect(describeCron("0 9 * * 1#1")).toBe("Monthly on the first Monday at 9:00 AM");
		expect(describeCron("0 17 * * 5L")).toBe("Monthly on the last Friday at 5:00 PM");
		// What the form can't show, cronstrue says.
		expect(describeCron("0 9 * 1 *")).toBe("At 9:00 AM, only in January");
	});

	it("refuses schedules faster than every 15 minutes", () => {
		expect(scheduleError("*/15 * * * *")).toBeNull();
		expect(scheduleError("*/10 * * * *")).toMatch(/at most every 15 minutes/);
		expect(scheduleError("0,5 9 * * *")).toMatch(/at most every 15 minutes/);
		expect(scheduleError("* 9 * * *")).toMatch(/at most every 15 minutes/);
		// Across midnight counts too.
		expect(scheduleError("55,5 23,0 * * *")).toMatch(/at most every 15 minutes/);
		expect(scheduleError("0 9,13 * * 1-5")).toBeNull();
	});

	it("explains what it can't read", () => {
		expect(scheduleError("")).toBe("Pick when it runs.");
		expect(scheduleError("0 9 * *")).toMatch(/5 parts/);
		expect(scheduleError("0 0 9 * * *")).toMatch(/5 parts/);
		expect(scheduleError("@daily")).toMatch(/5 parts/);
		expect(scheduleError("? 9 * * *")).toMatch(/5 parts/);
		expect(scheduleError("0 25 * * *")).toMatch(/doesn't look right/);
		expect(scheduleError("0 9 31 2 *")).toBe("That schedule never runs.");
	});

	it("lists the next runs in the schedule's time zone", () => {
		// Sat 2026-10-31 12:00 UTC = 8:00 AM in New York (EDT).
		const now = Date.UTC(2026, 9, 31, 12);
		expect(iso(nextRuns("0 9,13 * * 1-5", ny, now, 3))).toEqual(["2026-11-02T14:00:00.000Z", "2026-11-02T18:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
	});

	it("keeps local times across daylight saving changes", () => {
		// New York falls back on Sun 2026-11-01: 9:00 AM is 13:00 UTC before, 14:00 UTC after.
		expect(iso(nextRuns("0 9 * * *", ny, Date.UTC(2026, 9, 31), 2))).toEqual(["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
		// Springs forward on Sun 2027-03-14.
		expect(iso(nextRuns("0 9 * * *", ny, Date.UTC(2027, 2, 13), 2))).toEqual(["2027-03-13T14:00:00.000Z", "2027-03-14T13:00:00.000Z"]);
		// A 1:30 AM run on the fall-back day runs once.
		const runs = nextRuns("30 1 * * *", ny, Date.UTC(2026, 10, 1, 4), 2);
		expect(runs[1]! - runs[0]!).toBeGreaterThan(20 * 60 * 60_000);
	});

	it("is due for the latest run after the last one, once, however many were missed", () => {
		const cron = "0 8-18/2 * * *";
		const noon = Date.UTC(2026, 9, 22, 16); // 12:00 PM in New York
		expect(latestRun(cron, ny, noon)).toBe(noon);
		expect(cronDue(cron, ny, noon, noon - 1)).toBe(noon);
		expect(cronDue(cron, ny, noon + 60_000, noon)).toBeNull();
		// Down since yesterday: 8 AM, 10 AM and noon were missed; only noon runs.
		expect(cronDue(cron, ny, noon + 5 * 60_000, noon - 86_400_000)).toBe(noon);
		expect(cronDue(cron, ny, noon + 5 * 60_000, noon)).toBeNull();
		// Before its first run of the day: yesterday's last, if that didn't run.
		expect(cronDue(cron, ny, noon - 5 * 60 * 60_000, noon - 86_400_000)).toBe(noon - 86_400_000 + 6 * 60 * 60_000);
	});

	it("opens crons in the form, and writes them back the same", () => {
		const cases: [string, ScheduleForm][] = [
			["0 9,13 * * 1-5", { repeats: "daily", times: ["09:00", "13:00"], days: [1, 2, 3, 4, 5] }],
			["30 8 * * 1", { repeats: "weekly", times: ["08:30"], days: [1] }],
			["0 8-18/2 * * 1-5", { repeats: "hours", every: 2, from: 8, to: 18, minute: 0, days: [1, 2, 3, 4, 5] }],
			["15 */4 * * *", { repeats: "hours", every: 4, from: 0, to: 23, minute: 15, days: [0, 1, 2, 3, 4, 5, 6] }],
			["0 9 1 * *", { repeats: "monthly", on: 1, times: ["09:00"] }],
			["0 9 * * 1#1", { repeats: "monthly", on: { nth: 1, weekday: 1 }, times: ["09:00"] }],
			["0 17 * * 5L", { repeats: "monthly", on: { nth: "last", weekday: 5 }, times: ["17:00"] }],
		];
		for (const [cron, form] of cases) {
			expect(scheduleForm(cron)).toEqual(form);
			expect(formCron(form)).toBe(cron);
		}
		expect(scheduleForm("0 9 * * *", "weekly")).toMatchObject({ repeats: "weekly" });
		expect(scheduleForm("0 9 * * 7")).toMatchObject({ days: [0] });
	});

	it("leaves crons the form can't show to the cron field", () => {
		for (const cron of ["*/15 * * * *", "0 9 * 1 *", "0 9 1,15 * *", "0 9 1 * 1", "0 9 * * 1-5/2"]) expect(scheduleForm(cron)).toBeNull();
	});

	it("says why a form can't be one cron", () => {
		expect(formCron({ repeats: "daily", times: ["09:00", "13:30"], days: [1] })).toMatchObject({ error: expect.stringMatching(/share their minutes/) });
		expect(formCron({ repeats: "daily", times: [], days: [1] })).toEqual({ error: "Add a time." });
		expect(formCron({ repeats: "weekly", times: ["09:00"], days: [] })).toEqual({ error: "Pick at least one day." });
		expect(formCron({ repeats: "hours", every: 2, from: 18, to: 8, minute: 0, days: [1] })).toEqual({ error: "End after it starts." });
	});
});
