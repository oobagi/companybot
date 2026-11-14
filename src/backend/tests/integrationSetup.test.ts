import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { ownerAndMember } from "./helpers";

afterEach(() => vi.unstubAllEnvs());
const secretKey = btoa("k".repeat(32));

it("reports missing OAuth setup without preventing manual token access or exposing configuration secrets", async () => {
	vi.stubEnv("CONVEX_SITE_URL", "https://companybot.example");
	vi.stubEnv("INTEGRATION_APP_URL", "");
	vi.stubEnv("CONNECTIONS_KEY", secretKey);
	const { t, owner } = await ownerAndMember();
	const state = await owner.query(api.integrationTokens.list);
	expect(state).toMatchObject({ endpoint: "https://companybot.example", oauthConfigured: false, webhooksConfigured: true });
	expect(JSON.stringify(state)).not.toContain(secretKey);
	const token = await owner.mutation(api.integrationTokens.create, { name: "Local test", scopes: ["workspace:read"], days: 1 });
	expect((await t.fetch("/api/v1/tools", { headers: { Authorization: `Bearer ${token.secret}` } })).status).toBe(200);
});

it("keeps readiness consistent with authorization redirects for local, hosted and invalid consent addresses", async () => {
	vi.stubEnv("CONVEX_SITE_URL", "https://companybot.example");
	const { t, owner } = await ownerAndMember();
	const registered = await t.fetch("/integrations/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }) });
	const { client_id } = await registered.json();
	const params = new URLSearchParams({ client_id, response_type: "code", redirect_uri: "https://client.example/callback", resource: "https://companybot.example/mcp", code_challenge_method: "S256", code_challenge: "a".repeat(43), scope: "workspace:read" });
	for (const app of ["", "https://", "http://remote.example", "https://user:password@app.example"]) {
		vi.stubEnv("INTEGRATION_APP_URL", app);
		expect((await owner.query(api.integrationTokens.list)).oauthConfigured).toBe(false);
		expect((await t.fetch(`/integrations/oauth/authorize?${params}`)).status).toBe(503);
	}
	for (const app of ["https://app.example", "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
		vi.stubEnv("INTEGRATION_APP_URL", app);
		expect((await owner.query(api.integrationTokens.list)).oauthConfigured).toBe(true);
		const response = await t.fetch(`/integrations/oauth/authorize?${params}`);
		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("Location")!).origin).toBe(app);
	}
	vi.stubEnv("CONVEX_SITE_URL", "not-an-address");
	expect(await owner.query(api.integrationTokens.list)).toMatchObject({ endpoint: null, oauthConfigured: false });
	expect((await t.fetch("/.well-known/oauth-authorization-server")).status).toBe(503);
});

it("refuses webhook creation with a recoverable setup error until signing-secret storage is configured", async () => {
	const { owner } = await ownerAndMember();
	const token = await owner.mutation(api.integrationTokens.create, { name: "Events", scopes: ["events:read", "pages:read"], days: 1 });
	for (const key of ["", "not base64!", btoa("short")]) {
		vi.stubEnv("CONNECTIONS_KEY", key);
		expect((await owner.query(api.integrationTokens.list)).webhooksConfigured).toBe(false);
		await expect(owner.action(api.integrationWebhooks.create, { tokenId: token.id, url: "https://receiver.example/events" })).rejects.toThrow(/Webhook setup required/);
		expect(await owner.query(api.integrationWebhooks.list)).toEqual([]);
	}
	vi.stubEnv("CONNECTIONS_KEY", secretKey);
	await owner.action(api.integrationWebhooks.create, { tokenId: token.id, url: "https://receiver.example/events" });
	expect(await owner.query(api.integrationWebhooks.list)).toHaveLength(1);
});

it("reports connector prerequisites and refuses sign-in before contacting a provider when setup is missing", async () => {
	const { owner } = await ownerAndMember();
	await owner.mutation(api.connectors.setInstalled, { connectorId: "notion", installed: true });
	await owner.mutation(api.connectors.setInstalled, { connectorId: "github", installed: true });
	vi.stubEnv("CONNECTIONS_KEY", "");
	vi.stubEnv("CONVEX_SITE_URL", "");
	let catalog = await owner.query(api.connectors.list);
	expect(catalog.find(c => c.id === "github")?.setupProblem).toBeTruthy();
	await expect(owner.action(api.connectors.connect, { connectorId: "github", credentials: { type: "api_key", key: "test-token" } })).rejects.toThrow(/setup required/);
	vi.stubEnv("CONNECTIONS_KEY", secretKey);
	catalog = await owner.query(api.connectors.list);
	expect(catalog.find(c => c.id === "github")?.setupProblem).toBeNull();
	expect(catalog.find(c => c.id === "notion")).toMatchObject({ oauthRedirectUrl: null, setupProblem: expect.any(String) });
	await expect(owner.action(api.connectors.startOAuth, { connectorId: "notion" })).rejects.toThrow(/Browser sign-in setup required/);
	vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
	vi.stubEnv("INTEGRATION_APP_URL", "");
	// Outbound provider sign-in uses its callback, not the inbound OAuth consent page.
	expect((await owner.query(api.connectors.list)).find(c => c.id === "notion")).toMatchObject({ setupProblem: null, oauthRedirectUrl: "http://127.0.0.1:3211/oauth/callback" });
});
