import { integrationTools, integrationScopes, integrationOpenApi } from "@companybot/core";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { readBody } from "./images";
import { tokenHash } from "./integrationTokens";

// Advertise only implemented versions. Stateless Streamable HTTP with JSON responses.
const legacyVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const versions = ["2026-07-28", ...legacyVersions];
const serverInfo = { name: "Companybot", version: "1.0.0" };
const instructions = "Tools act within the token's workspace and scopes. Write scopes are preauthorized; confirm writes with your user. External posts do not wake agents. Reuse requestKey only for an identical retry within 24 hours.";
function decodedHeader(value: string | null) {
	if (value === null || /[^\x20-\x7e]/.test(value)) return null;
	try { return value.startsWith("=?base64?") && value.endsWith("?=") ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value.slice(9, -2)), c => c.charCodeAt(0))) : value; }
	catch { return null; }
}
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
const statusHeaders = (result: { status: number; retryAfter?: number }): Record<string, string> => result.status === 401 ? { "WWW-Authenticate": 'Bearer realm="Companybot"' } : result.status === 429 ? { "Retry-After": String(result.retryAfter ?? 60) } : {};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const rpcError = (id: string | number | null, code: number, message: string, status = 200, data?: unknown) => json({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } }, status);

async function dispatch(ctx: ActionCtx, hash: string, operation?: string, input?: unknown): Promise<{ status: number; data?: unknown; error?: string; retryAfter?: number }> {
	try {
		const result = await ctx.runMutation(internal.integrationOps.dispatch, { hash, ...(operation !== undefined && { operation }), ...(input !== undefined && { input }) });
		return !operation && result.status === 200 && "data" in result ? { status: 200, data: { tools: integrationTools((result.data as { scopes: string[] }).scopes) } } : result;
	} catch (e) {
		// Do not return stack traces, internal ids, or data from failed permission checks.
		return e instanceof ConvexError ? { status: 403, error: "Operation refused. Check your current permissions and resource access." } : { status: 500, error: "Operation failed." };
	}
}

export const handle = httpAction(async (ctx, request) => {
	const url = new URL(request.url);
	const mcp = url.pathname === "/mcp";
	const origin = request.headers.get("Origin");
	const allowed = [url.origin, ...(process.env.INTEGRATION_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean)];
	if (origin && !allowed.includes(origin)) return json({ error: "Origin is not allowed." }, 403);
	const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
	const finish = (response: Response) => { for (const [k, v] of Object.entries(cors)) response.headers.set(k, v); return response; };
	if (request.method === "OPTIONS") return finish(new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name" } }));
	if (mcp && request.method !== "POST") return finish(json({ error: "Use POST. This endpoint does not maintain SSE sessions." }, 405, { Allow: "POST, OPTIONS" }));
	if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") return finish(json(integrationOpenApi(url.origin)));
	if (url.pathname === "/api/v1/schema" && request.method === "GET") return finish(json({ version: "1", transport: { url: "/api/v1/call", method: "POST", body: { operation: "<tool name>", input: "<tool arguments>" } }, authentication: "Bearer token from Settings > API access", tools: integrationTools(Object.keys(integrationScopes)) }));
	const secret = /^Bearer (cb_[a-f0-9]{64})$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
	if (!secret) return finish(json({ error: "A Companybot bearer token is required." }, 401, { "WWW-Authenticate": 'Bearer realm="Companybot"' }));
	const hash = await tokenHash(secret);
	if (!mcp && url.pathname === "/api/v1/tools" && request.method === "GET") {
		const result = await dispatch(ctx, hash);
		return finish(json(result.error ? { error: result.error } : result.data, result.status, statusHeaders(result)));
	}
	if (request.method !== "POST" || !mcp && url.pathname !== "/api/v1/call") return finish(json({ error: "Not found." }, 404));
	if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") return finish(json({ error: "Use application/json." }, 415));
	if (mcp && (!request.headers.get("Accept")?.includes("application/json") || !request.headers.get("Accept")?.includes("text/event-stream"))) return finish(json({ error: "Accept application/json and text/event-stream." }, 406));
	const bytes = await readBody(request, 128 * 1024);
	if (!bytes) return finish(json({ error: "Request exceeds 128 KiB." }, 413));
	let body: unknown;
	try { body = JSON.parse(new TextDecoder().decode(bytes)); }
	catch { return finish(mcp ? rpcError(null, -32700, "Parse error", 400) : json({ error: "Invalid JSON." }, 400)); }
	if (!mcp) {
		if (!object(body) || typeof body.operation !== "string") return finish(json({ error: "Provide operation and input." }, 400));
		const result = await dispatch(ctx, hash, body.operation, body.input);
		return finish(json(result.error ? { error: result.error } : { data: result.data }, result.status, statusHeaders(result)));
	}
	if (!object(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string" || (body.id !== undefined && typeof body.id !== "string" && (typeof body.id !== "number" || !Number.isSafeInteger(body.id))) || body.params !== undefined && !object(body.params)) return finish(rpcError(null, -32600, "Invalid request", 400));
	const id = body.id === undefined ? null : body.id as string | number;
	const params = object(body.params) ? body.params : {};
	const version = request.headers.get("MCP-Protocol-Version");
	if (version && !versions.includes(version)) return finish(rpcError(id, -32022, "Unsupported protocol version", 400, { supported: versions, requested: version }));
	const meta = object(params._meta) ? params._meta : {};
	const bodyVersion = meta["io.modelcontextprotocol/protocolVersion"];
	const modern = version === "2026-07-28" || bodyVersion !== undefined;
	if (modern && body.id !== undefined) {
		if (typeof bodyVersion !== "string" || !object(meta["io.modelcontextprotocol/clientCapabilities"])) return finish(rpcError(id, -32602, "Required request metadata is missing", 400));
		if (version !== bodyVersion || request.headers.get("Mcp-Method") !== body.method) return finish(rpcError(id, -32020, "Header mismatch", 400));
		const named = body.method === "tools/call" || body.method === "prompts/get" || body.method === "resources/read";
		if (named && decodedHeader(request.headers.get("Mcp-Name")) !== (body.method === "resources/read" ? params.uri : params.name)) return finish(rpcError(id, -32020, "Header mismatch", 400));
	}
	const replyResult = (result: object) => finish(json({ jsonrpc: "2.0", id, result: { ...result, ...(modern && { resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } }) } }));
	if (body.method === "tools/call" && body.id !== undefined) {
		if (typeof params.name !== "string" || params.arguments !== undefined && !object(params.arguments)) return finish(rpcError(id, -32602, "Invalid tool call"));
		const result = await dispatch(ctx, hash, params.name, params.arguments ?? {});
		if (result.status === 401 || result.status === 429) return finish(json({ error: result.error }, result.status, statusHeaders(result)));
		if (result.status === 404) return finish(rpcError(id, -32602, "Unknown tool"));
		return replyResult(result.error ? { isError: true, content: [{ type: "text", text: result.error }] } : { content: [{ type: "text", text: JSON.stringify(result.data) }], structuredContent: { data: result.data } });
	}
	const access = await dispatch(ctx, hash);
	if (access.error) return finish(json({ error: access.error }, access.status, statusHeaders(access)));
	if (body.id === undefined) return finish(new Response(null, { status: 202 }));
	if (body.method === "server/discover" && modern) return replyResult({ supportedVersions: versions, capabilities: { tools: {} }, instructions, cacheScope: "private", ttlMs: 0 });
	if (body.method === "initialize" && !modern) {
		if (typeof params.protocolVersion !== "string" || !object(params.clientInfo) || !object(params.capabilities)) return finish(rpcError(id, -32602, "Invalid initialization"));
		return replyResult({ protocolVersion: legacyVersions.includes(params.protocolVersion) ? params.protocolVersion : legacyVersions[0], capabilities: { tools: {} }, serverInfo, instructions });
	}
	if (body.method === "ping") return replyResult({});
	if (body.method === "tools/list") {
		if (params.cursor !== undefined) return finish(rpcError(id, -32602, "No further tool pages"));
		return replyResult(access.data as object);
	}
	return finish(rpcError(id, -32601, "Method not found", modern ? 404 : 200));
});
