import { describe, expect, it } from "vitest";
import { type Memory, canCreateMemory, canEditMemory, canReadMemory, memoryMatches } from "./memory";

import { owner, member, other } from "../test/helpers";

describe("memory permissions", () => {
	it("searches by words and prefixes, every word, ignoring case and punctuation", () => {
		expect(memoryMatches("Office is in Austin, TX.", "aus")).toBe(true);
		expect(memoryMatches("Office is in Austin, TX.", "office tx")).toBe(true);
		expect(memoryMatches("Office is in Austin, TX.", "ustin")).toBe(false);
		expect(memoryMatches("Office is in Austin, TX.", "office dallas")).toBe(false);
		expect(memoryMatches("Anything", "  ")).toBe(true);
	});

	const team: Memory = {
		id: "t",
		agentId: "a",
		scope: "workspace",
		ownerId: null,
		content: "",
		updatedAt: "",
		updatedBy: "owner",
		version: 1,
	};
	const mine: Memory = { ...team, id: "m", scope: "personal", ownerId: "member" };

	it("lets members edit only their own personal memories", () => {
		expect(canEditMemory(member, { ...mine, ownerId: "other" })).toBe(false);
		expect(canCreateMemory(member, "workspace")).toBe(false);
		expect(canCreateMemory(member, "personal")).toBe(true);
		expect(canEditMemory(member, team)).toBe(false);
		expect(canEditMemory(member, mine)).toBe(true);
		expect(canEditMemory(other, mine)).toBe(false);
	});

	it("keeps personal memories private from everyone else, owners included", () => {
		expect(canReadMemory(other, mine)).toBe(false);
		expect(canReadMemory(other, team)).toBe(true);
		expect(canReadMemory(owner, mine)).toBe(false);
		expect(canEditMemory(owner, mine)).toBe(false);
		expect(canReadMemory(owner, { ...mine, ownerId: owner.userId })).toBe(true);
		expect(canEditMemory(owner, team)).toBe(true);
	});
});
