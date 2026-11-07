import { describe, expect, it } from "vitest";
import { EVERYONE, PUBLIC, PUBLIC_ACCESS, canAddIn, cleanAccess, isRestricted, levelIn, placeDeniedMessage, whoCan, widens } from "./place-access";

const person = (roles: string[], owner = false) => ({ roles, owner, permissions: [] });
const roles = [
	{ id: "owner", name: "Owner", owner: true },
	{ id: "member", name: "Member", owner: false },
	{ id: "office", name: "Office", owner: false },
	{ id: "crew", name: "Crew", owner: false },
];
const readOnly = [
	{ role: EVERYONE, level: "view" as const },
	{ role: "office", level: "edit" as const },
];

describe("place access", () => {
	it("gives the most any of someone's roles has, everything to owners, and Edit with no list", () => {
		expect(levelIn(person(["crew"]), undefined)).toBe("edit");
		expect(levelIn(person(["crew"]), readOnly)).toBe("view");
		expect(levelIn(person(["crew", "office"]), readOnly)).toBe("edit");
		expect(levelIn(person(["crew"]), [{ role: "office", level: "edit" }])).toBeNull();
		expect(levelIn(person([], true), [])).toBe("edit");
	});

	it("names who can, Owners last", () => {
		expect(whoCan(readOnly, roles, "edit")).toBe("Office and Owners");
		expect(whoCan(readOnly, roles, "view")).toBe("Everyone");
		expect(whoCan([{ role: "office", level: "view" }, { role: "crew", level: "edit" }], roles, "view")).toBe("Office, Crew and Owners");
		expect(whoCan([], roles)).toBe("Owners");
		expect(placeDeniedMessage("database", "Deals", [{ role: "office", level: "edit" }], roles, "view")).toBe("Only Office and Owners can see Deals.");
		expect(placeDeniedMessage("channel", "#news", readOnly, roles, "edit")).toBe("Only Office and Owners can post in #news.");
	});

	it("saves only this workspace's roles, each once, without Owner", () => {
		expect(cleanAccess([{ role: "office", level: "edit" }, { role: "office", level: "view" }, { role: "owner", level: "view" }], ["owner", "office"], "owner", "page")).toEqual([{ role: "office", level: "edit" }]);
		expect(() => cleanAccess([{ role: "elsewhere", level: "edit" }], ["owner"], "owner", "page")).toThrow("Role not found.");
		expect(isRestricted([{ role: EVERYONE, level: "edit" }])).toBe(false);
		expect(isRestricted(readOnly)).toBe(true);
	});

	it("tells whether a list lets anyone further in", () => {
		const ids = roles.map((r) => r.id);
		expect(widens([{ role: "office", level: "edit" }], undefined, ids)).toBe(true);
		expect(widens(undefined, [{ role: "office", level: "edit" }], ids)).toBe(false);
		expect(widens(readOnly, [{ role: "office", level: "edit" }], ids)).toBe(false);
		expect(widens([{ role: "office", level: "view" }], [{ role: "office", level: "edit" }], ids)).toBe(true);
	});

	it("gives Add only its own reach: adding, never seeing everything", () => {
		const form = [{ role: "crew", level: "add" as const }];
		expect(levelIn(person(["crew"]), form)).toBeNull();
		expect(canAddIn(person(["crew"]), form)).toBe(true);
		expect(canAddIn(person(["office"]), form)).toBe(false);
		// Edit includes adding; View doesn't.
		expect(canAddIn(person(["crew"]), undefined)).toBe(true);
		expect(canAddIn(person(["crew"]), readOnly)).toBe(false);
		// Two roles add up: View from one and Add from another.
		const both = [{ role: "crew", level: "view" as const }, { role: "office", level: "add" as const }];
		expect(levelIn(person(["crew", "office"]), both)).toBe("view");
		expect(canAddIn(person(["crew", "office"]), both)).toBe(true);
		expect(whoCan(both, roles, "add")).toBe("Office and Owners");
		expect(placeDeniedMessage("database", "Leads", form, roles, "add")).toBe("Only Crew and Owners can add to Leads.");
	});

	it("never counts people outside as Everyone, and never gives them Edit", () => {
		expect(levelIn(PUBLIC_ACCESS, undefined)).toBeNull();
		expect(levelIn(PUBLIC_ACCESS, readOnly)).toBeNull();
		expect(canAddIn(PUBLIC_ACCESS, undefined)).toBe(false);
		expect(levelIn(PUBLIC_ACCESS, [...readOnly, { role: PUBLIC, level: "view" }])).toBe("view");
		expect(canAddIn(PUBLIC_ACCESS, [{ role: PUBLIC, level: "add" }])).toBe(true);
		// A stored Edit for Public (which saving refuses) still gives nothing.
		expect(levelIn(PUBLIC_ACCESS, [{ role: PUBLIC, level: "edit" }])).toBeNull();
		expect(canAddIn(PUBLIC_ACCESS, [{ role: PUBLIC, level: "edit" }])).toBe(false);
		// Members don't get what's shared with Public.
		expect(levelIn(person(["crew"]), [{ role: PUBLIC, level: "view" }])).toBeNull();
	});

	it("refuses saving Public above View, or Add, and Add outside databases", () => {
		const ids = ["owner", "office"];
		expect(cleanAccess([{ role: PUBLIC, level: "view" }], ids, "owner", "page")).toEqual([{ role: PUBLIC, level: "view" }]);
		expect(cleanAccess([{ role: PUBLIC, level: "add" }], ids, "owner", "database")).toEqual([{ role: PUBLIC, level: "add" }]);
		expect(() => cleanAccess([{ role: PUBLIC, level: "edit" }], ids, "owner", "database")).toThrow();
		expect(() => cleanAccess([{ role: PUBLIC, level: "edit" }], ids, "owner", "page")).toThrow();
		expect(() => cleanAccess([{ role: PUBLIC, level: "add" }], ids, "owner", "page")).toThrow();
		expect(() => cleanAccess([{ role: PUBLIC, level: "view" }], ids, "owner", "channel")).toThrow();
		expect(() => cleanAccess([{ role: "office", level: "add" }], ids, "owner", "channel")).toThrow();
		expect(cleanAccess([{ role: "office", level: "add" }], ids, "owner", "database")).toEqual([{ role: "office", level: "add" }]);
	});

	it("counts sharing with Public, or Add, as letting someone further in", () => {
		const ids = roles.map((r) => r.id);
		expect(widens(undefined, [{ role: EVERYONE, level: "edit" }, { role: PUBLIC, level: "view" }], ids)).toBe(true);
		expect(widens([{ role: PUBLIC, level: "view" }], [{ role: PUBLIC, level: "add" }], ids)).toBe(true);
		expect(widens([{ role: "office", level: "view" }], [{ role: "office", level: "view" }, { role: "crew", level: "add" }], ids)).toBe(true);
		expect(widens([{ role: PUBLIC, level: "view" }], [], ids)).toBe(false);
		// Sharing with Public doesn't make a place look restricted to the team.
		expect(isRestricted([{ role: EVERYONE, level: "edit" }, { role: PUBLIC, level: "view" }])).toBe(false);
	});
});
