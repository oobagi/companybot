import { type MCPTransport, type OAuthClientProvider, createMCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "ai";
import { type Connector, type ConnectorCredentials, connectorHeaders } from "./connectors";
import type { ToolDef } from "./tools";

export interface ConnectorSession {
	connector: { id: string; name: string };
	tools: ToolDef[];
	/** The server's own usage notes, if it sends any. */
	instructions?: string;
	close(): Promise<void>;
}

/**
 * Connects to a connector's MCP server and turns its tools into ToolDefs named
 * "<connector id>.<tool name>". Call `close()` when the turn ends.
 *
 * Pass `transport` to talk to a server in-process (tests); otherwise it uses the
 * connector's URL with the connection's credentials. OAuth connectors also need an
 * `authProvider` (a ConnectorOAuth), which sends the token and refreshes it.
 */
export async function openConnector(
	connector: Connector,
	connection: { credentials: ConnectorCredentials; authProvider?: OAuthClientProvider } | { transport: MCPTransport },
): Promise<ConnectorSession> {
	const client = await createMCPClient({
		transport:
			"transport" in connection
				? connection.transport
				: {
						type: connector.mcp.transport,
						url: connector.mcp.url,
						headers: connectorHeaders(connector, connection.credentials),
						authProvider: connection.authProvider,
					},
	});
	try {
		const { tools } = await client.listTools();
		return {
			connector: { id: connector.id, name: connector.name },
			instructions: client.instructions,
			close: () => client.close(),
			tools: tools.map(
				(t): ToolDef => ({
					id: `${connector.id}.${t.name}`,
					title: t.title ?? t.annotations?.title,
					description: t.description ?? t.annotations?.title ?? t.name,
					input: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
					// Servers report this themselves; we only trust connectors we list in the catalog.
					readOnly: t.annotations?.readOnlyHint === true,
					// Trusted only to tighten: anything the server calls destructive is locked (always asks),
					// even if it also claims to be read-only.
					...(t.annotations?.destructiveHint === true && { risk: "locked" as const }),
					returnsData: true,
					source: { type: "connector", connectorId: connector.id },
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
