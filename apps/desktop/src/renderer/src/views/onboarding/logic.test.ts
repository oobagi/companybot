import { describe, expect, it } from "vitest";
import { parseInvites } from "./logic";

describe("parseInvites", () => {
	it("takes emails one per line or separated by commas, semicolons or spaces, lowercased and deduplicated", () => {
		expect(parseInvites("Bob@Co.com\n cy@co.com, bob@co.com;dee@co.com  eve@co.com\n\n")).toEqual({
			emails: ["bob@co.com", "cy@co.com", "dee@co.com", "eve@co.com"],
			invalid: [],
		});
	});

	it("drops your own address and blank input", () => {
		expect(parseInvites("Me@Co.com, bob@co.com", "me@co.com")).toEqual({ emails: ["bob@co.com"], invalid: [] });
		expect(parseInvites("   \n ")).toEqual({ emails: [], invalid: [] });
	});

	it("lists what isn't a whole email, once each", () => {
		expect(parseInvites("bob@co, cy@co.com, bob@co, dee")).toEqual({ emails: ["cy@co.com"], invalid: ["bob@co", "dee"] });
	});
});
