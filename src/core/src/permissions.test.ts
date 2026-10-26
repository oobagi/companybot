import { describe, expect, it } from "vitest";
import { can, canEditMade, canManageChannel, permissions } from "./permissions";

import { owner, member } from "../test/helpers";

describe("permissions", () => {
	it("gives owners everything and members only what's listed", () => {
		for (const p of Object.keys(permissions) as (keyof typeof permissions)[]) expect(can(owner, p)).toBe(true);
		expect(can(member, "connectors.connect")).toBe(true);
		expect(can(member, "agents.manage")).toBe(false);
	});

	it("lets members create channels and manage only the ones they created", () => {
		expect(can(member, "channels.create")).toBe(true);
		expect(can(member, "channels.manage")).toBe(false);
		expect(canManageChannel(member, { createdBy: "member" })).toBe(true);
		expect(canManageChannel(member, { createdBy: "owner" })).toBe(false);
		expect(canManageChannel(owner, { createdBy: "member" })).toBe(true);
	});

	it("lets members change records and add fields, but not manage record types", () => {
		expect(can(member, "records.edit")).toBe(true);
		expect(can(member, "fields.create")).toBe(true);
		expect(can(member, "fields.manage")).toBe(false);
	});

	it.each(["skills.manage", "automations.manage", "fields.manage"] as const)("lets makers and managers edit through %s", (permission) => {
		expect(canEditMade(member, permission, member.userId)).toBe(true);
		expect(canEditMade(member, permission, owner.userId)).toBe(false);
		expect(canEditMade(member, permission)).toBe(false);
		expect(canEditMade(member, permission, "")).toBe(false);
		expect(canEditMade(owner, permission, member.userId)).toBe(true);
		expect(canEditMade(owner, permission)).toBe(true);
	});
});
