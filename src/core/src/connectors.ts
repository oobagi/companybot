import type { OAuthState } from "./oauth";
import { UnsafeUrlError, isPublicAddress, publicAddresses } from "./safe-fetch";

/**
 * A connector connects the workspace to an outside service (Gmail, Calendar, …)
 * through a remote MCP server. Its tools are discovered from that server each
 * turn, named "<connector id>.<tool name>", and pass the same grant and role checks
 * as built-in tools.
 *
 * Lifecycle: someone with connectors.manage installs it (and picks which roles may use it) → someone
 * connects an account → agents granted "<connector id>.*" (or single tools) can use it.
 */
export interface Connector {
	/** Lowercase letters, digits, and dashes. Becomes the tool id prefix. */
	id: string;
	name: string;
	description: string;
	version: string;
	publisher: string;
	mcp: { url: string; transport: "http" | "sse" };
	/**
	 * Whose account agents use. "workspace": one shared connection, set by someone with connectors.manage
	 * (e.g. the company's Stripe). "personal": each person connects their own
	 * (e.g. their Gmail); agents use the account of the person they're helping.
	 */
	connection: "workspace" | "personal";
	auth: ConnectorAuth;
	/** Only owners may use it until another role is allowed. Unset: the Member role may too. */
	ownersOnly?: boolean;
	/**
	 * Added by a workspace (custom connectors), not from the catalog. Its server is whatever someone
	 * typed in, so every request to it goes through `connectorFetch` (no private or local addresses).
	 */
	custom?: boolean;
}

export type ConnectorAuth =
	| { type: "none" }
	/** A key the person pastes in. Sent as `${prefix}${key}` in `header`. */
	| { type: "api_key"; header: string; prefix?: string; label: string; help?: string }
	/** MCP OAuth: the person signs in in their browser. See oauth.ts. */
	| { type: "oauth"; scopes?: string[] };

/** What's stored (encrypted) for a connection. Never sent to the app. */
export type ConnectorCredentials = { type: "none" } | { type: "api_key"; key: string } | { type: "oauth"; oauth: OAuthState };

export const defineConnector = (connector: Connector) => connector;

/** The connector marketplace. */
export const connectorCatalog: Connector[] = [];

/**
 * A connector by id: the catalog's, or one of `custom`, the workspace's own (backend
 * `connectorsIn`). Custom ids start with CUSTOM_PREFIX, which catalog ids can't, so the two never collide.
 */
export const findConnector = (id: string, custom: readonly Connector[] = []) =>
	connectorCatalog.find((p) => p.id === id) ?? custom.find((p) => p.id === id);

export function validateConnector(connector: Connector): string | null {
	if (!/^[a-z0-9-]+$/.test(connector.id)) return `Connector id "${connector.id}" must be lowercase letters, digits, and dashes.`;
	if (connector.id.startsWith(CUSTOM_PREFIX)) return `Connector id "${connector.id}" can't start with "${CUSTOM_PREFIX}": those are workspaces' own.`;
	if (!/^https:\/\//.test(connector.mcp.url) && !connector.mcp.url.startsWith("http://localhost")) {
		return `Connector "${connector.id}" must use an https MCP URL.`;
	}
	return null;
}

/** Checks pasted-in credentials against what the connector expects. */
export function validateCredentials(connector: Connector, credentials: ConnectorCredentials): string | null {
	if (connector.auth.type === "oauth") return "This connector signs in through your browser. Use Connect in the app.";
	if (credentials.type !== connector.auth.type) return "Those aren't the right kind of credentials for this connector.";
	if (credentials.type === "api_key" && !credentials.key.trim()) return "Paste the key first.";
	return null;
}

/** Request headers for the connector's MCP server. */
export function connectorHeaders(connector: Connector, credentials: ConnectorCredentials): Record<string, string> {
	if (connector.auth.type === "api_key" && credentials.type === "api_key") {
		return { [connector.auth.header]: `${connector.auth.prefix ?? ""}${credentials.key.trim()}` };
	}
	return {};
}

// ---- Custom connectors: a workspace's own MCP servers ----

/** Every custom connector's id starts with this; catalog ids can't (validateConnector). */
export const CUSTOM_PREFIX = "custom-";
export const CUSTOM_CONNECTOR_NAME_MAX = 40;
export const CUSTOM_CONNECTOR_DESCRIPTION_MAX = 200;

/** What someone with connectors.manage fills in to add one. */
export interface CustomConnectorInput {
	name: string;
	description: string;
	/** A Streamable HTTP server. Legacy SSE-transport servers can't be custom: their stream can't be held to a checked address (`connectorFetch`). */
	url: string;
	connection: "workspace" | "personal";
	auth: { type: "none" } | { type: "api_key"; header: string; prefix?: string; label: string } | { type: "oauth" };
}

/** A custom connector as the rest of the app sees it: like any catalog one. */
export const customConnector = (id: string, input: CustomConnectorInput): Connector => ({
	id,
	name: input.name,
	description: input.description,
	version: "custom",
	publisher: "Your workspace",
	mcp: { url: input.url, transport: "http" },
	connection: input.connection,
	auth: input.auth,
	custom: true,
});

/**
 * A new custom connector's id: "custom-<slug>-<suffix>", the suffix random, so no two connectors
 * ever share one, even after a removal: a removed connector's grants can never point at a new
 * server that happens to have the same name. `random` gives a number in [0, 1) (tests pass their own).
 */
export function customConnectorId(name: string, taken: readonly string[], random: () => number = Math.random): string {
	const slug =
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24)
			.replace(/-+$/, "") || "connector";
	for (;;) {
		const suffix = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)]).join("");
		const id = `${CUSTOM_PREFIX}${slug}-${suffix}`;
		if (!taken.includes(id)) return id;
	}
}

// Headers the transport sets itself, or that would change what the request is.
const reservedHeaders = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie"]);

/** Returns a message people can read, or null if it's fine. Checked on every save. */
export function validateCustomConnector(input: CustomConnectorInput): string | null {
	const name = input.name.trim();
	if (!name) return "Give the connector a name.";
	if (name.length > CUSTOM_CONNECTOR_NAME_MAX) return `Keep the name under ${CUSTOM_CONNECTOR_NAME_MAX} characters.`;
	if (input.description.trim().length > CUSTOM_CONNECTOR_DESCRIPTION_MAX) return `Keep the description under ${CUSTOM_CONNECTOR_DESCRIPTION_MAX} characters.`;
	const problem = customUrlProblem(input.url.trim());
	if (problem) return problem;
	if (input.auth.type === "api_key") {
		const header = input.auth.header.trim();
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(header)) return "The header must be a header name, like Authorization or X-API-Key.";
		if (reservedHeaders.has(header.toLowerCase())) return `${header} is set by the connection itself. Pick another header.`;
		if ((input.auth.prefix ?? "").length > 40 || /[\r\n]/.test(input.auth.prefix ?? "")) return "Keep the prefix short, on one line (like \"Bearer \").";
		const label = input.auth.label.trim();
		if (!label) return "Name the key, like \"API key\", so people know what to paste.";
		if (label.length > 40) return "Keep the key's name under 40 characters.";
	}
	return null;
}

/**
 * Why a custom connector's URL can't be used, or null. https only, no username or password, and a
 * host on the public internet: no localhost, single-label or local-only names, and no private,
 * link-local or metadata IP literal. Names are resolved and checked again before every connection
 * (`connectorFetch`), since what a name points at can change after it's saved.
 */
export function customUrlProblem(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "That isn't a valid URL. It should look like https://example.com/mcp.";
	}
	if (url.protocol !== "https:") return "The server must use https.";
	if (url.username || url.password) return "Leave the username and password out of the URL. Use an API key instead.";
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const literal = host.startsWith("[") ? host.slice(1, -1) : /^[\d.]+$/.test(host) ? host : null;
	if (literal !== null) return isPublicAddress(literal) ? null : "That address is private or local. The server must be on the public internet.";
	if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) {
		return "That address is private or local. The server must be on the public internet.";
	}
	return null;
}

/**
 * The network a custom connector reaches its server through (backend connectorNetwork.ts, in Node):
 * `resolve` looks a host up once; `request` sends one request that connects only to the addresses
 * given (with the URL's own Host and TLS name), never looks the host up again, and never follows
 * a redirect. The body comes back whole: no long-lived streams.
 */
export interface PinnedNetwork {
	resolve(hostname: string): Promise<string[]>;
	request(url: URL, addresses: string[], init: { method: string; headers: [string, string][]; body?: ArrayBuffer }): Promise<Response>;
}

/**
 * The fetch a custom connector's MCP client uses (transport, OAuth discovery, sign-in, refresh).
 * Before each request its URL must pass `customUrlProblem`. Each host is resolved once per
 * connection (one turn, or one sign-in step) and every address checked public; requests then
 * connect only to those checked addresses, so a DNS answer that changes after the check
 * (rebinding) is never used. Redirects are refused, so a public server can't bounce a request
 * inward. A GET for a server-sent event stream gets 405 without being sent: a request's whole
 * response has to come back in one piece, which MCP allows (the server just can't push).
 */
export function connectorFetch(net: PinnedNetwork): typeof fetch {
	const checked = new Map<string, Promise<string[]>>();
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const problem = customUrlProblem(url.href);
		if (problem) throw new UnsafeUrlError(problem);
		if (request.method === "GET" && request.headers.get("accept")?.includes("text/event-stream")) {
			return new Response(null, { status: 405, statusText: "Event streams aren't used for custom connectors" });
		}
		const host = url.hostname.startsWith("[") ? url.hostname : url.hostname.toLowerCase();
		if (!checked.has(host)) checked.set(host, publicAddresses(host, net));
		const addresses = await checked.get(host)!;
		const body = request.body ? await request.arrayBuffer() : undefined;
		const response = await net.request(url, addresses, { method: request.method, headers: [...request.headers], ...(body && { body }) });
		if (response.status >= 300 && response.status < 400) throw new UnsafeUrlError(`${url.host} redirected the request. Custom connectors don't follow redirects; use the final URL.`);
		return response;
	};
}
