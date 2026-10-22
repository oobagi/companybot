import type { OAuthState } from "./oauth";
import type { Role } from "./types";

/**
 * A plugin connects the workspace to an outside service (Gmail, Calendar, …)
 * through a remote MCP server. Its tools are discovered from that server each
 * turn, named "<plugin id>.<tool name>", and pass the same grant and role checks
 * as built-in tools.
 *
 * Lifecycle: an owner installs it (and picks which roles may use it) → someone
 * connects an account → agents granted "<plugin id>.*" (or single tools) can use it.
 */
export interface Plugin {
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
	auth: PluginAuth;
	/** Roles that may use it by default. Owners can change this per workspace. */
	defaultRoles?: Role[];
}

export type PluginAuth =
	| { type: "none" }
	/** A key the person pastes in. Sent as `${prefix}${key}` in `header`. */
	| { type: "api_key"; header: string; prefix?: string; label: string; help?: string }
	/** MCP OAuth: the person signs in in their browser. See oauth.ts. */
	| { type: "oauth"; scopes?: string[] };

/** What's stored (encrypted) for a connection. Never sent to the app. */
export type PluginCredentials = { type: "none" } | { type: "api_key"; key: string } | { type: "oauth"; oauth: OAuthState };

export const definePlugin = (plugin: Plugin) => plugin;

/** The plugin marketplace. */
export const pluginCatalog: Plugin[] = [
	// Internal testing only: our own product's MCP server. Remove before launch (wiki/architecture.md).
	definePlugin({
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

export const findPlugin = (id: string) => pluginCatalog.find((p) => p.id === id);

export function validatePlugin(plugin: Plugin): string | null {
	if (!/^[a-z0-9-]+$/.test(plugin.id)) return `Plugin id "${plugin.id}" must be lowercase letters, digits, and dashes.`;
	if (!/^https:\/\//.test(plugin.mcp.url) && !plugin.mcp.url.startsWith("http://localhost")) {
		return `Plugin "${plugin.id}" must use an https MCP URL.`;
	}
	return null;
}

/** Checks pasted-in credentials against what the plugin expects. */
export function validateCredentials(plugin: Plugin, credentials: PluginCredentials): string | null {
	if (plugin.auth.type === "oauth") return "This plugin signs in through your browser. Use Connect in the app.";
	if (credentials.type !== plugin.auth.type) return "Those aren't the right kind of credentials for this plugin.";
	if (credentials.type === "api_key" && !credentials.key.trim()) return "Paste the key first.";
	return null;
}

/** Request headers for the plugin's MCP server. */
export function pluginHeaders(plugin: Plugin, credentials: PluginCredentials): Record<string, string> {
	if (plugin.auth.type === "api_key" && credentials.type === "api_key") {
		return { [plugin.auth.header]: `${plugin.auth.prefix ?? ""}${credentials.key.trim()}` };
	}
	return {};
}

/** Roles that may use a plugin in a workspace: the owner's choice, else the plugin default, else everyone. */
export const pluginRoles = (plugin: Plugin, chosen?: Role[]): Role[] => chosen ?? plugin.defaultRoles ?? ["owner", "member"];
