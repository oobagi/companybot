import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";

/** A tiny in-memory MCP server for tests: lists the given tools and echoes calls. */
export function fakeMcpServer(
	tools: { name: string; description?: string; readOnly?: boolean; destructive?: boolean }[],
	onCall: (name: string, args: unknown) => string = (name, args) => `${name}:${JSON.stringify(args)}`,
): MCPTransport & { closed: boolean } {
	const transport: MCPTransport & { closed: boolean } = {
		closed: false,
		async start() {},
		async close() {
			transport.closed = true;
		},
		async send(message: JSONRPCMessage) {
			if (!("id" in message) || !("method" in message)) return;
			const reply = (result: unknown) =>
				queueMicrotask(() => transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result } as JSONRPCMessage));
			const params = (message.params ?? {}) as Record<string, any>;
			if (message.method === "initialize") {
				reply({
					protocolVersion: params.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "fake", version: "1.0.0" },
				});
			} else if (message.method === "tools/list") {
				reply({
					tools: tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
						annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive },
					})),
				});
			} else if (message.method === "tools/call") {
				reply({ content: [{ type: "text", text: onCall(params.name, params.arguments) }] });
			} else {
				queueMicrotask(() =>
					transport.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					} as JSONRPCMessage),
				);
			}
		},
	};
	return transport;
}
