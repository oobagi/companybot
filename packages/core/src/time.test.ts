import { describe, expect, it } from "vitest";
import { formatLocalTime, resolveTimeZone, shortStamp } from "./time";
import { builtinTools } from "./builtin-tools";

import { owner, ctx } from "../test/helpers";

describe("time zones", () => {
	const la = "America/Los_Angeles";
	const t = Date.UTC(2026, 9, 23, 3, 27);

	it("uses the picked zone, else the computer's, else UTC", () => {
		expect(resolveTimeZone(la, "Europe/Paris")).toBe(la);
		expect(resolveTimeZone(null, "Europe/Paris")).toBe("Europe/Paris");
		expect(resolveTimeZone("Mars/Base", undefined)).toBe("UTC");
	});

	it("formats times in the person's zone", () => {
		expect(formatLocalTime(t, la)).toBe("Thursday, October 22, 2026 at 8:27 PM PDT");
		expect(shortStamp(t, la)).toBe("10-22 20:27");
		expect(shortStamp(t, "UTC")).toBe("10-23 03:27");
	});

	it("tells the time in the person's zone", async () => {
		const clock = builtinTools.find((x) => x.id === "clock.now")!;
		const result = (await clock.execute({}, { ...ctx(owner), timeZone: la })) as { local: string; timeZone: string };
		expect(result.timeZone).toBe(la);
		expect(result.local).toMatch(/P[DS]T$/);
	});
});
