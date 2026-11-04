import { describe, expect, it } from "vitest";
import { type Permission, can, canEditAutomation, canTrash, canUseConnector, deniedMessage, memberDefaults, permissions, switches } from "./permissions";

import { owner, member } from "../test/helpers";

const roles = [
	{ name: "Owner", owner: true, permissions: [] },
	{ name: "Member", owner: false, permissions: memberDefaults },
	{ name: "Office", owner: false, permissions: ["agents.manage", "records.edit"] as Permission[] },
];

describe("permissions", () => {
	it("gives owners everything, and others the union of their roles' switches", () => {
		for (const p of Object.keys(permissions) as Permission[]) expect(can(owner, p)).toBe(true);
		expect(can(member, "connectors.connect")).toBe(true);
		expect(can(member, "agents.manage")).toBe(false);
		const both = { ...member, permissions: [...memberDefaults, "agents.manage" as const] };
		expect(can(both, "agents.manage")).toBe(true);
		expect(can(both, "records.edit")).toBe(true);
	});

	it("keeps owner-only actions out of the switches, even if a role lists one", () => {
		expect(switches).not.toContain("workspace.delete");
		expect(switches).not.toContain("roles.manage");
		expect(can({ ...member, permissions: ["workspace.delete", "roles.manage"] }, "workspace.delete")).toBe(false);
	});

	it("names the roles that have a permission, Owner last", () => {
		expect(deniedMessage("agents.manage", roles)).toBe("Only people with the Office or Owner role can change agents. Ask someone who has one of them.");
		expect(deniedMessage("records.edit", roles)).toBe("Only people with the Member, Office or Owner role can add and change records. Ask someone who has one of them.");
		expect(deniedMessage("workspace.delete", roles)).toBe("Only people with the Owner role can delete the workspace. Ask someone who has it.");
	});

	it("lets personal automations be changed by their maker alone; team ones by the switch", () => {
		const none = { ...member, permissions: [] };
		expect(canEditAutomation(none, "member")).toBe(true);
		expect(canEditAutomation(owner, "member")).toBe(false);
		expect(canEditAutomation(none, null)).toBe(false);
		expect(canEditAutomation(member, null)).toBe(true);
		expect(canTrash(none, "automation", "member")).toBe(true);
		expect(canTrash(none, "automation")).toBe(false);
		expect(canTrash(none, "channel")).toBe(false);
		expect(canTrash(member, "channel")).toBe(true);
	});

	it("lets owners use every connector, and others the ones allowed for one of their roles", () => {
		expect(canUseConnector(owner, [])).toBe(true);
		expect(canUseConnector(member, [])).toBe(false);
		expect(canUseConnector(member, ["member-role"])).toBe(true);
	});
});
