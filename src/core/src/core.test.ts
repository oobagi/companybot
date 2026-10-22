import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess } from "./agents";
import { builtinTools } from "./builtin-tools";
import { companybot, scribe } from "./default-agents";
import { type Memory, type MemoryStore, canCreateMemory, canEditMemory, canReadMemory } from "./memory";
import { skillCatalog, skillsIndex } from "./skills";
import type { Actor } from "./types";

const owner: Actor = { userId: "owner", role: "owner" };
const member: Actor = { userId: "member", role: "member" };
const other: Actor = { userId: "other", role: "member" };

const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);
const ctx = (actor: Actor) => ({ actor, agentId: "companybot", memory: {} as MemoryStore, skills: skillCatalog });

describe("tool visibility", () => {
	it("gives owners every tool the agent grants", () => {
		expect(visible(describeToolAccess(companybot, owner))).toEqual(companybot.tools);
	});

	it("hides owner-only tools from members", () => {
		expect(describeToolAccess(companybot, member).find((a) => a.id === "memory.remember_for_team")).toEqual({
			id: "memory.remember_for_team",
			visible: false,
			reason: "role",
		});
	});

	it("limits an agent to the tools it was granted", () => {
		expect(visible(describeToolAccess(scribe, owner))).toEqual(["memory.search", "skills.load"]);
	});

	it("only sends visible tools to the model", () => {
		expect(Object.keys(buildToolSet(companybot, ctx(member)))).toEqual([
			"memory_search",
			"memory_remember",
			"clock_now",
			"skills_load",
		]);
	});
});

describe("skills", () => {
	const load = builtinTools.find((t) => t.id === "skills.load")!;

	it("loads only installed skills", async () => {
		const installed = { ...ctx(owner), skills: skillCatalog.slice(0, 1) };
		expect(await load.execute({ id: "meeting-notes" }, installed)).toHaveProperty("instructions");
		expect(await load.execute({ id: "email-reply" }, installed)).toHaveProperty("error");
	});

	it("lists skills for the agent, or nothing when none are installed", () => {
		expect(skillsIndex([])).toBe("");
		expect(skillsIndex(skillCatalog)).toContain("- meeting-notes:");
	});
});

describe("memory permissions", () => {
	const team: Memory = { id: "t", scope: "workspace", ownerId: null, content: "", updatedAt: "", updatedBy: "owner" };
	const mine: Memory = { ...team, id: "m", scope: "personal", ownerId: "member" };

	it("lets members edit only their own personal memories", () => {
		expect(canCreateMemory(member, "workspace")).toBe(false);
		expect(canCreateMemory(member, "personal")).toBe(true);
		expect(canEditMemory(member, team)).toBe(false);
		expect(canEditMemory(member, mine)).toBe(true);
		expect(canEditMemory(other, mine)).toBe(false);
	});

	it("keeps personal memories private from other members but not owners", () => {
		expect(canReadMemory(other, mine)).toBe(false);
		expect(canReadMemory(other, team)).toBe(true);
		expect(canReadMemory(owner, mine)).toBe(true);
		expect(canEditMemory(owner, mine)).toBe(true);
	});
});
