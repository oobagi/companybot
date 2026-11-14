import { consentAppUrl } from "./integrationSetup";
import { defaultIntegrationScopes, integrationScopes } from "@companybot/core";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { issuer } from "./integrationOAuth";
import { tokenHash } from "./integrationTokens";
import { readBody } from "./images";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", ...(status === 429 ? { "Retry-After": "60" } : {}) } });
export const handle = httpAction(async (ctx, request) => {
	const base = issuer();
	if (!base) return json({ error: "temporarily_unavailable" }, 503);
	const url = new URL(request.url);
	const path = url.pathname;
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
	if (request.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
		const resource = path.endsWith("/api/v1") ? `${base}/api/v1` : `${base}/mcp`;
		return json({ resource, authorization_servers: [base], scopes_supported: Object.keys(integrationScopes), bearer_methods_supported: ["header"], resource_name: "Companybot" });
	}
	if (request.method === "GET" && path === "/.well-known/oauth-authorization-server") return json({
		issuer: base, authorization_endpoint: `${base}/integrations/oauth/authorize`, token_endpoint: `${base}/integrations/oauth/token`, registration_endpoint: `${base}/integrations/oauth/register`, revocation_endpoint: `${base}/integrations/oauth/revoke`,
		client_id_metadata_document_supported: true, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: Object.keys(integrationScopes), authorization_response_iss_parameter_supported: true,
	});
	try {
		if (path === "/integrations/oauth/authorize" && request.method === "GET") {
			const p = url.searchParams;
			if ([...new Set(p.keys())].some(k => p.getAll(k).length !== 1) || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
			const args = { clientId: p.get("client_id") ?? "", redirect: p.get("redirect_uri") ?? "", resource: p.get("resource") ?? "", challenge: p.get("code_challenge") ?? "", scopes: p.has("scope") ? (p.get("scope") ?? "").split(" ").filter(Boolean) : defaultIntegrationScopes, state: p.get("state") ?? "" };
			if (args.clientId.startsWith("https://") && !(await ctx.runQuery(internal.integrationOAuth.cached, { clientId: args.clientId }))) {
				try { await ctx.runAction(internal.integrationNetwork.resolveClient, { clientId: args.clientId }); }
				catch { return json({ error: "invalid_client", error_description: "Client metadata could not be validated." }, 400); }
			}
			await ctx.runQuery(internal.integrationOAuth.inspect, args);
			const app = consentAppUrl();
			if (!app) return json({ error: "temporarily_unavailable", error_description: "OAuth setup is required. The team running this Companybot installation needs to configure the sign-in and consent page. Reconnect from your application after setup is complete." }, 503);
			const target = new URL(app);
			target.hash = `/oauth/authorize/${encodeURIComponent(JSON.stringify(args))}`;
			return new Response(null, { status: 302, headers: { Location: target.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
		}
		if (request.method !== "POST") return json({ error: "invalid_request" }, 405);
		const bytes = await readBody(request, 16384);
		if (!bytes) return json({ error: "invalid_request" }, 413);
		const raw = new TextDecoder().decode(bytes);
		if (path === "/integrations/oauth/register") {
			if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "invalid_request" }, 415);
			const body = JSON.parse(raw);
			if (!body || body.client_name !== undefined && typeof body.client_name !== "string" || !Array.isArray(body.redirect_uris) || body.redirect_uris.some((s: unknown) => typeof s !== "string") || body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none" || body.grant_types && (!Array.isArray(body.grant_types) || body.grant_types.some((s: string) => !["authorization_code", "refresh_token"].includes(s))) || body.response_types && (!Array.isArray(body.response_types) || body.response_types.some((s: string) => s !== "code"))) return json({ error: "invalid_client_metadata" }, 400);
			const result = await ctx.runMutation(internal.integrationOAuth.register, { name: body.client_name ?? "External application", redirects: body.redirect_uris });
			return json(result, "error" in result ? result.error === "temporarily_unavailable" ? 429 : 400 : 201);
		}
		if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return json({ error: "invalid_request" }, 415);
		const p = new URLSearchParams(raw);
		if ([...new Set(p.keys())].some(k => p.getAll(k).length !== 1) || p.has("client_secret") || request.headers.has("Authorization")) return json({ error: "invalid_request" }, 400);
		if (path === "/integrations/oauth/revoke") {
			await ctx.runMutation(internal.integrationOAuth.revoke, { clientId: p.get("client_id") ?? "", hash: await tokenHash(p.get("token") ?? "") });
			return json({});
		}
		if (path !== "/integrations/oauth/token") return json({ error: "invalid_request" }, 404);
		const grant = p.get("grant_type") ?? "";
		if (!["authorization_code", "refresh_token"].includes(grant)) return json({ error: "unsupported_grant_type" }, 400);
		const verifier = p.get("code_verifier") ?? "";
		if (grant === "authorization_code" && !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return json({ error: "invalid_grant" }, 400);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
		const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const result = await ctx.runMutation(internal.integrationOAuth.exchange, { grant, clientId: p.get("client_id") ?? "", resource: p.get("resource") ?? "", codeHash: await tokenHash(p.get("code") ?? ""), redirect: p.get("redirect_uri") ?? "", challenge, refreshHash: await tokenHash(p.get("refresh_token") ?? ""), ...(p.has("scope") && { scope: p.get("scope")! }) });
		return json(result, "error" in result ? result.error === "temporarily_unavailable" ? 429 : 400 : 200);
	} catch (e) {
		return json({ error: e instanceof ConvexError || e instanceof SyntaxError ? "invalid_request" : "server_error" }, e instanceof ConvexError || e instanceof SyntaxError ? 400 : 500);
	}
});
