import { type MCPTransport, type OAuthClientProvider, createMCPClient } from "@ai-sdk/mcp";
import { jsonSchema } from "ai";
import { type Connector, type ConnectorCredentials, connectorHeaders } from "./connectors";
import { makeMcpContent, mcpModelOutput, type McpPart } from "./mcp-content";
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
 * `authProvider` (a ConnectorOAuth), which sends the token and refreshes it. Custom connectors
 * must pass `fetch` (a `connectorFetch`), so nothing reaches a private or local address.
 */
export async function openConnector(
	connector: Connector,
	connection: { credentials: ConnectorCredentials; authProvider?: OAuthClientProvider; fetch?: typeof fetch } | { transport: MCPTransport },
): Promise<ConnectorSession> {
	if (connector.custom && !("transport" in connection) && !connection.fetch) throw new Error(`${connector.name} can only connect through a checked fetch.`);
	const client = await createMCPClient({
		transport:
			"transport" in connection
				? connection.transport
				: {
						type: connector.mcp.transport,
						url: connector.mcp.url,
						headers: connectorHeaders(connector, connection.credentials),
						authProvider: connection.authProvider,
						...(connection.fetch && { fetch: connection.fetch }),
					},
	});
	try {
		const tools: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await client.listTools(cursor === undefined ? {} : { params: { cursor } });
			tools.push(...page.tools);
			cursor = page.nextCursor;
			// Fail visibly instead of silently truncating a catalog or following a broken server forever.
			if (tools.length > 5_000 || cursor !== undefined && (cursors.has(cursor) || cursors.size >= 99)) throw new Error(`${connector.name}'s tool pagination exceeded its limit or repeated a cursor.`);
			if (cursor !== undefined) cursors.add(cursor);
		} while (cursor !== undefined);
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
					readOnly: !connector.custom && t.annotations?.readOnlyHint === true,
					// Trusted only to tighten: anything the server calls destructive is locked (always asks),
					// even if it also claims to be read-only.
					risk: t.annotations?.destructiveHint === true ? "locked" : !connector.custom && t.annotations?.readOnlyHint === true && connector.connection === "personal" ? "inside" : undefined,
					returnsData: true,
					source: { type: "connector", connectorId: connector.id },
					toModelOutput: ({ output }) => mcpModelOutput(output),
					async execute(input, ctx) {
						const result = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> });
						return summarizeResult(result, ctx.connectorContent);
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
 * text. Mixed results preserve media and resources; the runner persists binary data separately.
 */
async function summarizeResult(result: CallResult, persist?: (parts: McpPart[]) => Promise<McpPart[]>) {
	if (!("content" in result) || !Array.isArray(result.content)) return result;
	const text = result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
	if (result.content.every(p => p.type === "text")) {
		if (result.isError) return { error: text, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) };
		return result.structuredContent ?? parseJson(text) ?? text;
	}
	if (result.content.length > 32 || JSON.stringify(result).length > 16 * 1024 * 1024) return { error: "Connector result exceeds 32 content blocks or 16 MiB. Request a smaller result." };
	if (JSON.stringify(result.structuredContent ?? null).length > 32000) return { error: "Connector structured content exceeds 32 KB. Request a smaller result." };
	// Strip extension fields before they can impersonate our persisted media URLs or artifact ids.
	const parts = (result.content as McpPart[]).map((p): McpPart => {
		if (p.type === "text") return { type: "text", text: p.text };
		if (p.type === "image" || p.type === "audio") return { type: p.type, mimeType: p.mimeType, data: p.data };
		if (p.type === "resource") return { type: "resource", resource: { uri: p.resource.uri, ...(p.resource.mimeType && { mimeType: p.resource.mimeType }), ...(p.resource.text !== undefined && { text: p.resource.text }), ...(p.resource.blob !== undefined && { blob: p.resource.blob }) } };
		if (p.type === "resource_link") return { type: "resource_link", uri: p.uri, name: p.name, ...(p.mimeType && { mimeType: p.mimeType }), ...(p.description && { description: p.description }) };
		throw new Error("Unsupported MCP content type.");
	});
	const content = persist ? await persist(parts) : parts;
	return makeMcpContent(content, result.structuredContent, result.isError ? text || "The MCP server reported a tool error." : undefined);
}

function parseJson(text: string): unknown {
	if (!/^\s*[[{]/.test(text)) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
