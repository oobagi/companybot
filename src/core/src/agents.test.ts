import { scribe } from "../test/fixtures";
import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess, resolveTools, toolApprovalPolicy, validateAgentConfig } from "./agents";
import { blankAgent, companybot } from "./default-agents";
import { isGranted, modelToolName } from "./tools";
import { isWidgetToolName } from "./widgets";

import { owner, member, ctx } from "../test/helpers";

const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);

describe("tool visibility", () => {
	it("gives owners every tool the agent grants", () => {
		const access = describeToolAccess(companybot, owner);
		expect(access.filter((a) => !a.visible)).toEqual([]);
		expect(access.map((a) => a.id)).toContain("memory.forget");
	});

	it("offers every granted built-in whatever the person's roles; a call their roles lack is checked, then refused", async () => {
		const agent = { tools: ["records.save_database"] };
		expect(describeToolAccess(agent, { ...member, permissions: [] })).toEqual([{ id: "records.save_database", visible: true }]);
		expect(resolveTools(companybot).map((t) => t.id)).toContain("records.save_database");
		const tools = resolveTools(agent);
		const message = "Only people with the Owner role can add and change databases and fields. Ask someone who has it.";
		const policy = toolApprovalPolicy(tools, async () => ({ type: "deny", by: "role", message }));
		expect(await policy({ toolCall: { toolCallId: "c1", toolName: "records_save_database", input: { name: "Deals" } } })).toEqual({
			type: "denied",
			reason: `The person you act for can't do this, so records.save_database didn't run. ${message} Tell them that; don't try it again.`,
		});
	});

	it("covers a whole group with a wildcard grant", () => {
		expect(isGranted(["memory.*"], "memory.search")).toBe(true);
		expect(isGranted(["memory.*"], "clock.now")).toBe(false);
		expect(isGranted(["gmail.*"], "gmail.send")).toBe(true);
	});

	it("limits an agent to the tools it was granted", () => {
		expect(visible(describeToolAccess(scribe, owner))).toEqual([
			"memory.search",
			"skills.load",
			"widgets.table",
			"widgets.stats",
			"widgets.card",
			"chat.read",
		]);
	});

	it("sends the same granted tools to the model whatever the person's roles", () => {
		const names = (who: typeof owner) => Object.keys(buildToolSet(companybot, ctx(who))).sort();
		expect(names(member)).toEqual(names(owner));
		expect(names(member)).toContain("records_save_database");
	});

	it("gives model-safe tool names", () => {
		expect(modelToolName("gmail.send.v2")).toBe("gmail_send_v2");
		expect(isWidgetToolName(modelToolName("widgets.table"))).toBe(true);
		expect(isWidgetToolName("memory_search")).toBe(false);
	});
});

describe("agent config", () => {
	it("accepts the defaults", () => {
		for (const agent of [companybot, scribe, blankAgent]) expect(validateAgentConfig(agent)).toBeNull();
	});

	it("rejects unknown models and tools", () => {
		expect(validateAgentConfig({ ...scribe, model: "openai/gpt-x" })).toMatch("model");
		expect(validateAgentConfig({ ...scribe, tools: ["files.delete"] })).toMatch("Unknown tool");
		expect(validateAgentConfig({ ...scribe, name: "  " })).toMatch("name");
	});
});
