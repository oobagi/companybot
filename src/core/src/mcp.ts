import { type MCPTransport, type OAuthClientProvider, createMCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "ai";
import { type Plugin, type PluginCredentials, pluginHeaders } from "./plugins";
import type { ToolDef } from "./tools";

export interface PluginSession {
	tools: ToolDef[];
	/** The server's own usage notes, if it sends any. */
	instructions?: string;
	close(): Promise<void>;
}

/**
 * Connects to a plugin's MCP server and turns its tools into ToolDefs named
 * "<plugin id>.<tool name>". Call `close()` when the turn ends.
 *
 * Pass `transport` to talk to a server in-process (tests); otherwise it uses the
 * plugin's URL with the connection's credentials. OAuth plugins also need an
 * `authProvider` (a PluginOAuth), which sends the token and refreshes it.
 */
export async function openPlugin(
	plugin: Plugin,
	connection: { credentials: PluginCredentials; authProvider?: OAuthClientProvider } | { transport: MCPTransport },
): Promise<PluginSession> {
	const client = await createMCPClient({
		transport:
			"transport" in connection
				? connection.transport
				: {
						type: plugin.mcp.transport,
						url: plugin.mcp.url,
						headers: pluginHeaders(plugin, connection.credentials),
						authProvider: connection.authProvider,
					},
	});
	try {
		const { tools } = await client.listTools();
		return {
			instructions: client.instructions,
			close: () => client.close(),
			tools: tools.map(
				(t): ToolDef => ({
					id: `${plugin.id}.${t.name}`,
					description: t.description ?? t.annotations?.title ?? t.name,
					input: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
					// Servers report this themselves; we only trust plugins we list in the catalog.
					readOnly: t.annotations?.readOnlyHint === true,
					returnsData: true,
					source: { type: "plugin", pluginId: plugin.id },
					async execute(input) {
						const result = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> });
						return summarizeResult(result);
					},
				}),
			),
		};
	} catch (e) {
		await client.close();
		throw e;
	}
}

type CallResult = Awaited<ReturnType<Awaited<ReturnType<typeof createMCPClient>>["callTool"]>>;

/**
 * What the agent gets back. Keeps data structured when the server sends it (as
 * `structuredContent`, or JSON text), so widgets can point at it by ref. Otherwise
 * text, with other content types noted. Errors are marked so the model sees them.
 */
function summarizeResult(result: CallResult) {
	if (!("content" in result) || !Array.isArray(result.content)) return result;
	const text = result.content
		.map((part) => (part.type === "text" ? part.text : `[${part.type} omitted]`))
		.join("\n");
	if (result.isError) return { error: text };
	return result.structuredContent ?? parseJson(text) ?? text;
}

function parseJson(text: string): unknown {
	if (!/^\s*[[{]/.test(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
