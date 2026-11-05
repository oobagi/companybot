import { describe, expect, it } from "vitest";
import { scribe } from "../test/fixtures";
import { grantedConnectorIds, validateAgentConfig } from "./agents";
import { type CustomConnectorInput, type PinnedNetwork, connectorFetch, customConnector, customConnectorId, customUrlProblem, validateConnector, validateCustomConnector } from "./connectors";
import { openConnector } from "./mcp";
import { startSignIn } from "./oauth";

const input: CustomConnectorInput = {
	name: "Tickets",
	description: "",
	url: "https://mcp.tickets.example/mcp",
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

	it("gets ids that never collide with the catalog's or repeat", () => {
		const ids = Array.from({ length: 50 }, () => customConnectorId("Tickets!", []));
		for (const id of ids) expect(id).toMatch(/^custom-tickets-[a-z0-9]{6}$/);
		expect(new Set(ids).size).toBe(50);
		// A taken one is never handed out again.
		const draws = [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
		expect(customConnectorId("Tickets", ["custom-tickets-aaaaaa"], () => draws.shift()!)).toBe("custom-tickets-ssssss");
		expect(customConnectorId("日本", [])).toMatch(/^custom-connector-[a-z0-9]{6}$/);
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
	function network(answers: (host: string, nth: number) => string[]) {
		const resolved: string[] = [];
		const sent: { url: string; addresses: string[]; method: string; body?: string }[] = [];
		const net: PinnedNetwork = {
			resolve: async (host) => {
				resolved.push(host);
				return answers(host, resolved.length);
			},
			request: async (url, addresses, init) => {
				sent.push({ url: url.href, addresses, method: init.method, ...(init.body && { body: new TextDecoder().decode(init.body) }) });
				return url.pathname === "/moved" ? new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }) : new Response("{}");
			},
		};
		return { resolved, sent, net };
	}

	it("looks each host up once per connection and sends every request to the checked addresses", async () => {
		// Public first, private on any later lookup: the later answer must never be used.
		const { resolved, sent, net } = network((_host, nth) => (nth === 1 ? ["93.184.216.34"] : ["169.254.169.254"]));
		const f = connectorFetch(net);
		await f("https://mcp.tickets.example/mcp", { method: "POST", body: '{"a":1}' });
		await f("https://mcp.tickets.example/mcp", { method: "POST", body: new URLSearchParams({ code: "x" }) });
		expect(resolved).toEqual(["mcp.tickets.example"]);
		expect(sent).toEqual([
			{ url: "https://mcp.tickets.example/mcp", addresses: ["93.184.216.34"], method: "POST", body: '{"a":1}' },
			{ url: "https://mcp.tickets.example/mcp", addresses: ["93.184.216.34"], method: "POST", body: "code=x" },
		]);
		// The next connection looks up again, and refuses what it gets.
		await expect(connectorFetch(net)("https://mcp.tickets.example/mcp")).rejects.toThrow("private or local");
		expect(sent).toHaveLength(2);
	});

	it("refuses private hosts, http and redirects, and never opens event streams", async () => {
		const { sent, net } = network((host) => (host === "auth.tickets.example" ? ["10.0.0.2"] : ["93.184.216.34"]));
		const f = connectorFetch(net);
		await expect(f("https://auth.tickets.example/.well-known/oauth-authorization-server")).rejects.toThrow("private or local");
		await expect(f("https://169.254.169.254/latest/meta-data")).rejects.toThrow("private or local");
		await expect(f("http://mcp.tickets.example/mcp")).rejects.toThrow("https");
		await expect(f("https://mcp.tickets.example/moved")).rejects.toThrow("redirected");
		const stream = await f("https://mcp.tickets.example/mcp", { headers: { accept: "text/event-stream" } });
		expect(stream.status).toBe(405);
		expect(sent.map((r) => r.url)).toEqual(["https://mcp.tickets.example/moved"]);
	});
});
