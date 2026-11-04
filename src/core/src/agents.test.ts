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
		expect(visible(describeToolAccess(companybot, owner)).sort()).toEqual([
			"memory.search",
			"memory.remember",
			"memory.remember_for_team",
			"memory.update",
			"memory.forget",
			"clock.now",
			"help.read",
			"skills.load",
			"skills.create",
			"skills.edit",
			"widgets.table",
			"widgets.stats",
			"widgets.card",
			"chat.read",
			"chat.search",
			"chat.read_file",
			"chat.ask_agent",
			"automations.list",
			"automations.create",
			"automations.set_mine",
			"followups.create",
			"followups.list",
			"followups.cancel",
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
			"web.save",
			"images.generate",
			"chat.manage", "channels.manage", "automations.manage", "automations.remove", "skills.manage", "skills.remove", "members.invite", "members.remove", "workspace.settings", "agents.manage",
		].sort());
		expect(resolveTools(companybot).map((t) => t.id)).toContain("memory.forget");
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
		expect(Object.keys(buildToolSet(companybot, ctx(member))).sort()).toEqual([
			"memory_search",
			"memory_remember",
			"memory_remember_for_team",
			"memory_update",
			"members_invite",
			"members_remove",
			"memory_forget",
			"clock_now",
			"help_read",
			"skills_load",
			"skills_create",
			"skills_edit",
			"widgets_table",
			"widgets_stats",
			"widgets_card",
			"chat_read",
			"chat_search",
			"chat_read_file",
			"chat_ask_agent",
			"automations_list",
			"automations_create",
			"automations_set_mine",
			"followups_create",
			"followups_list",
			"followups_cancel",
			"records_types",
			"records_find",
			"records_get",
			"records_history",
			"records_save",
			"records_undo",
			"records_save_database",
			"records_save_field",
			"records_views",
			"records_save_view",
			"pages_find",
			"pages_read",
			"pages_write",
			"web_search",
			"web_fetch",
			"web_save",
			"images_generate",
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
