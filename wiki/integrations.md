# External API and MCP

An outside app can read and update Companybot using browser OAuth consent or a personal, workspace-bound API token. The HTTP API and inbound MCP endpoint use the same operations and permission checks. They do not adapt Slack's event protocol or install an existing Slack bot unchanged.

## Connect

Open **Settings > API access** in the intended workspace. Creating tokens requires the `integrations.manage` role switch, off for Members by default. Give the token a name, choose scopes, and copy the secret once into the client's secret storage. Only a SHA-256 hash is stored. Each token is bound to the issuing membership, so leaving and rejoining does not revive it.

Read scopes are selected initially; write scopes are off. Expiration defaults to 30 days, with a maximum of 90. Each person can have ten active tokens per workspace. Revoke a token in the same screen. Revocation, expiration, workspace reset/deletion, account erasure, membership removal, or losing the role switch ends access. Current role and place permissions are checked on every request, including retries.

The displayed base URL is the Convex **HTTP actions** origin (`https://<deployment>.convex.site`), not the `.convex.cloud` function URL. Use HTTPS and send `Authorization: Bearer <token>`. Tokens grant the selected operations as their issuing person. **Write scopes authorize immediate writes without chat approval cards**. Agent action rules continue to govern agent actions; they do not override an explicit external API grant.

## Browser OAuth consent

An OAuth-capable client can connect to `/mcp` without asking the person to copy a token. A 401 response advertises protected-resource metadata; that metadata points to `/.well-known/oauth-authorization-server`. HTTP API clients use resource `${CONVEX_SITE_URL}/api/v1`; MCP clients use `${CONVEX_SITE_URL}/mcp`. These audiences are distinct. OAuth tokens issued for one cannot be used at the other. Manually created tokens retain access to both.

**Deployment setup:** set `INTEGRATION_APP_URL` to the HTTPS URL serving the Companybot web app. Authorization redirects to that fixed app URL for sign-in and consent; it never derives this destination from a client request. `CONVEX_SITE_URL` is the issuer. For local development only, the app URL may use HTTP localhost or 127.0.0.1. No deployment or live client login is implied by these code changes. Settings > API access reports **OAuth setup required** until both the API origin and consent app URL are valid, then **Configured**. This checks configuration only, not reachability or a completed provider login. Manual tokens remain available independently. Invalid consent URLs produce a setup error before redirecting.

The person signs in with the existing Companybot sign-in, selects a workspace, reviews the application's full redirect address, and allows selected scopes or denies the request. Requested read scopes start selected; write scopes start off. The developer-supplied application name is explicitly unverified. Consent requires `integrations.manage` and grants access as that person in that membership, for up to 30 days. It does not grant administrator or workspace-wide service-account authority. OAuth connections appear beside manual tokens in Settings > API access and share the ten-active-credentials limit.

Supported client registration:

- **Client ID Metadata Documents (CIMD):** use an HTTPS URL with a path as `client_id`. Its JSON document must contain the exact matching `client_id`, `client_name`, and one to five `redirect_uris`. Fetches reject redirects, credentials in URLs, query strings, fragments, private DNS results and bodies over 16 KiB; connections use the checked IP addresses. Metadata is cached for at most five minutes, honoring shorter max-age or revalidating no-cache/no-store responses on each authorization start. A validated registration backs the consent for five minutes and issued grants afterward.
- **Dynamic registration fallback:** `POST /integrations/oauth/register` with JSON `{ "client_name": "Example", "redirect_uris": ["https://client.example/callback"], "token_endpoint_auth_method": "none" }`. The response contains `client_id`. Registrations are bounded to 100 new clients per hour for the deployment and expire after 30 inactive days.

This implements the **public-client authorization-code profile**, with mandatory S256 PKCE, exact registered redirect matching, a required resource indicator, five-minute single-use codes, one-hour access tokens, rotating refresh tokens and RFC 7009 revocation. HTTPS redirects and exact HTTP loopback redirects (localhost, 127.0.0.1, ::1) are supported. Wildcards, implicit/password/client-credentials grants, confidential-client secrets, private_key_jwt and OIDC identity tokens are not advertised. This is delegated API access, not a new Companybot login provider.

Endpoints: `GET /integrations/oauth/authorize`, `POST /integrations/oauth/token`, `POST /integrations/oauth/revoke`. Token and revocation bodies use `application/x-www-form-urlencoded`; token exchange includes `client_id` and `resource`, plus `code`, `redirect_uri`, and `code_verifier` for an authorization code, or `refresh_token` for renewal. Revocation includes `client_id` and `token`. Access, code and refresh secrets are stored as hashes. A used code or refresh token presented again with the matching client/bindings revokes the grant. Refresh is limited to once per minute, may narrow scopes, and cannot extend the 30-day consent lifetime. Membership, role and expiration are rechecked on exchange, refresh and every API call. Rejoining never restores an old grant.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [OAuth security](https://www.rfc-editor.org/rfc/rfc9700), [revocation](https://www.rfc-editor.org/rfc/rfc7009).

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
| `records:write` | `records_create`, `records_update`, `records_archive` |
| `pages:read` | `pages_list`, `pages_get` |
| `pages:write` | `pages_create`, `pages_append`, `pages_rename`, `pages_archive` |
| `chats:read` | `chats_list`, `messages_list`, `messages_get` |
| `chats:write` | `messages_post`, `messages_edit`, `messages_delete` |
| `events:read` | `events_list` (also requires the corresponding resource read scope) |

Use ids returned by the API. Record values are keyed by field key; database discovery returns field schemas. Page reads return a ProseMirror document JSON string with the viewer's redactions; page writes accept plain text paragraphs. Chat reads use the same privacy masking as the app. Chat posts are labeled as external integration content and do not wake agents, start automations, steer running turns, or reset chain budgets. They remain untrusted data in later model context. A connection can edit or delete only the messages it created, not the person's normal messages or another connection's messages. Archive operations accept `archived: true` or `false` for archive/restore; page rename/archive reuse the app's restrictions on record bodies and inherited access.

Lists accept `cursor` (initially null) and `limit` (default 25, maximum 50). Read `page`, `isDone`, and `continueCursor`. A page may be empty after permission filtering while `isDone` is false; continue with its cursor. Never combine cursors across operations or filters.

Every write requires a unique `requestKey` of 16 to 100 characters. Use a UUID, retaining the same key and exact arguments for a retry. Successful writes and receipts commit atomically. A key reused with different arguments returns 409. Receipts last 24 hours; after that a key may execute again. There are 128 distinct successful writes per token per rolling 24 hours and 60 requests per minute. Payloads are limited to 128 KiB. Current permissions are checked before returning a prior receipt. Token settings show last use and last operation; record/page history also records the issuing person.

### Request history

Settings > API access shows 30 days of the current member's external requests, including successes, retries, validation failures, denied operations and protocol errors after a recognized credential was supplied. Rate-limit bursts record the first refused request per minute instead of allowing unlimited log growth. Each admitted request is recorded before execution and finished with its outcome; a crash leaves it marked Unfinished. The response includes `X-Request-Id` for correlation. MCP tool errors retain their actual operation status in the log even when JSON-RPC returns HTTP 200. Logs contain request id, transport, known operation, status, timestamp and internal credential identity. They never contain bodies, results, resource names, IP addresses, URLs, tokens or signing secrets. Other members cannot read these logs. Requests with missing/unknown credentials, early origin/method rejection and OAuth registration/exchange traffic are not attributed to a person's request history. This is not a general workspace administrator audit log.

## Inbound MCP

Configure a client that supports a custom bearer header:

```json
{
  "url": "https://<deployment>.convex.site/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

This is stateless **Streamable HTTP**, supporting protocol revision `2026-07-28` and older revisions `2025-11-25`, `2025-06-18`, and `2025-03-26`. It implements modern server/discover, legacy initialization, ping, tools/list and tools/call, returning JSON responses. Modern requests require matching protocol/method/name headers and per-request version/capability metadata. Results include resultType and server metadata. Send both `application/json` and `text/event-stream` in Accept. Notifications receive 202; standalone GET streams and DELETE sessions receive 405. No session ids, resource subscriptions, prompts, sampling or server-initiated requests are advertised. Tool discovery includes only operations allowed by the token. Tool errors return `isError`; invalid protocol requests use JSON-RPC errors.

Unknown protocol versions receive an unsupported-version error listing the supported versions. Inbound authorization supports the OAuth profile above as well as manually issued bearer tokens. Missing scope returns an insufficient_scope challenge naming the required scope. Outbound connector OAuth is separate and unchanged.

Requests with an Origin header must match the HTTP actions origin or a comma-separated exact origin in the deployment's `INTEGRATION_ALLOWED_ORIGINS`. No wildcard is enabled by default. Server clients without Origin work normally. Only explicitly allowed browser origins receive CORS headers. Never put a personal token in publicly shipped frontend code.

Protocol references: [Streamable HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [newer version compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).

## Events and outbound webhooks

`events_list` provides content-free notices `{id, type, resourceId, at}` for record create/update/archive/restore, page create/content/rename/move/archive/restore, posted or edited/deleted/shared messages, and completed visible agent replies. It uses a monotonic workspace sequence cursor so the same cursor still works when new changes arrive after the feed was empty. Continue empty filtered pages until `isDone`; save `continueCursor` and poll it later. A credential sees events from its creation onward, retained for seven days. An application offline longer than seven days must resync through the ordinary list operations. The feed does not cover reactions, database schema changes, permissions, file uploads or hard-deletion tombstones.

Events require `events:read` **and** the corresponding `records:read`, `pages:read` or `chats:read` scope. Current resource permissions, message source privacy, quiet-message rules, and membership are checked on each read and delivery attempt. Deleted or inaccessible resources disappear from the feed. Fetch current content through `records_get`, `pages_get` or `messages_get`; an event is not a saved copy of old content.

In Settings > API access, add a public HTTPS webhook destination and choose your credential with `events:read` plus the read scopes it needs. The signing secret is shown once and stored encrypted with `CONNECTIONS_KEY`. Up to five destinations per person/workspace are allowed. If secure signing-secret storage is missing or invalid, Settings shows **Webhook setup required**, disables creation and explains who can complete setup. Network and HTTP delivery failures include recovery guidance. Destinations may not contain query parameters, fragments or credentials. Every send checks DNS and pins public IP addresses, rejects redirects, limits the request to ten seconds, and discards the response body.

A scheduler checks up to 25 due subscriptions each minute. A webhook sends only `{ "id": "<delivery id>", "type": "events.available", "createdAt": 123 }` when it finds accessible new events. It does not send workspace content or resource ids. The receiver then drains `events_list` with its own stored cursor and credential. Webhooks begin with changes after the subscription was created. A notification already in flight can arrive after revocation; the following API read still checks current authorization.

Headers:

- `Companybot-Delivery`: stable delivery id for deduplication.
- `Companybot-Signature`: `t=<Unix seconds>,v1=<hex HMAC-SHA256>` over `<timestamp>.<exact raw body>`, using the displayed signing secret as UTF-8.

Verify the signature using a constant-time comparison, reject timestamps more than five minutes away, deduplicate by delivery id, and return a 2xx response promptly. Delivery is at least once, with the same id/body retained across retries and a new timestamp/signature per attempt. Failed attempts back off from two minutes to a maximum of an hour and stop after five attempts. Settings shows the last status and stopped subscriptions; remove and recreate a stopped subscription to reconnect. Revocation, expired grant, member removal or role loss stops delivery. Retry cursors advance only on success or when the batch no longer contains accessible events. The event feed remains available independently for recovery.

These are Companybot events, not Slack Events API envelopes. A bot can read changes and post labeled replies through the API; an existing Slack bot still needs an adapter for its event format and behavior.

## Outbound rich MCP results

Text-only results keep the existing string/JSON behavior. Mixed results preserve text, structuredContent, images, audio, embedded resources, resource links, and error status. Connector discovery remains paginated.

The runner stores supplied binary data in `connectorArtifacts`, separate from message documents. Images are checked against their byte signatures; audio uses a supported media type; other blobs are served as download-only octet streams. Only the acting person, with their original membership and current chat/source access, can retrieve artifact links through the app. **Tool activity** displays images, audio players, and file links even if the text excerpt was clipped or the tool returned an error. Artifacts are deleted with their workspace, membership, account, or turn's cascade. Storage links are bearer URLs, like existing chat attachment URLs; anyone they are deliberately shared with can use them until the file is deleted.

Vision-enabled models receive native image content, including after an approved call. Audio and other binary files remain available to the person, with an explicit model note that it cannot interpret them. Audio transcription and general binary interpretation are not implemented. Embedded text goes to the model; resource links remain metadata and are never automatically fetched. Historical turn replay keeps a bounded text summary rather than re-sending media bytes.

Limits: 32 content blocks, 16 MiB serialized result, 6 MiB per binary file, 32 KB each of mixed text and structured data, and 20 artifacts per turn. Oversize or invalid results fail visibly rather than silently dropping blocks. A tool may already have performed an external action before returning an invalid result; do not blindly retry writes.

## Code

- `core/integration-api.ts`: scope and operation contract, JSON Schema, OpenAPI.
- `backend/integrationTokens.ts`, `integrationOAuth.ts`, `integrationOAuthHttp.ts`: manual credentials, consent, client discovery, OAuth grants.
- `backend/integrationOps.ts`, `integrationHttp.ts`: shared dispatch, HTTP/MCP framing and request audit.
- `backend/integrationEvents.ts`, `integrationWebhooks.ts`, `integrationNetwork.ts`, `integrationMaintenance.ts`: permission-filtered event feed, notifications, pinned networking, bounded retention cleanup.
- `core/mcp.ts`, `mcp-content.ts`, `connector-tools.ts`: outgoing tool results and model conversion.
- `backend/connectorArtifacts.ts`: media storage and viewer checks.
- Settings > API access and tool Activity: user controls and returned media.

## Availability and error-state review (November 14, 2026)

OAuth, token API access, webhooks and connectors are implemented features: missing deployment configuration is labeled **Setup required**, not **Coming soon**. Connector settings check credential encryption and, for OAuth, the callback origin before offering connection; outbound connector OAuth does not depend on the inbound consent app URL. Setup checks return only status and public callback addresses, never secrets. Failed consent can be retried without approving access, and webhook/request lists distinguish loading from empty results.

The existing Home, Inbox, Sites, agent contact methods, unfinished Drive views, record lists and calendar/form/gallery layouts already show Coming soon descriptions. This review covered those placeholders and integration setup/error paths; it is not a whole-app accessibility or live-provider audit.
