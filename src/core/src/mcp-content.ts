import type { ToolResultPart } from "ai";
type ToolResultOutput = ToolResultPart["output"];
import { jsonOutput } from "./tools";

export type McpPart =
	| { type: "text"; text: string }
	| { type: "image" | "audio"; mimeType: string; data?: string; url?: string; artifactId?: string; modelSupported?: boolean }
	| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string }; url?: string; artifactId?: string; modelSupported?: boolean }
	| { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string };
export interface McpContent {
	mcpContent: true;
	content: McpPart[];
	structuredContent?: unknown;
	error?: string;
}
// Text/structured JSON from a server can imitate any object shape. Only results normalized by
// our adapter may become native media. Serialized receipts replay as data, not executable URLs.
const trustedResults = new WeakSet<object>();
export function makeMcpContent(content: McpPart[], structuredContent?: unknown, error?: string): McpContent {
	const result: McpContent = { mcpContent: true, content, ...(structuredContent !== undefined && { structuredContent }), ...(error !== undefined && { error }) };
	trustedResults.add(result);
	return result;
}
export const isMcpContent = (value: unknown): value is McpContent => !!value && typeof value === "object" && trustedResults.has(value);

/** Rich content becomes native model files. Resource links remain data: never fetch arbitrary URIs. */
export function mcpModelOutput(output: unknown): ToolResultOutput {
	const wrapped = output && typeof output === "object" && "data" in output ? output.data : output;
	if (!isMcpContent(wrapped)) return jsonOutput(output);
	const value: Extract<ToolResultOutput, { type: "content" }>["value"] = [];
	if (output && typeof output === "object" && "ref" in output) value.push({ type: "text", text: `Result reference: ${output.ref}` });
	if (wrapped.error) value.push({ type: "text", text: `Tool reported an error: ${wrapped.error}` });
	if (wrapped.structuredContent !== undefined) value.push({ type: "text", text: JSON.stringify(wrapped.structuredContent) });
	for (const p of wrapped.content) {
		if (p.type === "text") value.push({ type: "text", text: p.text });
		else if (p.type === "resource_link") value.push({ type: "text", text: `Resource link (not fetched): ${JSON.stringify(p)}` });
		else if (p.type === "resource" && p.resource.text !== undefined) value.push({ type: "text", text: `Resource ${p.resource.uri}:\n${p.resource.text}` });
		else {
			const mimeType = p.type === "resource" ? p.resource.mimeType ?? "application/octet-stream" : p.mimeType;
			const data = p.type === "resource" ? p.resource.blob : p.data;
			if (p.modelSupported !== false && (p.url || data)) value.push({ type: "file", mediaType: mimeType, data: p.url ? { type: "url", url: new URL(p.url) } : { type: "data", data: data! } });
			value.push({ type: "text", text: `Returned ${mimeType}${p.artifactId ? `; saved artifact ${p.artifactId}` : ""}${p.type === "resource" ? ` (${p.resource.uri})` : ""}${p.modelSupported === false ? " This model cannot interpret this media; the person can open it in tool activity. Do not infer its contents." : ""}.` });
		}
	}
	return { type: "content", value };
}
