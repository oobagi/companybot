/**
 * A plugin connects the workspace to an outside service (Gmail, Calendar, …)
 * through an MCP server. Its tools come from that server at runtime.
 * Connections belong to the workspace, never to one person.
 */
export interface Plugin {
	id: string;
	name: string;
	description: string;
	version: string;
	publisher: string;
	mcp: { url: string; auth: "none" | "api_key" | "oauth" };
}

export const definePlugin = (plugin: Plugin) => plugin;

/** The plugin marketplace. Empty until the first connector ships. */
export const pluginCatalog: Plugin[] = [];
