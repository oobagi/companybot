import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentsOf, ownerAndMember, settle, signIn, workspaceOf } from "./helpers";
import "./connectorFixtures";

// No real network: DNS answers come from `dns` below, and every fetch is recorded and refused.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>(), asked: [] as string[] }));
vi.mock("node:dns/promises", () => ({
	lookup: async (hostname: string) => {
		dns.asked.push(hostname);
		return (dns.answers.get(hostname) ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
	},
}));
const fetched: string[] = [];
beforeEach(() => {
	fetched.length = 0;
	dns.answers.clear();
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
	transport: "http" as const,
	connection: "personal" as const,
	auth: { type: "api_key" as const, header: "Authorization", prefix: "Bearer ", label: "API key" },
};

describe("custom connectors", () => {
	it("only people with connectors.manage add, edit or remove them", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(member.mutation(api.customConnectors.create, { connector: tickets })).rejects.toThrow("Only people with the");
		const id = await owner.mutation(api.customConnectors.create, { connector: tickets });
		expect(id).toBe("custom-tickets");
		await expect(member.mutation(api.customConnectors.update, { connectorId: id, connector: { ...tickets, name: "Mine" } })).rejects.toThrow("Only people with the");
		await expect(member.mutation(api.customConnectors.remove, { connectorId: id })).rejects.toThrow("Only people with the");

		// Added = installed for Member, like a catalog install; members see it and connect their own account.
		const seen = (await member.query(api.connectors.list)).find((c) => c.id === id)!;
		expect(seen).toMatchObject({ name: "Tickets", custom: true, installed: true, canUse: true, connected: false, server: tickets.url });
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } });
		expect((await member.query(api.connectors.list)).find((c) => c.id === id)?.connected).toBe(true);
		// Its ids never collide with the catalog's: a second one with the same name gets its own.
		expect(await owner.mutation(api.customConnectors.create, { connector: tickets })).toBe("custom-tickets-2");
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

	it("resolves and checks the server's addresses before every connection, so a repointed name is refused", async () => {
		const { owner } = await ownerAndMember();
		const id = await owner.mutation(api.customConnectors.create, { connector: { ...tickets, connection: "workspace", auth: { type: "none" } } });
		const refresh = () => owner.action(api.agent.refreshTools, { connectorId: id });

		// A private answer: refused before anything is sent.
		dns.answers.set("mcp.tickets.example", ["10.0.0.7"]);
		await expect(refresh()).rejects.toThrow("Couldn't reach Tickets");
		expect(dns.asked).toEqual(["mcp.tickets.example"]);
		expect(fetched).toEqual([]);

		// A public answer: it connects (the test network refuses it, but requests were allowed out).
		dns.answers.set("mcp.tickets.example", ["93.184.216.34"]);
		await expect(refresh()).rejects.toThrow("Couldn't reach Tickets");
		expect(fetched.length).toBeGreaterThan(0);
		expect(new Set(fetched)).toEqual(new Set([tickets.url]));
		const sent = fetched.length;

		// The same name rebound to the metadata address: the next connection checks again and sends nothing.
		dns.answers.set("mcp.tickets.example", ["93.184.216.34", "169.254.169.254"]);
		await expect(refresh()).rejects.toThrow("Couldn't reach Tickets");
		expect(fetched).toHaveLength(sent);
		// Once per connection, not once per request or once ever.
		expect(dns.asked).toEqual(["mcp.tickets.example", "mcp.tickets.example", "mcp.tickets.example"]);

		// No answer at all: refused too.
		dns.answers.clear();
		await expect(refresh()).rejects.toThrow("Couldn't reach Tickets");
		expect(fetched).toHaveLength(sent);
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

		// Their own, with the same name and so the same id, is a different connector with its own server.
		expect(await other.mutation(api.customConnectors.create, { connector: { ...tickets, url: "https://elsewhere.example/mcp" } })).toBe(id);
		const servers = async () => (await t.run((ctx) => ctx.db.query("customConnectors").collect())).map((c) => [c.workspaceId, c.url]);
		expect(await servers()).toEqual([
			[await workspaceOf(owner), tickets.url],
			[otherWorkspace, "https://elsewhere.example/mcp"],
		]);
		const [mine] = await t.query(internal.connectors.forTurn, { userId: owner.userId, workspaceId: await workspaceOf(owner), connectorIds: [id] });
		expect(mine?.connector.mcp.url).toBe(tickets.url);
		// Theirs isn't connected: the owner's account stays in the owner's workspace.
		expect(await t.query(internal.connectors.forTurn, { userId: other.userId, workspaceId: otherWorkspace, connectorIds: [id] })).toEqual([]);
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
		await member.action(api.connectors.connect, { connectorId: id, credentials: { type: "api_key", key: "member-key" } });
		await member.mutation(api.permissions.set, { action: `${id}.close_ticket`, setting: "never" });
		const { scribe } = await agentsOf(owner);
		const config = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: [`${id}.*`, "clock.now"] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: scribe.version, config });

		await owner.mutation(api.customConnectors.remove, { connectorId: id });
		expect((await owner.query(api.connectors.list)).map((c) => c.id)).not.toContain(id);
		expect(await t.query(internal.connectors.forTurn, { userId: member.userId, workspaceId: await workspaceOf(owner), connectorIds: [id] })).toEqual([]);
		await expect(member.mutation(api.permissions.set, { action: `${id}.close_ticket`, setting: "always" })).rejects.toThrow("Install the connector first");
		// A new one by the same name waits until the old one's rows are gone, so none come back.
		await expect(owner.mutation(api.customConnectors.create, { connector: tickets })).rejects.toThrow("just removed");
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
