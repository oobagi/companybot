import type { AutomationStore } from "./automation-tools";
import { describe, expect, it } from "vitest";
import { ACTIVITY_MAX_CHARS, clipJson, describeCall } from "./activity";
import { formatLocalTime, resolveTimeZone, shortStamp } from "./time";
import { buildToolSet, describeToolAccess, grantedConnectorIds, resolveTools, validateAgentConfig } from "./agents";
import { builtinTools } from "./builtin-tools";
import { describeTrigger, findAutomation, isValidTimeZone, scheduleDue } from "./automations";
import { blankAgent, companybot, scribe } from "./default-agents";
import type { ChatStore, Participant } from "./chat";
import { type Memory, type MemoryStore, canCreateMemory, canEditMemory, canReadMemory } from "./memory";
import { openConnector } from "./mcp";
import { ConnectorOAuth } from "./oauth";
import { can, canManageChannel, permissions } from "./permissions";
import { type Connector, defineConnector, connectorCatalog, connectorHeaders, validateCredentials, validateConnector } from "./connectors";
import {
	SKILL_DESCRIPTION_MAX,
	SKILL_NAME_MAX,
	customSkill,
	customSkillError,
	skillCatalog,
	skillsIndex,
} from "./skills";
import { fakeMcpServer } from "./test-mcp-server";
import { platformGuide } from "./guide";
import { addStep, emptyUsage, gatewayCost } from "./usage";
import { type ToolDef, createResultStore, isGranted, modelToolName } from "./tools";
import { connectorMetaTools } from "./connector-tools";
import { z } from "zod";
import { type PlaceMessage, type TurnPromptInput, buildTurnInput, buildTurnPrompt } from "./turn-input";
import { describeWidget, isWidgetResult, isWidgetToolName, widgetTools } from "./widgets";
import type { Actor } from "./types";

const owner: Actor = { userId: "owner", role: "owner" };
const member: Actor = { userId: "member", role: "member" };
const other: Actor = { userId: "other", role: "member" };

const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);
const ctx = (actor: Actor) => ({
	actor,
	agentId: "companybot",
	memory: {} as MemoryStore,
	chat: {} as ChatStore,
	skills: skillCatalog,
	results: createResultStore(),
	automations: {} as AutomationStore,
});

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
			"widgets.card",
			"chat.react",
			"chat.read",
			"chat.search",
			"automations.list",
			"automations.create",
			"automations.set_mine",
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
		expect(Object.keys(buildToolSet(companybot, ctx(member)))).toEqual([
			"memory_search",
			"memory_remember",
			"memory_update",
			"memory_forget",
			"clock_now",
			"skills_load",
			"widgets_table",
			"widgets_stats",
			"widgets_card",
			"chat_react",
			"chat_read",
			"chat_search",
			"automations_list",
			"automations_create",
			"automations_set_mine",
		]);
	});

	it("gives model-safe tool names", () => {
		expect(modelToolName("gmail.send.v2")).toBe("gmail_send_v2");
		expect(isWidgetToolName(modelToolName("widgets.table"))).toBe(true);
		expect(isWidgetToolName("memory_search")).toBe(false);
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

	it("checks skills people make, and shapes them like catalog ones", () => {
		const ok = { name: " Quotes ", description: "Chase quotes.", instructions: "Be brief. " };
		expect(customSkillError(ok)).toBeNull();
		expect(customSkillError({ ...ok, name: "a".repeat(SKILL_NAME_MAX) })).toBeNull();
		expect(customSkillError({ ...ok, description: "a".repeat(SKILL_DESCRIPTION_MAX + 1) })).toContain("description");
		expect(customSkillError({ ...ok, name: "<b>Quotes</b>" })).toContain("tags");
		expect(customSkillError({ ...ok, description: "Use when 2 < 3" })).toBeNull();
		expect(customSkill("custom-1", ok, 3)).toEqual({
			id: "custom-1",
			name: "Quotes",
			description: "Chase quotes.",
			version: "3",
			instructions: "Be brief.",
		});
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
});

describe("connectors", () => {
	const notes: Connector = defineConnector({
		id: "notes",
		name: "Notes",
		description: "Test connector",
		version: "1.0.0",
		publisher: "Test",
		mcp: { url: "https://example.com/mcp", transport: "http" },
		connection: "personal",
		auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
		defaultRoles: ["owner"],
	});

	it("validates connectors and credentials", () => {
		expect(validateConnector(notes)).toBeNull();
		expect(validateConnector({ ...notes, id: "Not OK" })).toMatch("lowercase");
		expect(validateConnector({ ...notes, mcp: { ...notes.mcp, url: "http://evil.com" } })).toMatch("https");
		expect(validateCredentials(notes, { type: "api_key", key: " " })).toMatch("Paste");
		expect(connectorHeaders(notes, { type: "api_key", key: "abc" })).toEqual({ Authorization: "Bearer abc" });
	});

	it("checks install, role, and connection before showing connector tools", () => {
		connectorCatalog.push(notes);
		try {
			const agent = { tools: ["notes.*", "clock.now"] };
			expect(validateAgentConfig({ ...scribe, tools: agent.tools })).toBeNull();
			expect(grantedConnectorIds(agent)).toEqual(["notes"]);
			const reason = (actor: Actor, state?: { roles: Actor["role"][]; connected: boolean }) =>
				describeToolAccess(agent, actor, state ? [{ id: "notes", ...state }] : [])[0];
			expect(reason(owner)).toMatchObject({ reason: "not_installed" });
			expect(reason(member, { roles: ["owner"], connected: true })).toMatchObject({ reason: "role" });
			expect(reason(owner, { roles: ["owner"], connected: false })).toMatchObject({ reason: "not_connected" });
			expect(reason(owner, { roles: ["owner"], connected: true })).toMatchObject({ visible: true });
		} finally {
			connectorCatalog.pop();
		}
	});

	it("loads tools from an MCP server and calls them", async () => {
		const server = fakeMcpServer([{ name: "find", description: "Find notes", readOnly: true }, { name: "write" }]);
		const session = await openConnector(notes, { transport: server });
		expect(session.tools.map((t) => [t.id, t.readOnly, t.source])).toEqual([
			["notes.find", true, { type: "connector", connectorId: "notes" }],
			["notes.write", false, { type: "connector", connectorId: "notes" }],
		]);
		// Connector tools load on demand: the model gets search + call, not each tool.
		const tools = buildToolSet({ tools: ["notes.find"] }, ctx(owner), session.tools);
		expect(Object.keys(tools)).toEqual(["connectors_search", "connectors_call"]);
		const call = (name: string, input: unknown) => tools[name]!.execute!(input, { toolCallId: "1", messages: [] } as never);
		const found = (await call("connectors_search", { query: "notes" })) as { tools: { tool: string; input: unknown }[] };
		expect(found.tools.map((t) => t.tool)).toEqual(["notes.find"]);
		expect(found.tools[0]!.input).toMatchObject({ type: "object" });
		expect(await call("connectors_call", { tool: "notes.write", input: {} })).toEqual({
			error: 'No connected tool "notes.write". Use connectors_search first.',
		});
		expect(await call("connectors_call", { tool: "notes.find", input: { text: "hi" } })).toEqual({ ref: "r1", data: 'find:{"text":"hi"}' });
		expect(await session.tools[0]!.execute({ text: "hi" }, ctx(owner))).toBe('find:{"text":"hi"}');
		await session.close();
		expect(server.closed).toBe(true);
	});
});

describe("connector tool search", () => {
	const def = (name: string, description: string): ToolDef => ({
		id: `crm.crm_${name}`,
		description,
		input: z.object({}),
		source: { type: "connector", connectorId: "crm" },
		execute: async () => name,
	});
	const tools = [def("leads", "Find leads in the crm"), def("calls", "List calls in the crm"), def("send", "Send an sms from the crm")];
	const meta = connectorMetaTools(tools, [{ id: "crm", name: "CRM", instructions: "Call crm_me first." }], (t) => t.execute({}, {} as never));
	const search = async (query: string) =>
		(await meta.connectors_search!.execute!({ query }, { toolCallId: "1", messages: [] } as never)) as {
			tools: { tool: string }[];
			services?: unknown;
		};

	it("ranks by words that tell tools apart, and lists everything with notes on an empty query", async () => {
		expect((await search("crm leads")).tools.map((t) => t.tool)[0]).toBe("crm.crm_leads");
		expect((await search("crm.crm_send")).tools.map((t) => t.tool)[0]).toBe("crm.crm_send");
		const all = await search("");
		expect(all.tools).toHaveLength(3);
		expect(all.services).toEqual([{ name: "CRM", notes: "Call crm_me first." }]);
	});
});

describe("connector oauth", () => {
	it("keeps what the SDK saves, and drops one-time sign-in values when stored", async () => {
		const oauth = new ConnectorOAuth({}, "https://x.convex.site/oauth/callback", true);
		oauth.saveClientInformation({ client_id: "c1" });
		oauth.saveCodeVerifier("v");
		oauth.saveState("s");
		oauth.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
		expect(oauth.changed).toBe(true);
		expect(oauth.storedState()).toBe("s");
		expect(oauth.stored).toEqual({
			client: { client_id: "c1" },
			tokens: { access_token: "a", token_type: "Bearer", refresh_token: "r" },
		});
		oauth.invalidateCredentials("tokens");
		expect(oauth.tokens()).toBeUndefined();
	});

	it("refuses to start a sign-in during an agent turn", () => {
		const oauth = new ConnectorOAuth({}, "https://x.convex.site/oauth/callback", false);
		expect(() => oauth.redirectToAuthorization(new URL("https://auth.example.com"))).toThrow("Connect the connector again");
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

	it("shows a tool result by ref without copying rows", async () => {
		const c = ctx(owner);
		const leads = [
			{ name: "Ada", stage: "Won", owner: { email: "a@x.co" }, hot: true },
			{ name: "Grace", stage: "New", owner: null, hot: false },
		];
		// Data tools' results reach the model as { ref, data }.
		const server = fakeMcpServer([{ name: "find" }], () => JSON.stringify({ leads }));
		const crm = defineConnector({
			id: "notes",
			name: "CRM",
			description: "Test",
			version: "1.0.0",
			publisher: "Test",
			mcp: { url: "https://example.com/mcp", transport: "http" },
			connection: "personal",
			auth: { type: "none" },
		});
		const session = await openConnector(crm, { transport: server });
		const tools = buildToolSet({ tools: ["notes.find"] }, c, session.tools);
		const found = await tools.connectors_call!.execute!({ tool: "notes.find", input: {} }, { toolCallId: "1", messages: [] } as never);
		expect(found).toEqual({ ref: "r1", data: { leads } });
		await session.close();

		const from = { ref: "r1", path: "leads", fields: ["name", "owner.email", "hot"] };
		expect(await table.execute({ columns: ["Name", "Owner", "Hot"], from }, c)).toEqual({
			widget: {
				type: "table",
				props: { columns: ["Name", "Owner", "Hot"], rows: [["Ada", "a@x.co", "Yes"], ["Grace", null, "No"]] },
			},
		});
		expect(await table.execute({ columns: ["Name"], from: { ...from, path: undefined, fields: ["name"] } }, c)).toEqual({
			error: "r1 isn't a list. Its keys: leads.",
		});
		expect(await table.execute({ columns: ["Name"], from: { ref: "r9", fields: ["name"] } }, c)).toMatchObject({
			error: expect.stringContaining('No result "r9"'),
		});
	});

	it("sends the model a fixable error for ragged rows", async () => {
		const output = await table.execute({ columns: ["A", "B"], rows: [["only one"]] }, ctx(owner));
		expect(output).toEqual({ error: "Row 1 has 1 cells but there are 2 columns." });
	});

	it("teaches widgets only to agents that have them", () => {
		expect(platformGuide({ tools: ["widgets.*"] })).toContain("## Widgets");
		expect(platformGuide({ tools: ["memory.search"] })).not.toContain("## Widgets");
		expect(platformGuide({ tools: [] })).toContain("Markdown");
		expect(platformGuide({ tools: ["chat.*"] })).toContain("## Chat");
		expect(platformGuide({ tools: [] })).not.toContain("## Chat");
	});
});

describe("usage", () => {
	const step = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) =>
		({ inputTokens, outputTokens, inputTokenDetails: { cacheReadTokens } }) as Parameters<typeof addStep>[1];

	it("sums calls, and counts context as the first input plus all output", () => {
		const usage = emptyUsage("anthropic/claude-haiku-5.5");
		addStep(usage, step(1000, 50), { gateway: { cost: "0.0012" } });
		addStep(usage, step(1800, 200, 1000), { gateway: { cost: "0.0008" } });
		expect(usage).toMatchObject({ steps: 2, inputTokens: 2800, cachedInputTokens: 1000, outputTokens: 250 });
		expect(usage.contextTokens).toBe(1250);
		expect(usage.costUsd).toBeCloseTo(0.002);
	});

	it("treats a missing or odd cost as zero", () => {
		expect(gatewayCost(undefined)).toBe(0);
		expect(gatewayCost({ gateway: { cost: "n/a" } })).toBe(0);
	});
});

describe("turn input", () => {
	const ada = { type: "user" as const, id: "u1", name: "Ada" };
	const ben = { type: "user" as const, id: "u2", name: "Ben" };
	const bot = { type: "agent" as const, id: "a1", name: "Companybot" };
	const scribeP = { type: "agent" as const, id: "a2", name: "Scribe" };
	const at = (minute: number) => Date.UTC(2026, 9, 22, 15, minute);
	const msg = (id: string, author: Participant, text: string, minute: number, extra: Partial<PlaceMessage> = {}): PlaceMessage => ({
		id,
		author,
		text,
		time: at(minute),
		...extra,
	});
	const base: TurnPromptInput = {
		agentId: "a1",
		place: { kind: "channel", name: "sales", private: false, topic: "Deals", thread: null, members: [ada, ben, bot, scribeP] },
		actor: { name: "Ada", email: "ada@co.com", role: "owner", timeZone: "America/Los_Angeles" },
		memory: "team",
		connectors: { connected: [], unavailable: [] },
		messages: [
			msg("m1", ben, "Morning", 1, { replyCount: 3 }),
			msg("m2", scribeP, "Draft is up", 2, { edited: true }),
			msg("m3", ada, "@Companybot status?", 3),
			msg("m4", ben, "Also this", 4),
		],
		triggerId: "m3",
	};

	it("says where you are, lists what's new, and marks the trigger last", () => {
		expect(buildTurnPrompt(base)).toBe(
			[
				"Where you are: #sales, a public channel. Topic: Deals.",
				"Here: Ada, Ben (people); Scribe (agents).",
				"Ada <ada@co.com>, a workspace owner, asked for you. You act with their access. Their time zone: America/Los_Angeles.",
				"Memory: team memories only. 2+ people can read this chat, so personal memories are off.",
				"",
				"New here since your last reply (times in America/Los_Angeles):",
				"[Ben 10-22 08:01] Morning (3 replies in thread m1)",
				"[Scribe 10-22 08:02] Draft is up (edited)",
				"[Ben 10-22 08:04] Also this",
				"",
				"Reply to this message from Ada:",
				"[Ada 10-22 08:03] @Companybot status?",
			].join("\n"),
		);
	});

	it("names DMs, starts a thread's first turn with its parent, and caps long backlogs", () => {
		const many = Array.from({ length: 60 }, (_, i) => msg(`x${i}`, ben, `n${i}`, i % 60));
		const prompt = buildTurnPrompt({
			...base,
			place: { kind: "dm", name: null, private: true, topic: null, members: [ben, bot], thread: { parent: msg("p", ben, "Plan", 0), first: true } },
			memory: "personal",
			connectors: { connected: [], unavailable: ["CRM"] },
			messages: [...many, msg("t", ben, "Go", 59)],
			triggerId: "t",
		});
		expect(prompt).toContain("Where you are: a DM with Ben, in a thread.");
		expect(prompt).toContain("Memory: personal and team memories.");
		expect(prompt).toContain("Unavailable this turn, so you can't use them: CRM.");
		expect(prompt).toContain("The thread is under this message:\n[Ben 10-22 08:00] Plan");
		expect(prompt).toContain("(10 earlier messages not shown. Use chat_read for them.)");
		expect(prompt).not.toContain("] n9\n");
		expect(prompt).toContain("] n10\n");
	});

	it("replays past turns exactly and keeps the system prompt free of per-turn content", () => {
		const input = buildTurnInput({
			agent: { instructions: "Be brief.", tools: ["chat.*"] },
			skills: [],
			session: { summary: "- Talked about Q4", turns: [{ prompt: "P1", reply: "R1" }, { prompt: "P2", reply: "" }] },
			prompt: "P3",
		});
		expect(input.instructions).toBe(`Be brief.\n\n${platformGuide({ tools: ["chat.*"] })}`);
		expect(input.messages).toEqual([
			{ role: "user", content: "Summary of your earlier turns here:\n- Talked about Q4\n\nP1" },
			{ role: "assistant", content: "R1" },
			{ role: "user", content: "P2" },
			{ role: "assistant", content: "(No reply.)" },
			{ role: "user", content: "P3" },
		]);
	});
});

describe("automations", () => {
	const brief = findAutomation("morning-brief")!;
	// Thu 2026-10-22, 15:30 UTC = 08:30 in Los Angeles.
	const thursday = Date.UTC(2026, 9, 22, 15, 30);
	const la = "America/Los_Angeles";

	it("runs a schedule once a day, after its time, on its days", () => {
		expect(scheduleDue(brief.trigger, thursday, la, undefined)).toBe("2026-10-22");
		expect(scheduleDue(brief.trigger, thursday, la, "2026-10-22")).toBeNull();
		expect(scheduleDue(brief.trigger, thursday - 60 * 60_000, la, undefined)).toBeNull(); // 7:30
		expect(scheduleDue(brief.trigger, thursday + 2 * 86_400_000, la, undefined)).toBeNull(); // Saturday
	});

	it("never schedules event automations", () => {
		expect(scheduleDue(findAutomation("after-call-summary")!.trigger, thursday, la, undefined)).toBeNull();
	});

	it("describes triggers plainly", () => {
		expect(describeTrigger(brief.trigger)).toBe("Weekdays at 8:00 AM");
		expect(isValidTimeZone(la)).toBe(true);
		expect(isValidTimeZone("Mars/Base")).toBe(false);
	});
});

describe("activity log", () => {
	const notesFind: ToolDef = {
		id: "notes.find",
		description: "Find notes",
		input: z.object({}),
		readOnly: true,
		source: { type: "connector", connectorId: "notes" },
		execute: async () => [],
	};
	const tools = [...builtinTools, notesFind];

	it("logs calls by tool id, and connector calls as the tool they ran", () => {
		expect(describeCall(modelToolName("memory.remember"), { content: "x" }, tools)).toEqual({
			tool: "memory.remember",
			input: { content: "x" },
			changes: true,
		});
		expect(describeCall(modelToolName("clock.now"), {}, tools)?.changes).toBe(false);
		expect(describeCall("connectors_call", { tool: "notes.find", input: { q: "a" } }, tools)).toEqual({
			tool: "notes.find",
			input: { q: "a" },
			changes: false,
		});
		expect(describeCall("connectors_call", { tool: "notes.gone", input: {} }, tools)?.changes).toBe(true);
	});

	it("skips widgets and tool search", () => {
		expect(describeCall(modelToolName("widgets.table"), {}, tools)).toBeNull();
		expect(describeCall("connectors_search", { query: "" }, tools)).toBeNull();
	});

	it("cuts long values", () => {
		expect(clipJson({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(clipJson("x".repeat(ACTIVITY_MAX_CHARS + 10))).toHaveLength(ACTIVITY_MAX_CHARS + "\n… (cut)".length);
	});
});

describe("time zones", () => {
	const la = "America/Los_Angeles";
	const t = Date.UTC(2026, 9, 23, 3, 27);

	it("uses the picked zone, else the computer's, else UTC", () => {
		expect(resolveTimeZone(la, "Europe/Paris")).toBe(la);
		expect(resolveTimeZone(null, "Europe/Paris")).toBe("Europe/Paris");
		expect(resolveTimeZone("Mars/Base", undefined)).toBe("UTC");
	});

	it("formats times in the person's zone", () => {
		expect(formatLocalTime(t, la)).toBe("Thursday, October 22, 2026 at 8:27 PM PDT");
		expect(shortStamp(t, la)).toBe("10-22 20:27");
		expect(shortStamp(t, "UTC")).toBe("10-23 03:27");
	});

	it("tells the time in the person's zone", async () => {
		const clock = builtinTools.find((x) => x.id === "clock.now")!;
		const result = (await clock.execute({}, { ...ctx(owner), timeZone: la })) as { local: string; timeZone: string };
		expect(result.timeZone).toBe(la);
		expect(result.local).toMatch(/P[DS]T$/);
	});
});
