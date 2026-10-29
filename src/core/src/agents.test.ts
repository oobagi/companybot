import { scribe } from "../test/fixtures";
import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess, resolveTools, validateAgentConfig } from "./agents";
import { blankAgent, companybot } from "./default-agents";
import { isGranted, modelToolName } from "./tools";
import { isWidgetToolName } from "./widgets";

import { owner, member, ctx } from "../test/helpers";

const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);

describe("tool visibility", () => {
	it("gives owners every tool the agent grants", () => {
		expect(visible(describeToolAccess(companybot, owner)).sort()).toEqual([
			"memory.search",
			"memory.remember",
			"memory.remember_for_team",
			"memory.update",
			"memory.forget",
			"clock.now",
			"skills.load",
			"skills.create",
			"skills.edit",
			"widgets.table",
			"widgets.stats",
			"widgets.card",
			"chat.react",
			"chat.read",
			"chat.search",
			"automations.list",
			"automations.create",
			"automations.set_mine",
			"records.types",
			"records.find",
			"records.get",
			"records.history",
			"records.save",
			"records.undo",
			"records.save_field",
			"records.save_database",
			"records.views",
			"records.save_view",
			"pages.find",
			"pages.read",
			"pages.write",
			"web.search",
			"web.fetch",
			"chat.manage", "channels.manage", "automations.manage", "automations.remove", "skills.manage", "skills.remove", "members.invite", "members.remove", "workspace.settings", "agents.manage",
		].sort());
		expect(resolveTools(companybot, owner).map((t) => t.id)).toContain("memory.forget");
	});

	it("hides owner-only tools from members", () => {
		const agent = { tools: ["records.save_database"] };
		expect(describeToolAccess(agent, member)).toEqual([{ id: "records.save_database", visible: false, reason: "role" }]);
		expect(resolveTools(companybot, member).map((t) => t.id)).not.toContain("records.save_database");
		expect(resolveTools(companybot, member).map((t) => t.id)).toContain("memory.remember_for_team");
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
			"chat.react",
			"chat.read",
		]);
	});

	it("only sends visible tools to the model", () => {
		expect(Object.keys(buildToolSet(companybot, ctx(member))).sort()).toEqual([
			"memory_search",
			"memory_remember",
			"memory_remember_for_team",
			"memory_update",
			"memory_forget",
			"clock_now",
			"skills_load",
			"skills_create",
			"skills_edit",
			"widgets_table",
			"widgets_stats",
			"widgets_card",
			"chat_react",
			"chat_read",
			"chat_search",
			"automations_list",
			"automations_create",
			"automations_set_mine",
			"records_types",
			"records_find",
			"records_get",
			"records_history",
			"records_save",
			"records_undo",
			"records_save_field",
			"records_views",
			"records_save_view",
			"pages_find",
			"pages_read",
			"pages_write",
			"web_search",
			"web_fetch",
			"chat_manage", "channels_manage", "automations_manage", "automations_remove", "skills_manage", "skills_remove", "workspace_settings", "agents_manage",
		].sort());
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
