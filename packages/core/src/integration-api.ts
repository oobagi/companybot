import { z } from "zod";

/** One contract for HTTP, MCP discovery, and the settings consent screen. */
export const integrationScopes = {
	"workspace:read": "Read workspace details",
	"records:read": "Read databases and records",
	"records:write": "Create, update, archive and restore records",
	"pages:read": "Read pages",
	"pages:write": "Create, append, rename, archive and restore pages",
	"chats:read": "Read chats and messages",
	"chats:write": "Post, edit and delete your external messages without waking agents",
	"events:read": "Read change events for resources you can access",
} as const;
export type IntegrationScope = keyof typeof integrationScopes;
export const integrationScope = z.enum(Object.keys(integrationScopes) as [IntegrationScope, ...IntegrationScope[]]);
export const defaultIntegrationScopes: IntegrationScope[] = ["workspace:read", "records:read", "pages:read", "chats:read"];
const id = z.string().min(1).max(100);
const page = { cursor: z.string().max(4096).nullable().default(null), limit: z.number().int().min(1).max(50).default(25) };
const requestKey = { requestKey: z.string().min(16).max(100).describe("Unique idempotency key. Reuse only for the exact same operation within 24 hours.") };
const op = <S extends z.ZodObject>(scope: IntegrationScope, description: string, input: S) => ({ scope, description, input });
export const integrationOperations = {
	workspace_get: op("workspace:read", "Read this token's workspace.", z.object({})),
	databases_list: op("records:read", "List visible databases and their fields.", z.object(page)),
	records_list: op("records:read", "Read a page of records in a database.", z.object({ typeId: id, ...page })),
	records_archive: op("records:write", "Archive or restore a record.", z.object({ recordId: id, archived: z.boolean(), ...requestKey })),
	records_get: op("records:read", "Read one record.", z.object({ recordId: id })),
	records_create: op("records:write", "Create a record. Values are keyed by field key.", z.object({ typeId: id, values: z.record(z.string(), z.unknown()), ...requestKey })),
	records_update: op("records:write", "Update specified fields of a record.", z.object({ recordId: id, values: z.record(z.string(), z.unknown()), ...requestKey })),
	pages_list: op("pages:read", "List visible standalone pages. Continue even when a page is empty if isDone is false.", z.object(page)),
	pages_rename: op("pages:write", "Rename a standalone page or folder.", z.object({ pageId: id, title: z.string().trim().min(1).max(200), ...requestKey })),
	pages_archive: op("pages:write", "Archive or restore a standalone page or folder.", z.object({ pageId: id, archived: z.boolean(), ...requestKey })),
	pages_get: op("pages:read", "Read page content as a ProseMirror JSON document string.", z.object({ pageId: id })),
	pages_create: op("pages:write", "Create a page with plain text paragraphs.", z.object({ title: z.string().trim().min(1).max(200), text: z.string().max(32000).default(""), parentId: id.optional(), ...requestKey })),
	pages_append: op("pages:write", "Append plain text paragraphs to a page.", z.object({ pageId: id, text: z.string().min(1).max(32000), ...requestKey })),
	events_list: op("events:read", "Read seven days of change notices. Also requires the matching resource read scope. Continue empty pages until isDone.", z.object(page)),
	messages_get: op("chats:read", "Read one message with the same privacy masking as the app.", z.object({ messageId: id })),
	messages_edit: op("chats:write", "Edit a message created by this external connection.", z.object({ messageId: id, text: z.string().trim().min(1).max(16000), ...requestKey })),
	messages_delete: op("chats:write", "Delete a message created by this external connection.", z.object({ messageId: id, ...requestKey })),
	chats_list: op("chats:read", "List a page of visible chats.", z.object(page)),
	messages_list: op("chats:read", "Read visible messages in a chat or thread.", z.object({ chatId: id, threadId: id.optional(), ...page })),
	messages_post: op("chats:write", "Post external content as the token holder. Does not start agents, automations, or follow-ups.", z.object({ chatId: id, threadId: id.optional(), text: z.string().trim().min(1).max(16000), ...requestKey })),
};
export type IntegrationOperation = keyof typeof integrationOperations;
export function integrationTools(scopes: readonly string[]) {
	return Object.entries(integrationOperations).filter(([, op]) => scopes.includes(op.scope)).map(([name, op]) => ({
		name, description: op.description, inputSchema: z.toJSONSchema(op.input.strict(), { io: "input" }),
		annotations: { readOnlyHint: op.scope.endsWith(":read"), destructiveHint: ["records_update", "records_archive", "pages_rename", "pages_archive", "messages_edit", "messages_delete"].includes(name), openWorldHint: false },
	}));
}

export function integrationOpenApi(server: string) {
	return {
		openapi: "3.1.0", info: { title: "Companybot integration API", version: "1.0.0" }, servers: [{ url: server }],
		security: [{ bearerAuth: [] }, { oauth2: [] }], components: { securitySchemes: {
			bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Companybot API token" },
			oauth2: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: `${server}/integrations/oauth/authorize`, tokenUrl: `${server}/integrations/oauth/token`, scopes: integrationScopes } } },
		} },
		paths: {
			"/api/v1/tools": { get: { operationId: "listOperations", summary: "List operations allowed by this token", responses: { "200": { description: "Tools with JSON Schema inputs" }, "401": { description: "Invalid token" } } } },
			"/api/v1/call": { post: { operationId: "callOperation", summary: "Run an operation in the token's workspace", requestBody: { required: true, content: { "application/json": { schema: { oneOf: integrationTools(Object.keys(integrationScopes)).map(t => ({ type: "object", required: ["operation", "input"], properties: { operation: { const: t.name }, input: t.inputSchema }, additionalProperties: false })) } } } }, responses: {
				"200": { description: "Operation result in data" }, "400": { description: "Invalid arguments" }, "401": { description: "Invalid or expired token" }, "403": { description: "Missing scope or resource permission" }, "409": { description: "Idempotency key reused with different arguments" }, "413": { description: "Body exceeds 128 KiB" }, "429": { description: "Request or write limit exceeded" },
			} } },
		},
	};
}

/** The authorization server passes this request to the signed-in consent screen. */
export const integrationConsentSchema = z.object({ clientId: z.string().max(2048), redirect: z.string().max(2048), resource: z.string().max(2048), challenge: z.string().max(128), scopes: z.array(integrationScope).max(20), state: z.string().max(2048) }).strict();
export type IntegrationConsentRequest = z.infer<typeof integrationConsentSchema>;
