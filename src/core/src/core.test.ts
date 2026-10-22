import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess, grantedPluginIds, resolveTools, validateAgentConfig } from "./agents";
import { builtinTools } from "./builtin-tools";
import { blankAgent, companybot, scribe } from "./default-agents";
import { type Memory, type MemoryStore, canCreateMemory, canEditMemory, canReadMemory } from "./memory";
import { openPlugin } from "./mcp";
import { can, permissions } from "./permissions";
import { type Plugin, definePlugin, pluginCatalog, pluginHeaders, validateCredentials, validatePlugin } from "./plugins";
import { skillCatalog, skillsIndex } from "./skills";
import { fakeMcpServer } from "./test-mcp-server";
import { platformGuide } from "./guide";
import { isGranted, modelToolName } from "./tools";
import { describeWidget, isWidgetResult, widgetTools } from "./widgets";
import type { Actor } from "./types";

const owner: Actor = { userId: "owner", role: "owner" };
const member: Actor = { userId: "member", role: "member" };
const other: Actor = { userId: "other", role: "member" };

const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);
const ctx = (actor: Actor) => ({ actor, agentId: "companybot", memory: {} as MemoryStore, skills: skillCatalog });

describe("tool visibility", () => {
	it("gives owners every tool the agent grants", () => {
		expect(visible(describeToolAccess(companybot, owner))).toEqual([
			"memory.search",
			"memory.remember",
			"memory.remember_for_team",
			"memory.update",
			"memory.forget",
			"clock.now",
			"skills.load",
			"widgets.table",
			"widgets.stats",
		]);
		expect(resolveTools(companybot, owner).map((t) => t.id)).toContain("memory.forget");
	});

	it("hides owner-only tools from members", () => {
		const agent = { tools: ["memory.remember_for_team"] };
		expect(describeToolAccess(agent, member)).toEqual([{ id: "memory.remember_for_team", visible: false, reason: "role" }]);
		expect(resolveTools(companybot, member).map((t) => t.id)).not.toContain("memory.remember_for_team");
	});

	it("covers a whole group with a wildcard grant", () => {
		expect(isGranted(["memory.*"], "memory.search")).toBe(true);
		expect(isGranted(["memory.*"], "clock.now")).toBe(false);
		expect(isGranted(["gmail.*"], "gmail.send")).toBe(true);
	});

	it("limits an agent to the tools it was granted", () => {
		expect(visible(describeToolAccess(scribe, owner))).toEqual(["memory.search", "skills.load", "widgets.table", "widgets.stats"]);
	});

	it("only sends visible tools to the model", () => {
		expect(Object.keys(buildToolSet(companybot, ctx(member)))).toEqual([
			"memory_search",
			"memory_remember",
			"memory_update",
			"memory_forget",
			"clock_now",
			"skills_load",
			"widgets_table",
			"widgets_stats",
		]);
	});

	it("gives model-safe tool names", () => {
		expect(modelToolName("gmail.send.v2")).toBe("gmail_send_v2");
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

	it("keeps personal memories private from other members but not owners", () => {
		expect(canReadMemory(other, mine)).toBe(false);
		expect(canReadMemory(other, team)).toBe(true);
		expect(canReadMemory(owner, mine)).toBe(true);
		expect(canEditMemory(owner, mine)).toBe(true);
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

describe("permissions", () => {
	it("gives owners everything and members only what's listed", () => {
		for (const p of Object.keys(permissions) as (keyof typeof permissions)[]) expect(can(owner, p)).toBe(true);
		expect(can(member, "plugins.connect")).toBe(true);
		expect(can(member, "agents.manage")).toBe(false);
	});
});

describe("plugins", () => {
	const notes: Plugin = definePlugin({
		id: "notes",
		name: "Notes",
		description: "Test plugin",
		version: "1.0.0",
		publisher: "Test",
		mcp: { url: "https://example.com/mcp", transport: "http" },
		connection: "personal",
		auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
		defaultRoles: ["owner"],
	});

	it("validates plugins and credentials", () => {
		expect(validatePlugin(notes)).toBeNull();
		expect(validatePlugin({ ...notes, id: "Not OK" })).toMatch("lowercase");
		expect(validatePlugin({ ...notes, mcp: { ...notes.mcp, url: "http://evil.com" } })).toMatch("https");
		expect(validateCredentials(notes, { type: "api_key", key: " " })).toMatch("Paste");
		expect(pluginHeaders(notes, { type: "api_key", key: "abc" })).toEqual({ Authorization: "Bearer abc" });
	});

	it("checks install, role, and connection before showing plugin tools", () => {
		pluginCatalog.push(notes);
		try {
			const agent = { tools: ["notes.*", "clock.now"] };
			expect(validateAgentConfig({ ...scribe, tools: agent.tools })).toBeNull();
			expect(grantedPluginIds(agent)).toEqual(["notes"]);
			const reason = (actor: Actor, state?: { roles: Actor["role"][]; connected: boolean }) =>
				describeToolAccess(agent, actor, state ? [{ id: "notes", ...state }] : [])[0];
			expect(reason(owner)).toMatchObject({ reason: "not_installed" });
			expect(reason(member, { roles: ["owner"], connected: true })).toMatchObject({ reason: "role" });
			expect(reason(owner, { roles: ["owner"], connected: false })).toMatchObject({ reason: "not_connected" });
			expect(reason(owner, { roles: ["owner"], connected: true })).toMatchObject({ visible: true });
		} finally {
			pluginCatalog.pop();
		}
	});

	it("loads tools from an MCP server and calls them", async () => {
		const server = fakeMcpServer([{ name: "find", description: "Find notes", readOnly: true }, { name: "write" }]);
		const session = await openPlugin(notes, { transport: server });
		expect(session.tools.map((t) => [t.id, t.readOnly, t.source])).toEqual([
			["notes.find", true, { type: "plugin", pluginId: "notes" }],
			["notes.write", false, { type: "plugin", pluginId: "notes" }],
		]);
		const tools = buildToolSet({ tools: ["notes.find"] }, ctx(owner), session.tools);
		expect(Object.keys(tools)).toEqual(["notes_find"]);
		expect(await session.tools[0]!.execute({ text: "hi" }, ctx(owner))).toEqual({ result: 'find:{"text":"hi"}' });
		await session.close();
		expect(server.closed).toBe(true);
	});
});

describe("widgets", () => {
	const table = widgetTools.find((t) => t.id === "widgets.table")!;

	it("returns a widget for the app and a short receipt for the model", async () => {
		const props = { title: "Leads", columns: ["Name", "Stage"], rows: [["Ada", "Won"]] };
		const output = await table.execute(props, ctx(owner));
		expect(output).toEqual({ widget: { type: "table", props } });
		expect(isWidgetResult(output)).toBe(true);
		const receipt = await table.toModelOutput!({ toolCallId: "1", input: props, output } as never);
		expect(receipt).toMatchObject({ type: "text" });
		expect(describeWidget({ type: "table", props })).toBe('[You showed a table "Leads" with 1 rows (Name, Stage) widget]');
	});

	it("sends the model a fixable error for ragged rows", async () => {
		const output = await table.execute({ columns: ["A", "B"], rows: [["only one"]] }, ctx(owner));
		expect(output).toEqual({ error: "Row 1 has 1 cells but there are 2 columns." });
	});

	it("teaches widgets only to agents that have them", () => {
		expect(platformGuide({ tools: ["widgets.*"] })).toContain("## Widgets");
		expect(platformGuide({ tools: ["memory.search"] })).not.toContain("## Widgets");
		expect(platformGuide({ tools: [] })).toContain("Markdown");
	});
});
