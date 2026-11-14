import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { api } from "../convex/_generated/api";
import { ownerAndMember, generalOf, inWorkspace, sideWorkspace, setMemberSwitch, workspaceOf } from "./helpers";
import { defaultIntegrationScopes, openConnector } from "@companybot/core";
import { ctx as toolContext, owner as toolOwner } from "../../core/test/helpers";

afterEach(() => vi.useRealTimers());
async function setup(scopes = [...defaultIntegrationScopes, "records:write", "pages:write", "chats:write"]) {
	const { t, owner, member } = await ownerAndMember();
	const token = await owner.mutation(api.integrationTokens.create, { name: "Test app", scopes, days: 30 });
	const headers = { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	const call = (operation: string, input: unknown = {}) => t.fetch("/api/v1/call", { method: "POST", headers, body: JSON.stringify({ operation, input }) });
	const rpc = (body: unknown, extra: Record<string, string> = {}) => t.fetch("/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
	return { t, owner, member, token, headers, call, rpc };
}

describe("external integrations", () => {
	it("discovers fields, updates records through shared validation, and paginates without losing rows", async () => {
		const { owner, call } = await setup();
		const databases = await (await call("databases_list")).json();
		const type = databases.data.page.find((t: { key: string }) => t.key === "client");
		expect(type.fields.some((f: { key: string }) => f.key === "name")).toBe(true);
		const ids: Id<"records">[] = [];
		for (let i = 0; i < 3; i++) ids.push((await (await call("records_create", { typeId: type.id, values: { name: `Client ${i}` }, requestKey: `create-client-000${i}` })).json()).data.id);
		expect((await call("records_update", { recordId: ids[0], values: { name: "Updated client" }, requestKey: "update-client-001" })).status).toBe(200);
		expect((await (await call("records_get", { recordId: ids[0] })).json()).data.title).toBe("Updated client");
		expect((await owner.query(api.records.get, { recordId: ids[0]! }))?.title).toBe("Updated client");
		expect((await call("records_update", { recordId: ids[0], values: { name: {} }, requestKey: "invalid-client-01" })).status).toBe(403);
		const found: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 4; i++) {
			const page: { page: { _id: string }[]; isDone: boolean; continueCursor: string } = (await (await call("records_list", { typeId: type.id, cursor, limit: 1 })).json()).data;
			found.push(...page.page.map((r: { _id: string }) => r._id));
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
		expect(found.sort()).toEqual(ids.sort());
		expect((await call("records_list", { typeId: type.id, limit: 1000 })).status).toBe(400);

	});
	it("connects an actual MCP client and calls discovered tools through HTTP", async () => {
		const { t, owner, token } = await setup();
		const session = await openConnector({ id: "companybot", name: "Companybot", description: "Test", version: "1", publisher: "Test", connection: "personal", mcp: { url: "https://example.com/mcp", transport: "http" }, auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "Token" } }, {
			credentials: { type: "api_key", key: token.secret },
			fetch: (url, init) => t.fetch(new URL(url instanceof Request ? url.url : url.toString()).pathname, init),
		});
		try {
			const get = session.tools.find(t => t.id === "companybot.workspace_get")!;
			expect(get).toBeDefined();
			expect(await get.execute({}, toolContext(toolOwner))).toMatchObject({ data: { id: await workspaceOf(owner) } });
		} finally { await session.close(); }
	});

	it("bounds requests and daily write receipts without silently evicting retry keys", async () => {
		vi.useFakeTimers();
		const { t, token, call } = await setup();
		await t.run(ctx => ctx.db.patch(token.id, { windowAt: Date.now(), requests: 60 }));
		const limited = await call("workspace_get");
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("60");
		vi.setSystemTime(Date.now() + 60001);
		expect((await call("workspace_get")).status).toBe(200);
		await t.run(ctx => ctx.db.patch(token.id, { receipts: Array.from({ length: 128 }, (_, i) => ({ key: `key-${i}`, operation: "pages_create", fingerprint: "hash", at: Date.now(), result: { id: "page" } })) }));
		const daily = await call("pages_create", { title: "Over limit", requestKey: "create-page-limit" });
		expect(daily.status).toBe(429);
		expect(daily.headers.get("Retry-After")).toBe("86400");
		vi.setSystemTime(Date.now() + 86400001);
		expect((await call("pages_create", { title: "Next day", requestKey: "create-page-limit" })).status).toBe(200);
	});
	it("defaults to read scopes, keeps secrets out of lists and storage, and stops revoked or expired credentials", async () => {
		const { t, owner, member, token, call, rpc } = await setup([...defaultIntegrationScopes]);
		await expect(member.mutation(api.integrationTokens.create, { name: "No", scopes: ["workspace:read"], days: 30 })).rejects.toThrow();
		expect(JSON.stringify(await owner.query(api.integrationTokens.list))).not.toContain(token.secret);
		expect(JSON.stringify(await t.run(ctx => ctx.db.get(token.id)))).not.toContain(token.secret);
		expect((await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools.every((x: { annotations: { readOnlyHint: boolean } }) => x.annotations.readOnlyHint)).toBe(true);
		expect((await call("records_create", {})).status).toBe(403);
		await t.run(ctx => ctx.db.patch(token.id, { expiresAt: Date.now() - 1 }));
		const expired = await call("workspace_get");
		expect(expired.status).toBe(401);
		expect(expired.headers.get("WWW-Authenticate")).toContain("Bearer");
		await owner.mutation(api.integrationTokens.revoke, { id: token.id });
		expect((await call("workspace_get")).status).toBe(401);
	});

	it("enforces workspace and place permissions, including after a successful write is retried", async () => {
		const { t, owner, member } = await setup();
		await setMemberSwitch(owner, "integrations.manage", true);
		const token = await member.mutation(api.integrationTokens.create, { name: "Member app", scopes: ["records:write", "records:read"], days: 1 });
		const call = (operation: string, input: unknown) => t.fetch("/api/v1/call", { method: "POST", headers: { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, input }) });
		const type = (await owner.query(api.recordTypes.list))[0]!;
		const input = { typeId: type._id, values: { name: "Through the API" }, requestKey: "create-record-0001" };
		const first = await call("records_create", input);
		expect(first.status).toBe(200);
		const result = await first.json();
		expect(await (await call("records_create", input)).json()).toEqual(result);
		expect((await call("records_create", { ...input, values: { name: "Different" } })).status).toBe(409);
		const other = await sideWorkspace(t, "owner@co.com");
		const otherOwner = inWorkspace(owner, other.workspaceId);
		await otherOwner.mutation(api.recordTypes.create, { plural: "Secrets" });
		const otherType = (await otherOwner.query(api.recordTypes.list))[0]!;
		expect((await call("records_list", { typeId: otherType._id })).status).toBe(403);
		await t.run(ctx => ctx.db.patch(type._id, { access: [] }));
		expect((await call("records_create", input)).status).toBe(403);
		expect((await call("records_get", { recordId: result.data.id })).status).toBe(403);
		await setMemberSwitch(owner, "integrations.manage", false);
		expect((await call("databases_list", {})).status).toBe(401);
	});

	it("never revives a token when the same person rejoins", async () => {
		const { t, owner, token, call } = await setup();
		const workspaceId = await workspaceOf(owner);
		await t.run(async ctx => {
			const row = (await ctx.db.query("members").withIndex("by_user", q => q.eq("userId", owner.userId).eq("workspaceId", workspaceId)).first())!;
			const { _id, _creationTime: _time, ...copy } = row;
			await ctx.db.delete(_id);
			await ctx.db.insert("members", copy);
		});
		expect(await t.run(ctx => ctx.db.get(token.id))).not.toBeNull();
		expect((await call("workspace_get")).status).toBe(401);
	});

	it("posts labeled external messages once without starting agents or automations, and reads pages after appending", async () => {
		vi.useFakeTimers();
		const { t, owner, call } = await setup();
		const chat = await generalOf(owner);
		const before = await t.run(ctx => ctx.db.query("agentTurns").collect());
		const input = { chatId: chat._id, text: "Incoming status", requestKey: "post-message-0001" };
		const first = await call("messages_post", input);
		expect(first.status).toBe(200);
		const result = await first.json();
		expect(await (await call("messages_post", input)).json()).toEqual(result);
		expect(await t.run(ctx => ctx.db.query("agentTurns").collect())).toEqual(before);
		expect(await t.run(ctx => ctx.db.query("automationEvents").collect())).toEqual([]);
		const message = await t.run(ctx => ctx.db.get(result.data.id));
		expect(message).toMatchObject({ external: "Test app", text: "[External integration: Test app]\nIncoming status" });
		const made = await call("pages_create", { title: "Status", text: "First", requestKey: "create-page-00001" });
		expect(made.status).toBe(200);
		const pageId = (await made.json()).data.id;
		expect((await call("pages_append", { pageId, text: "Second", requestKey: "append-page-00001" })).status).toBe(200);
		const page = await (await call("pages_get", { pageId })).json();
		expect(page.data.doc).toContain("First");
		expect(page.data.doc).toContain("Second");
	});

	it("uses MCP JSON-RPC with version negotiation, rejects bad origins and bodies, and acknowledges notifications", async () => {
		const { t, rpc, headers } = await setup();
		const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "Test", version: "1" }, capabilities: {} } })).json();
		expect(init.result).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} } });
		const modern = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "workspace_get" };
		const modernBody = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace_get", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
		expect((await (await rpc(modernBody, modern)).json()).result.resultType).toBe("complete");
		expect((await (await rpc(modernBody, { ...modern, "Mcp-Name": "records_create" })).json()).error.code).toBe(-32020);
		expect((await (await rpc(modernBody, { ...modern, "MCP-Protocol-Version": "2025-11-25" })).json()).error.code).toBe(-32020);
		expect((await (await rpc({ ...modernBody, params: {} }, modern)).json()).error.code).toBe(-32602);
		expect((await (await rpc(modernBody, { ...modern, "Mcp-Name": `=?base64?${btoa("workspace_get")}?=` })).json()).result.resultType).toBe("complete");
		expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
		expect((await rpc({ jsonrpc: "2.0", id: 2, method: "ping" }, { Origin: "https://evil.example" })).status).toBe(403);
		const newer = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "MCP-Protocol-Version": "2099-01-01" });
		expect(newer.status).toBe(400);
		expect((await newer.json()).error.data.supported).toContain("2025-11-25");
		expect((await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_get", arguments: {} } })).json()).result.isError).not.toBe(true);
		expect((await (await rpc({ jsonrpc: "2.0", id: 4, method: "nope" })).json()).error.code).toBe(-32601);
		expect((await t.fetch("/mcp", { headers })).status).toBe(405);
		expect((await t.fetch("/mcp", { method: "POST", headers, body: "x".repeat(128 * 1024 + 1) })).status).toBe(413);
		expect((await (await t.fetch("/mcp", { method: "POST", headers, body: "{" })).json()).error.code).toBe(-32700);
	});
});
