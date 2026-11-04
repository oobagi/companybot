import { describe, expect, it } from "vitest";
import { EVERYONE, cleanAccess, isRestricted, levelIn, placeDeniedMessage, whoCan, widens } from "./place-access";

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
		expect(cleanAccess([{ role: "office", level: "edit" }, { role: "office", level: "view" }, { role: "owner", level: "view" }], ["owner", "office"], "owner")).toEqual([{ role: "office", level: "edit" }]);
		expect(() => cleanAccess([{ role: "elsewhere", level: "edit" }], ["owner"], "owner")).toThrow("Role not found.");
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
});
