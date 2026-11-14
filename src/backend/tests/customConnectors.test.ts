import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { builtInRoleOf, agentsOf, ownerAndMember, settle, signIn, workspaceOf } from "./helpers";
import "./connectorFixtures";

// No real network. DNS answers come from `dns.answer`. Custom connectors' requests go through undici
// (connectorNetwork.request), mocked here as a tiny MCP server that records which address each request
// actually connected to, by asking the request's own dispatcher, as a real connection would.
// Any other fetch is recorded and refused.
const dns = vi.hoisted(() => ({ answer: (_host: string, _nth: number): string[] => [], asked: [] as string[] }));
vi.mock("node:dns/promises", () => ({
	lookup: async (hostname: string) => {
		dns.asked.push(hostname);
		return dns.answer(hostname, dns.asked.length).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
	},
}));
type Lookup = (host: string, options: { all: true }, callback: (error: unknown, all: { address: string }[]) => void) => void;
const server = vi.hoisted(() => ({ connections: [] as { url: string; method: string; address: string }[], initializeMs: 0 }));
vi.mock("undici", () => ({
	Agent: class {
		constructor(readonly options: { connect: { lookup: Lookup } }) {}
		close = async () => {};
	},
	fetch: async (url: string, init: { method: string; body?: Uint8Array; dispatcher: { options: { connect: { lookup: Lookup } } } }) => {
		const host = new URL(url).hostname;
		const [first] = await new Promise<{ address: string }[]>((resolve, reject) => init.dispatcher.options.connect.lookup(host, { all: true }, (e, all) => (e ? reject(e) : resolve(all))));
		server.connections.push({ url, method: init.method, address: first!.address });
		const message = init.body ? JSON.parse(new TextDecoder().decode(init.body)) : null;
		const json = (reply: { result: unknown } | { error: unknown }) => ({
			status: 200,
			statusText: "OK",
			headers: new Headers({ "content-type": "application/json" }),
			body: [new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }))],
		});
		if (message?.method === "initialize" && server.initializeMs) await new Promise((r) => setTimeout(r, server.initializeMs));
		if (message?.method === "initialize") return json({ result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tickets", version: "1" } } });
		if (message?.method === "tools/list") return json({ result: { tools: [{ name: "find_ticket", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
		// An older server: it only knows initialize (the client falls back to it).
		if (message?.id !== undefined) return json({ error: { code: -32601, message: "Method not found" } });
		return { status: 202, statusText: "Accepted", headers: new Headers(), body: [] };
	},
}));
const fetched: string[] = [];
beforeEach(() => {
	fetched.length = 0;
	server.connections.length = 0;
	server.initializeMs = 0;
	dns.answer = () => [];
	dns.asked.length = 0;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		fetched.push(input instanceof Request ? input.url : String(input));
		throw new Error("No network in tests.");
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const tickets = {
	name: "Tickets",
	description: "Our support desk",
	url: "https://mcp.tickets.example/mcp",
	connection: "personal" as const,
	auth: { type: "api_key" as const, header: "Authorization", prefix: "Bearer ", label: "API key" },
};

describe("custom connectors", () => {
	it("installs for an explicitly chosen audience and rejects roles from another workspace atomically", async () => {
		const { t, owner, member } = await ownerAndMember();
		const role = (await owner.query(api.roles.list))!.find(r => r.builtIn === "member")!;
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets, roles: [role.id] });
		expect((await member.query(api.connectors.list)).find(c => c.id === id)?.canUse).toBe(true);
		const other = await signIn(t, "other-audience@example.com");
		const foreign = (await other.query(api.roles.list))!.find(r => r.builtIn === "member")!;
		await expect(owner.mutation(api.customConnectors.create, { connector: { ...tickets, name: "Wrong audience" }, roles: [foreign.id] })).rejects.toThrow("Role not found");
		expect((await owner.query(api.connectors.list)).some(c => c.name === "Wrong audience")).toBe(false);
	});

	it("only people with connectors.manage add, edit or remove them", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(member.mutation(api.customConnectors.create, { connector: tickets })).rejects.toThrow("Only people with the");
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		expect(id).toMatch(/^custom-tickets-[a-z0-9]{6}$/);
		await expect(member.mutation(api.customConnectors.update, { connectorId: id, connector: { ...tickets, name: "Mine" } })).rejects.toThrow("Only people with the");
		await expect(member.mutation(api.customConnectors.remove, { connectorId: id })).rejects.toThrow("Only people with the");

		// Added = Owners-only until a manager explicitly grants a role.
		const seen = (await member.query(api.connectors.list)).find((c) => c.id === id)!;
		expect(seen).toMatchObject({ name: "Tickets", custom: true, installed: true, canUse: false, connected: false, server: tickets.url });
		await expect(member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } })).rejects.toThrow();
		await owner.mutation(api.connectors.setRoles, { connectorId: id, roles: [await builtInRoleOf(owner, "member")] });
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } });
		expect((await member.query(api.connectors.list)).find((c) => c.id === id)?.connected).toBe(true);
		// A second one with the same name gets its own id.
		const second = await owner.mutation(api.customConnectors.create, { connector: tickets });
		expect(second).toMatch(/^custom-tickets-[a-z0-9]{6}$/);
		expect(second).not.toBe(id);
	});

	it.each([
		["http://mcp.tickets.example/mcp", "https"],
		["https://localhost/mcp", "private or local"],
		["https://api.localhost/mcp", "private or local"],
		["https://intranet/mcp", "private or local"],
		["https://metadata.google.internal/computeMetadata", "private or local"],
		["https://127.0.0.1/mcp", "private or local"],
		["https://0x7f000001/mcp", "private or local"],
		["https://10.1.2.3/mcp", "private or local"],
		["https://192.168.0.10/mcp", "private or local"],
		["https://169.254.169.254/latest/meta-data", "private or local"],
		["https://[::1]/mcp", "private or local"],
		["https://[fd00:ec2::254]/mcp", "private or local"],
		["https://[::ffff:169.254.169.254]/mcp", "private or local"],
		["https://user:pass@mcp.tickets.example/mcp", "username and password"],
		["not a url", "valid URL"],
	])("refuses %s on save", async (url, message) => {
		const { owner } = await ownerAndMember();
		await expect(owner.mutation(api.customConnectors.create, { connector: { ...tickets, url } })).rejects.toThrow(message);
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		await expect(owner.mutation(api.customConnectors.update, { connectorId: id, connector: { ...tickets, url } })).rejects.toThrow(message);
	});

	it("connects only to the address it checked: a lookup that turns private later is never used", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: { ...tickets, connection: "workspace", auth: { type: "none" } } });
		const refresh = () => owner.action(api.agent.refreshTools, { connectorId: id });
		// Public on the first lookup; the metadata address on every one after (DNS rebinding).
		dns.answer = (_host, nth) => (nth === 1 ? ["93.184.216.34"] : ["169.254.169.254"]);

		// One connection: looked up once, then every request (initialize, notifications, tools/list) goes to the checked address.
		await refresh();
		expect(dns.asked).toEqual(["mcp.tickets.example"]);
		expect(server.connections.length).toBeGreaterThanOrEqual(3);
		expect(new Set(server.connections.map((c) => c.address))).toEqual(new Set(["93.184.216.34"]));
		expect(new Set(server.connections.map((c) => c.url))).toEqual(new Set([tickets.url]));
		const tools = await t.run(async (ctx) => (await ctx.db.query("connectorTools").first())?.tools.map((tool) => tool.name));
		expect(tools).toEqual(["find_ticket"]);

		// The next connection looks up again, gets the metadata address, and sends nothing.
		const sent = server.connections.length;
		await expect(refresh()).rejects.toThrow("Couldn't reach Tickets");
		expect(dns.asked).toHaveLength(2);
		expect(server.connections).toHaveLength(sent);
		expect(server.connections.map((c) => c.address)).not.toContain("169.254.169.254");
		// Nothing went out through the runtime's own fetch either.
		expect(fetched).toEqual([]);
	});

	it("refuses private, mixed or missing answers before anything is sent", async () => {
		const { owner } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: { ...tickets, connection: "workspace", auth: { type: "none" } } });
		for (const answer of [["10.0.0.7"], ["93.184.216.34", "127.0.0.1"], ["fd00:ec2::254"], []]) {
			dns.answer = () => answer;
			await expect(owner.action(api.agent.refreshTools, { connectorId: id })).rejects.toThrow("Couldn't reach Tickets");
		}
		expect(server.connections).toEqual([]);
		expect(fetched).toEqual([]);
	});

	it("is Streamable HTTP only: a legacy SSE transport or SSE address can't be saved", async () => {
		const { owner } = await ownerAndMember();
		await expect(owner.mutation(api.customConnectors.create, { connector: { ...tickets, transport: "sse" } as typeof tickets })).rejects.toThrow("transport");
		await expect(owner.mutation(api.customConnectors.create, { connector: { ...tickets, url: "https://mcp.tickets.example/sse" } })).rejects.toThrow("Streamable HTTP only");
	});

	it("gets 20 seconds to connect, longer than a catalog connector's 10", async () => {
		vi.useFakeTimers();
		const { owner } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: { ...tickets, connection: "workspace", auth: { type: "none" } } });
		dns.answer = () => ["93.184.216.34"];
		const refresh = async (initializeMs: number) => {
			server.initializeMs = initializeMs;
			const done = owner.action(api.agent.refreshTools, { connectorId: id }).then(() => "connected", (e: Error) => e.message);
			await vi.advanceTimersByTimeAsync(30_000);
			return done;
		};
		// Past a catalog connector's 10 s, within 20 s: it still connects.
		expect(await refresh(15_000)).toBe("connected");
		expect(await refresh(25_000)).toMatch("Couldn't reach Tickets");
	});

	it("belongs to its workspace alone", async () => {
		const { t, owner } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		await owner.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "owner-key" } });
		const { scribe } = await agentsOf(owner);
		const grant = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: [`${id}.*`] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: scribe.version, config: grant });

		const other = await signIn(t, "other@else.com");
		const otherWorkspace = await workspaceOf(other);
		expect((await other.query(api.connectors.list)).map((c) => c.id)).not.toContain(id);
		await expect(other.mutation(api.connectors.setInstalled, { connectorId: id, installed: true })).rejects.toThrow("Unknown connector");
		await expect(other.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "k" } })).rejects.toThrow("Unknown connector");
		await expect(other.mutation(api.customConnectors.update, { connectorId: id, connector: tickets })).rejects.toThrow("isn't in this workspace");
		await expect(other.mutation(api.customConnectors.remove, { connectorId: id })).rejects.toThrow("isn't in this workspace");
		expect(await t.query(internal.connectors.forTurn, { userId: other.userId, workspaceId: otherWorkspace, connectorIds: [id] })).toEqual([]);
		// Another workspace's agent can't be granted it: there it names no connector.
		const theirs = await agentsOf(other);
		await other.mutation(api.agents.update, { agentId: theirs.companybot._id, expectedVersion: theirs.companybot.version, config: { ...grant, name: "Companybot", model: theirs.companybot.model } });
		expect((await agentsOf(other)).companybot.tools).not.toContain(`${id}.*`);

		// Their own, with the same name, is a different connector with its own id and server.
		const theirId = await other.mutation(api.customConnectors.create, { connector: { ...tickets, url: "https://elsewhere.example/mcp" } });
		expect(theirId).not.toBe(id);
		const servers = async () => (await t.run((ctx) => ctx.db.query("customConnectors").collect())).map((c) => [c.workspaceId, c.url]);
		expect(await servers()).toEqual([
			[await workspaceOf(owner), tickets.url],
			[otherWorkspace, "https://elsewhere.example/mcp"],
		]);
		const [mine] = await t.query(internal.connectors.forTurn, { userId: owner.userId, workspaceId: await workspaceOf(owner), connectorIds: [id] });
		expect(mine?.connector.mcp.url).toBe(tickets.url);
		// The owner's id still means nothing there, and theirs isn't connected: accounts stay in their workspace.
		expect(await t.query(internal.connectors.forTurn, { userId: other.userId, workspaceId: otherWorkspace, connectorIds: [id, theirId] })).toEqual([]);
	});

	it("starts strict when its server or sign-in changes: accounts, rules and locks go; it stays installed for the same roles", async () => {
		const { t, owner, member } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		await owner.mutation(api.connectors.setRoles, { connectorId: id, roles: [] });
		const memberRole = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!.id;
		await owner.mutation(api.connectors.setRoles, { connectorId: id, roles: [memberRole] });
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } });
		await member.mutation(api.permissions.set, { action: `${id}.close_ticket`, setting: "always" });
		await owner.mutation(api.permissions.setLock, { action: `${id}.delete_ticket`, lock: "block" });
		const rows = () =>
			t.run(async (ctx) => ({
				connections: (await ctx.db.query("connectorConnections").collect()).length,
				rules: (await ctx.db.query("permissionRules").collect()).length,
				locks: (await ctx.db.query("permissionLocks").collect()).length,
				installs: await ctx.db.query("connectorInstalls").collect(),
			}));
		const before = await rows();
		expect(before).toMatchObject({ connections: 1, rules: 1, locks: 1 });

		// A new name or description changes only that.
		expect(await owner.mutation(api.customConnectors.update, { connectorId: id, connector: { ...tickets, name: "Help desk" } })).toEqual({ reset: false });
		expect(await rows()).toEqual(before);
		expect((await member.query(api.connectors.list)).find((c) => c.id === id)).toMatchObject({ name: "Help desk", connected: true });

		// A new server: old credentials must never reach it.
		const moved = { ...tickets, name: "Help desk", url: "https://new-host.example/mcp" };
		expect(await owner.mutation(api.customConnectors.update, { connectorId: id, connector: moved })).toEqual({ reset: true });
		const after = await rows();
		expect(after.installs).toHaveLength(1);
		expect(after.installs[0]!._id).not.toBe(before.installs[0]!._id);
		expect(after.installs[0]!.roles).toEqual([memberRole]);
		// Until the old rows are gone it neither loads nor connects, so they can't be used or swept up with new ones.
		expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId, connectorIds: [id] })).toEqual([]);
		await expect(member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "k2" } })).rejects.toThrow("still being deleted");
		await settle(t);
		expect(await rows()).toMatchObject({ connections: 0, rules: 0, locks: 0 });
		expect((await member.query(api.connectors.list)).find((c) => c.id === id)).toMatchObject({ installed: true, canUse: true, connected: false, server: moved.url });
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "k2" } });
		expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId, connectorIds: [id] })).toHaveLength(1);

		// A new sign-in (here: a different header) resets it too.
		const header = { ...moved, auth: { ...tickets.auth, header: "X-API-Key", prefix: undefined } };
		expect(await owner.mutation(api.customConnectors.update, { connectorId: id, connector: header })).toEqual({ reset: true });
		await settle(t);
		expect(await rows()).toMatchObject({ connections: 0 });
		const saved = await t.run(async (ctx) => (await ctx.db.query("customConnectors").first())!.auth);
		expect(saved).toEqual({ type: "api_key", header: "X-API-Key", label: "API key" });
	});

	it("removing one uninstalls it like a catalog connector, and agents' grants of it drop on their next save", async () => {
		const { t, owner, member } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		await owner.mutation(api.connectors.setRoles, { connectorId: id, roles: [await builtInRoleOf(owner, "member")] });
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } });
		await member.mutation(api.permissions.set, { action: `${id}.close_ticket`, setting: "never" });
		const { scribe } = await agentsOf(owner);
		const config = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: [`${id}.*`, "clock.now"] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: scribe.version, config });

		await owner.mutation(api.customConnectors.remove, { connectorId: id });
		expect((await owner.query(api.connectors.list)).map((c) => c.id)).not.toContain(id);
		expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId: await workspaceOf(owner), connectorIds: [id] })).toEqual([]);
		await expect(member.mutation(api.permissions.set, { action: `${id}.close_ticket`, setting: "always" })).rejects.toThrow("Install the connector first");
		// A new one by the same name, even right away, is a new connector: the old grant doesn't reach it.
		const again = await owner.mutation(api.customConnectors.create, { connector: { ...tickets, url: "https://other-desk.example/mcp" } });
		expect(again).not.toBe(id);
		expect(await t.query(internal.connectors.forTurn, { userId: owner.userId, workspaceId: await workspaceOf(owner), connectorIds: [id] })).toEqual([]);
		await owner.mutation(api.customConnectors.remove, { connectorId: again });
		await settle(t);
		const left = await t.run(async (ctx) => ({
			custom: await ctx.db.query("customConnectors").collect(),
			installs: await ctx.db.query("connectorInstalls").collect(),
			connections: await ctx.db.query("connectorConnections").collect(),
			rules: await ctx.db.query("permissionRules").collect(),
		}));
		expect(left).toEqual({ custom: [], installs: [], connections: [], rules: [] });

		const saved = (await agentsOf(owner)).scribe;
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: saved.version, config: { ...config, name: "Scribe 2" } });
		expect((await agentsOf(owner)).list.find((a) => a._id === scribe._id)!.tools).toEqual(["clock.now"]);
	});
});
