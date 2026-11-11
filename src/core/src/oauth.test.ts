import { auth } from "@ai-sdk/mcp";
import { describe, expect, it } from "vitest";
import { customConnector, findConnector } from "./connectors";
import { ConnectorOAuth, finishSignIn, startSignIn } from "./oauth";

const connector = customConnector("custom-oauth-test", { name: "Tickets", description: "", url: "https://mcp.example.com/mcp", connection: "personal", auth: { type: "oauth" } });
const redirect = "https://app.convex.site/oauth/callback";
const registered = { clientId: "app-id", clientSecret: "app-secret", issuer: "https://auth.example.com" };

/** Only the network is fake; discovery, PKCE, state validation, code exchange and refresh use the SDK. */
function provider(methods = ["client_secret_basic", "none"], resource = connector.mcp.url) {
	const requests: { url: string; init?: RequestInit }[] = [];
	const server = { issuer: registered.issuer };
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		if (url.includes("/.well-known/oauth-protected-resource")) return Response.json({ resource, authorization_servers: [server.issuer], scopes_supported: ["read"] });
		if (url.includes("/.well-known/oauth-authorization-server")) return Response.json({
			issuer: server.issuer, authorization_endpoint: `${server.issuer}/authorize`, token_endpoint: `${server.issuer}/token`,
			registration_endpoint: `${server.issuer}/register`, response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: methods,
		});
		if (url.endsWith("/register")) return Response.json({ client_id: "dynamic-app", redirect_uris: [redirect] });
		if (url.endsWith("/token")) return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" });
		throw new Error(`Unexpected endpoint ${url}`);
	};
	return { fetch, requests, server };
}

describe("registered MCP OAuth apps", () => {
	it("uses the provider's POST-only client authentication and preset scopes", async () => {
		const slack = findConnector("slack")!;
		const remote = provider(["client_secret_post"], slack.mcp.url);
		const configured = { ...slack, auth: { ...slack.auth, type: "oauth" as const, registration: { issuer: registered.issuer, secretRequired: true } } };
		const started = await startSignIn(configured, redirect, remote.fetch, registered);
		expect(new URL(started.url).searchParams.get("scope")).toContain("search:read.public");
		const saved = await finishSignIn(configured, started.state, redirect, { code: "code", state: started.state.state! }, remote.fetch);
		await auth(new ConnectorOAuth(saved, redirect, false), { serverUrl: configured.mcp.url, fetchFn: remote.fetch });
		const exchanges = remote.requests.filter(r => r.url.endsWith("/token"));
		expect(exchanges).toHaveLength(2);
		for (const request of exchanges) {
			expect(new Headers(request.init?.headers).has("Authorization")).toBe(false);
			const body = new URLSearchParams(String(request.init?.body));
			expect(body.get("client_secret")).toBe(registered.clientSecret);
			expect(body.get("client_id")).toBe(registered.clientId);
		}
	});

	it("requires registered provider credentials and the catalog's issuer before any request", async () => {
		const remote = provider();
		for (const id of ["slack", "asana"]) {
			const preset = findConnector(id)!;
			const issuer = preset.auth.type === "oauth" ? preset.auth.registration!.issuer : "";
			await expect(startSignIn(preset, redirect, remote.fetch)).rejects.toThrow(/registered app/);
			await expect(startSignIn(preset, redirect, remote.fetch, { ...registered, issuer: "https://wrong.example.com" })).rejects.toThrow(/issuer/);
			await expect(startSignIn(preset, redirect, remote.fetch, { clientId: "app", issuer })).rejects.toThrow(/secret/);
		}
		expect(remote.requests).toEqual([]);
	});
	it("uses the registered app with PKCE, then retains its credentials through exchange and refresh", async () => {
		const remote = provider();
		const started = await startSignIn(connector, redirect, remote.fetch, registered);
		const url = new URL(started.url);
		expect(url.searchParams.get("client_id")).toBe(registered.clientId);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("state")).toBe(started.state.state);
		expect(started.url).not.toContain(registered.clientSecret);
		expect(remote.requests.some(r => r.url.endsWith("/register"))).toBe(false);
		const saved = await finishSignIn(connector, started.state, redirect, { code: "code", state: started.state.state!, issuer: registered.issuer }, remote.fetch);
		expect(saved).toMatchObject({ preRegistered: true, client: { client_id: registered.clientId, client_secret: registered.clientSecret }, tokens: { refresh_token: "refresh" } });
		expect(saved.verifier).toBeUndefined();
		expect(saved.state).toBeUndefined();
		const oauth = new ConnectorOAuth(saved, redirect, false);
		expect(oauth.isClientInformationDynamicallyRegistered()).toBe(false);
		await auth(oauth, { serverUrl: connector.mcp.url, fetchFn: remote.fetch });
		const exchanges = remote.requests.filter(r => r.url.endsWith("/token"));
		expect(exchanges).toHaveLength(2);
		expect(exchanges.map(r => new URLSearchParams(String(r.init?.body)).get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
		for (const request of exchanges) expect(new Headers(request.init?.headers).get("Authorization")).toBe(`Basic ${btoa("app-id:app-secret")}`);
	});

	it("refuses an issuer switch before sending registered credentials or a callback code", async () => {
		const remote = provider();
		const started = await startSignIn(connector, redirect, remote.fetch, registered);
		remote.server.issuer = "https://other.example.com";
		await expect(finishSignIn(connector, started.state, redirect, { code: "code", state: started.state.state! }, remote.fetch)).rejects.toThrow(/issuer|authorization server/i);
		await expect(startSignIn(connector, redirect, remote.fetch, registered)).rejects.toThrow(/issuer|authorization server/i);
		expect(remote.requests.some(r => r.url.endsWith("/token") || r.url.endsWith("/register"))).toBe(false);
		expect(remote.requests.some(r => new Headers(r.init?.headers).has("Authorization"))).toBe(false);
	});

	it("checks callback state and keeps automatic registration working", async () => {
		const remote = provider();
		const started = await startSignIn(connector, redirect, remote.fetch);
		expect(new URL(started.url).searchParams.get("client_id")).toBe("dynamic-app");
		expect(new ConnectorOAuth(started.state, redirect, false).isClientInformationDynamicallyRegistered()).toBe(true);
		await expect(finishSignIn(connector, started.state, redirect, { code: "code", state: "wrong" }, remote.fetch)).rejects.toThrow(/state/);
		expect(remote.requests.some(r => r.url.endsWith("/token"))).toBe(false);
	});

	it("rejects private issuers without making a request", async () => {
		const remote = provider();
		await expect(startSignIn(connector, redirect, remote.fetch, { ...registered, issuer: "https://127.0.0.1" })).rejects.toThrow(/public HTTPS/);
		expect(remote.requests).toEqual([]);
	});
});
