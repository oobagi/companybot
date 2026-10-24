import type { OAuthState } from "./oauth";
import type { Role } from "./types";

/**
 * A connector connects the workspace to an outside service (Gmail, Calendar, …)
 * through a remote MCP server. Its tools are discovered from that server each
 * turn, named "<connector id>.<tool name>", and pass the same grant and role checks
 * as built-in tools.
 *
 * Lifecycle: an owner installs it (and picks which roles may use it) → someone
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
	 * Whose account agents use. "workspace": one shared connection, set by an owner
	 * (e.g. the company's Stripe). "personal": each person connects their own
	 * (e.g. their Gmail); agents use the account of the person they're helping.
	 */
	connection: "workspace" | "personal";
	auth: ConnectorAuth;
	/** Roles that may use it by default. Owners can change this per workspace. */
	defaultRoles?: Role[];
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
export const connectorCatalog: Connector[] = [
	// Internal testing only: our own product's MCP server. Remove before launch (wiki/architecture.md).
	defineConnector({
		id: "night-owl",
		name: "Night Owl",
		description: "Leads, calls, campaigns, and clients from Night Owl.",
		version: "1.0.0",
		publisher: "Night Owl",
		mcp: { url: "https://callnightowl.com/api/mcp", transport: "http" },
		connection: "personal",
		auth: { type: "oauth" },
	}),
];

export const findConnector = (id: string) => connectorCatalog.find((p) => p.id === id);

export function validateConnector(connector: Connector): string | null {
	if (!/^[a-z0-9-]+$/.test(connector.id)) return `Connector id "${connector.id}" must be lowercase letters, digits, and dashes.`;
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

/** Roles that may use a connector in a workspace: the owner's choice, else the connector default, else everyone. */
export const connectorRoles = (connector: Connector, chosen?: Role[]): Role[] => chosen ?? connector.defaultRoles ?? ["owner", "member"];
