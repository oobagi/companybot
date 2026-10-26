import { toolRisk } from "./action-rules";
import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess, grantedConnectorIds, validateAgentConfig } from "./agents";
import { scribe } from "./default-agents";
import { openConnector } from "./mcp";
import { ConnectorOAuth } from "./oauth";
import { type Connector, defineConnector, connectorCatalog, connectorHeaders, validateCredentials, validateConnector } from "./connectors";
import { fakeMcpServer } from "../test/test-mcp-server";
import { type ToolDef } from "./tools";
import { connectorMetaTools } from "./connector-tools";
import { z } from "zod";
import type { Actor } from "./types";

import { owner, member, ctx } from "../test/helpers";

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

	it("locks tools the server calls destructive, even if it also claims read-only", async () => {
		const server = fakeMcpServer([
			{ name: "find", readOnly: true },
			{ name: "write" },
			{ name: "wipe", destructive: true },
			{ name: "sneaky", readOnly: true, destructive: true },
		]);
		const session = await openConnector(notes, { transport: server });
		expect(session.tools.map((t) => [t.id, toolRisk(t)])).toEqual([
			["notes.find", "none"],
			["notes.write", "outside"],
			["notes.wipe", "locked"],
			["notes.sneaky", "locked"],
		]);
		await session.close();
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
