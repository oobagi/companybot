# External API and MCP

An outside app can read and update Companybot using a personal, workspace-bound API token. The HTTP API and inbound MCP endpoint use the same operations and permission checks. They do not adapt Slack's event protocol or install an existing Slack bot unchanged.

## Connect

Open **Settings > API access** in the intended workspace. Creating tokens requires the `integrations.manage` role switch, off for Members by default. Give the token a name, choose scopes, and copy the secret once into the client's secret storage. Only a SHA-256 hash is stored. Each token is bound to the issuing membership, so leaving and rejoining does not revive it.

Read scopes are selected initially; write scopes are off. Expiration defaults to 30 days, with a maximum of 90. Each person can have ten active tokens per workspace. Revoke a token in the same screen. Revocation, expiration, workspace reset/deletion, account erasure, membership removal, or losing the role switch ends access. Current role and place permissions are checked on every request, including retries.

The displayed base URL is the Convex **HTTP actions** origin (`https://<deployment>.convex.site`), not the `.convex.cloud` function URL. Use HTTPS and send `Authorization: Bearer <token>`. Tokens grant the selected operations as their issuing person. **Write scopes authorize immediate writes without chat approval cards**. Agent action rules continue to govern agent actions; they do not override an explicit external API grant.

## HTTP API v1

- `GET /api/v1/openapi.json`: OpenAPI 3.1 contract, public.
- `GET /api/v1/schema`: operation names and JSON Schema inputs, public.
- `GET /api/v1/tools`: operations allowed by the authenticated token.
- `POST /api/v1/call`: `{ "operation": "<name>", "input": { ... } }`. Returns `{ "data": ... }` or `{ "error": "..." }` with the appropriate HTTP status.

For example, using a token supplied through a secret manager:

```sh
curl "$COMPANYBOT_URL/api/v1/call" \
  -H "Authorization: Bearer $COMPANYBOT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"operation":"databases_list","input":{}}'
```

| Scope | Operations |
| --- | --- |
| `workspace:read` | `workspace_get` |
| `records:read` | `databases_list`, `records_list`, `records_get` |
| `records:write` | `records_create`, `records_update` |
| `pages:read` | `pages_list`, `pages_get` |
| `pages:write` | `pages_create`, `pages_append` |
| `chats:read` | `chats_list`, `messages_list` |
| `chats:write` | `messages_post` |

Use ids returned by the API. Record values are keyed by field key; database discovery returns field schemas. Page reads return a ProseMirror document JSON string with the viewer's redactions; page writes accept plain text paragraphs. Chat reads use the same privacy masking as the app. Chat posts are labeled as external integration content and do not wake agents, start automations, steer running turns, or reset chain budgets. They remain untrusted data in later model context.

Lists accept `cursor` (initially null) and `limit` (default 25, maximum 50). Read `page`, `isDone`, and `continueCursor`. A page may be empty after permission filtering while `isDone` is false; continue with its cursor. Never combine cursors across operations or filters.

Every write requires a unique `requestKey` of 16 to 100 characters. Use a UUID, retaining the same key and exact arguments for a retry. Successful writes and receipts commit atomically. A key reused with different arguments returns 409. Receipts last 24 hours; after that a key may execute again. There are 128 distinct successful writes per token per rolling 24 hours and 60 requests per minute. Payloads are limited to 128 KiB. Current permissions are checked before returning a prior receipt. Token settings show last use and last operation; record/page history also records the issuing person. This is not a full external-request audit log.

## Inbound MCP

Configure a client that supports a custom bearer header:

```json
{
  "url": "https://<deployment>.convex.site/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

This is stateless **Streamable HTTP**, supporting protocol revision `2026-07-28` and older revisions `2025-11-25`, `2025-06-18`, and `2025-03-26`. It implements modern server/discover, legacy initialization, ping, tools/list and tools/call, returning JSON responses. Modern requests require matching protocol/method/name headers and per-request version/capability metadata. Results include resultType and server metadata. Send both `application/json` and `text/event-stream` in Accept. Notifications receive 202; standalone GET streams and DELETE sessions receive 405. No session ids, resource subscriptions, prompts, sampling or server-initiated requests are advertised. Tool discovery includes only operations allowed by the token. Tool errors return `isError`; invalid protocol requests use JSON-RPC errors.

Unknown protocol versions receive an unsupported-version error listing the supported versions. Inbound authorization currently uses manually issued bearer tokens, not an OAuth authorization server or browser consent discovery. Clients requiring OAuth-only connections need an additional integration. Outbound connector OAuth is separate and unchanged.

Requests with an Origin header must match the HTTP actions origin or a comma-separated exact origin in the deployment's `INTEGRATION_ALLOWED_ORIGINS`. No wildcard is enabled by default. Server clients without Origin work normally. Only explicitly allowed browser origins receive CORS headers. Never put a personal token in publicly shipped frontend code.

Protocol references: [Streamable HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [newer version compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

## Outbound rich MCP results

Text-only results keep the existing string/JSON behavior. Mixed results preserve text, structuredContent, images, audio, embedded resources, resource links, and error status. Connector discovery remains paginated.

The runner stores supplied binary data in `connectorArtifacts`, separate from message documents. Images are checked against their byte signatures; audio uses a supported media type; other blobs are served as download-only octet streams. Only the acting person, with their original membership and current chat/source access, can retrieve artifact links through the app. **Tool activity** displays images, audio players, and file links even if the text excerpt was clipped or the tool returned an error. Artifacts are deleted with their workspace, membership, account, or turn's cascade. Storage links are bearer URLs, like existing chat attachment URLs; anyone they are deliberately shared with can use them until the file is deleted.

Vision-enabled models receive native image content, including after an approved call. Audio and other binary files remain available to the person, with an explicit model note that it cannot interpret them. Audio transcription and general binary interpretation are not implemented. Embedded text goes to the model; resource links remain metadata and are never automatically fetched. Historical turn replay keeps a bounded text summary rather than re-sending media bytes.

Limits: 32 content blocks, 16 MiB serialized result, 6 MiB per binary file, 32 KB each of mixed text and structured data, and 20 artifacts per turn. Oversize or invalid results fail visibly rather than silently dropping blocks. A tool may already have performed an external action before returning an invalid result; do not blindly retry writes.

## Code

- `core/integration-api.ts`: scope and operation contract, JSON Schema, OpenAPI.
- `backend/integrationTokens.ts`, `integrationOps.ts`, `integrationHttp.ts`: credential lifecycle, shared dispatch, HTTP/MCP framing.
- `core/mcp.ts`, `mcp-content.ts`, `connector-tools.ts`: outgoing tool results and model conversion.
- `backend/connectorArtifacts.ts`: media storage and viewer checks.
- Settings > API access and tool Activity: user controls and returned media.
