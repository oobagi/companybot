import { describe, expect, it } from "vitest";
import { scribe } from "../test/fixtures";
import { grantedConnectorIds, validateAgentConfig } from "./agents";
import { type CustomConnectorInput, connectorFetch, customConnector, customConnectorId, customUrlProblem, validateConnector, validateCustomConnector } from "./connectors";
import { openConnector } from "./mcp";
import { startSignIn } from "./oauth";

const input: CustomConnectorInput = {
	name: "Tickets",
	description: "",
	url: "https://mcp.tickets.example/mcp",
	transport: "http",
	connection: "workspace",
	auth: { type: "api_key", header: "X-API-Key", label: "API key" },
};

describe("custom connectors", () => {
	it.each([
		["https://mcp.tickets.example/mcp", null],
		["https://93.184.216.34/mcp", null],
		["https://[2606:4700:4700::1111]/mcp", null],
		["http://mcp.tickets.example/mcp", "https"],
		["https://localhost:8443/mcp", "private or local"],
		["https://LOCALHOST./mcp", "private or local"],
		["https://printer.local/mcp", "private or local"],
		["https://metadata.google.internal/", "private or local"],
		["https://router/mcp", "private or local"],
		["https://127.1/mcp", "private or local"],
		["https://2130706433/mcp", "private or local"],
		["https://172.16.5.4/mcp", "private or local"],
		["https://100.64.0.1/mcp", "private or local"],
		["https://169.254.169.254/", "private or local"],
		["https://[fe80::1]/mcp", "private or local"],
		["https://[::ffff:10.0.0.1]/mcp", "private or local"],
		["https://a:b@mcp.tickets.example/", "username and password"],
		["mcp.tickets.example", "valid URL"],
	])("%s → %s", (url, problem) => {
		const found = customUrlProblem(url);
		if (problem === null) expect(found).toBeNull();
		else expect(found).toMatch(problem);
	});

	it("checks the sign-in fields", () => {
		expect(validateCustomConnector(input)).toBeNull();
		expect(validateCustomConnector({ ...input, name: " " })).toMatch("name");
		expect(validateCustomConnector({ ...input, auth: { ...input.auth, header: "Bad Header" } as CustomConnectorInput["auth"] })).toMatch("header name");
		expect(validateCustomConnector({ ...input, auth: { type: "api_key", header: "Host", label: "Key" } })).toMatch("set by the connection");
		expect(validateCustomConnector({ ...input, auth: { type: "api_key", header: "Authorization", prefix: "Bearer\r\nX: y", label: "Key" } })).toMatch("one line");
		expect(validateCustomConnector({ ...input, auth: { type: "api_key", header: "Authorization", label: "" } })).toMatch("Name the key");
	});

	it("gets ids that never collide with the catalog's", () => {
		expect(customConnectorId("Tickets!", [])).toBe("custom-tickets");
		expect(customConnectorId("Tickets", ["custom-tickets"])).toBe("custom-tickets-2");
		expect(customConnectorId("日本", [])).toBe("custom-connector");
		expect(validateConnector({ ...customConnector("custom-x", input), custom: undefined })).toMatch("can't start");
	});

	it("is granted and loaded like a catalog connector, for the workspace that has it", () => {
		const tickets = customConnector("custom-tickets", input);
		const agent = { ...scribe, tools: ["custom-tickets.*", "clock.now"] };
		expect(validateAgentConfig(agent)).toMatch("Unknown tool");
		expect(validateAgentConfig(agent, undefined, [tickets])).toBeNull();
		expect(grantedConnectorIds(agent)).toEqual(["custom-tickets"]);
	});

	it("never connects without the checked fetch", async () => {
		const tickets = customConnector("custom-tickets", input);
		await expect(openConnector(tickets, { credentials: { type: "none" } })).rejects.toThrow("checked fetch");
		await expect(startSignIn({ ...tickets, auth: { type: "oauth" } }, "https://cb.example/oauth/callback")).rejects.toThrow("checked fetch");
	});
});

describe("connectorFetch", () => {
	function network(answers: Record<string, string[]>) {
		const resolved: string[] = [];
		const sent: { url: string; redirect?: RequestRedirect }[] = [];
		const resolve = async (host: string) => {
			resolved.push(host);
			return answers[host] ?? [];
		};
		const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
			sent.push({ url: String(input), redirect: init?.redirect });
			return new Response("{}");
		}) as typeof fetch;
		return { resolved, sent, resolve, base };
	}

	it("resolves each host once per connection, refuses private answers, and never follows redirects", async () => {
		const net = network({ "mcp.tickets.example": ["93.184.216.34"], "auth.tickets.example": ["10.0.0.2"] });
		const f = connectorFetch(net.resolve, net.base);
		await f("https://mcp.tickets.example/mcp", { method: "POST" });
		await f("https://mcp.tickets.example/mcp", { method: "POST" });
		expect(net.resolved).toEqual(["mcp.tickets.example"]);
		expect(net.sent).toEqual([
			{ url: "https://mcp.tickets.example/mcp", redirect: "error" },
			{ url: "https://mcp.tickets.example/mcp", redirect: "error" },
		]);
		// OAuth discovery pointing somewhere private, by name or by address, or over http.
		await expect(f("https://auth.tickets.example/.well-known/oauth-authorization-server")).rejects.toThrow("private or local");
		await expect(f("https://169.254.169.254/latest/meta-data")).rejects.toThrow("private or local");
		await expect(f("http://mcp.tickets.example/mcp")).rejects.toThrow("https");
		expect(net.sent).toHaveLength(2);
	});

	it("checks again on the next connection, so a name repointed inward is caught", async () => {
		const answers: Record<string, string[]> = { "mcp.tickets.example": ["93.184.216.34"] };
		const net = network(answers);
		await connectorFetch(net.resolve, net.base)("https://mcp.tickets.example/mcp");
		answers["mcp.tickets.example"] = ["93.184.216.34", "127.0.0.1"];
		await expect(connectorFetch(net.resolve, net.base)("https://mcp.tickets.example/mcp")).rejects.toThrow("private or local");
		expect(net.sent).toHaveLength(1);
	});
});
