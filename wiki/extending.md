# Extending

Rules each system relies on. Break one and something leaks or breaks silently.

## Permissions — `core/src/permissions.ts`
- Every workspace action has a permission listing the roles allowed. Backend mutations call `requirePermission(ctx, "x.y")`; the app calls `can(role, "x.y")`.
- New feature that needs a gate → add a permission first. Never check `role === "owner"` directly.
- New role → add it to `Role` (`types.ts`) and to `role` in `backend/convex/schema.ts`, then to each permission it should have.

## Tools — `core/src/tools.ts`, `builtin-tools.ts`
- One shape (`ToolDef`) for built-ins and connector tools. Ids are `group.name`; model names come from `modelToolName`.
- Add a built-in: `defineTool` in `builtin-tools.ts`. Set `roles` if not everyone may trigger it, and `readOnly: true` if it changes nothing.
- Tools reach data only through `ToolContext` (`memory`, `chat`, `skills`), which enforce permissions. Don't do permission checks inside tools.
- Agents grant exact ids or whole groups (`memory.*`). `resolveTools` is the only place that decides what the model sees.

## Connectors — `core/src/connectors.ts`, `mcp.ts`, `backend/convex/connectors.ts`
- A connector is a catalog entry pointing at a remote MCP server. Add it with `defineConnector` to `connectorCatalog`; `validateConnector` must pass (https only).
- `connection: "workspace"` = one shared account, set by owners. `"personal"` = each person connects their own; agents use the account of the person they're helping.
- Tools are discovered each turn (`openConnector`) as `<connector>.<tool>`. Agents usually grant `<connector>.*`.
- Connector tools load on demand (`connector-tools.ts`): the model gets two fixed tools, `connectors_search` (an empty query lists every tool plus the server's usage notes; words or exact ids return input schemas) and `connectors_call`. Never hand connector schemas to the model up front: one server can be 50k+ tokens per call, and a changing tool list breaks prompt caching.
- Credentials: `ConnectorCredentials`, encrypted in an **action** (`crypto.ts`) and decrypted only by the agent runner. Never return them from a query.
- Access = installed + role allowed (`connectorInstalls.roles`) + connected. Checked fresh each turn (`connectors.forTurn`).
- Auth: `none`, `api_key` (pasted in), or `oauth` (MCP OAuth: discovery, dynamic client registration, PKCE, refresh — all via `@ai-sdk/mcp`). OAuth flow: `connectors.startOAuth` → browser → `GET /oauth/callback` (`backend/convex/oauth.ts`) → `saveConnection`. State lives in `OAuthState` (`core/src/oauth.ts`), encrypted like any credentials. The runner saves refreshed tokens after each turn.
- Connector results keep structure (`structuredContent`, or JSON text) so widgets can show them by ref.
- Not built yet: approvals for write tools (use `readOnly`), per-tool policy, pre-registered OAuth clients (servers without dynamic registration).
- Test with `fakeMcpServer` (`core/src/test-mcp-server.ts`), or push a test connector into `connectorCatalog` (see backend tests).

## Widgets — `core/src/widgets.ts`, `desktop/src/renderer/src/widgets.tsx`
- Add one: `defineWidget` (type, description, zod `input`, `summary`, optional `prepare`) in `widgetCatalog`, then a component in the desktop `registry`. That's all; the tool `widgets.<type>` appears automatically.
- `description` and `.describe()` on input are how the model learns to use it. Write them for the model.
- **Refs:** tools with `returnsData` (connector tools, `memory.search`) reach the model as `{ ref: "r1", data }`, and their data is kept for the turn (`ResultStore`). A widget's `prepare` can look a ref up, so the model points at data instead of copying it (see `table`'s `from`). The model still sees the data; it just doesn't re-type it.
- `prepare` returns concrete props, which are stored and rendered by the app, so keep them plain data. Older apps show a placeholder for unknown types.
- Widgets are generic UI, not tied to a skill or connector. Skills and connectors produce data; any widget can show it.
- Connector-provided UI later: MCP Apps (`@ai-sdk/mcp` supports them) in a sandboxed frame, not this registry.

## Teaching agents — `core/src/guide.ts`
- App-wide rules for how replies render live in `platformGuide`, added after each agent's own instructions. Change them there, never in default agent instructions.
- Add a section only when the agent has the matching tools, so prompts stay small.

## Skills — `core/src/skills.ts`
- Add one with `defineSkill` to `skillCatalog`. Owners install per workspace.
- Agents with `skills.load` see installed skills' one-line descriptions and load full text on demand. Keep descriptions short; they're in every prompt.

## Automations — `core/src/automations.ts`, `backend/convex/automations.ts`
- Add one with `defineAutomation` to `automationCatalog`: trigger, `connectors` it needs (must be installed first), and the `prompt` the agent gets. `details` is the Markdown on its detail page.
- Triggers: `schedule` or `webhook`. A library automation can require a named event (add it to `automationEvents`, set `event` on the trigger); owner-made ones take any webhook. Give webhook triggers a `sample` ("Run now" sends it). Senders POST to the install's URL; there's no other way in.
- Owner-made automations: `CustomAutomationConfig`, checked by `customAutomationError` on create and save, turned into an `Automation` by `customAutomation`. Saves send `expectedVersion`.
- Webhook data is untrusted: it only ever reaches the model inside `eventPrompt`'s fenced block, never as instructions or as who to act as. `person.email` must match a workspace member.
- Runs post into the person's agent DM (`findOrCreateDm` + `insertMessage`), or the picked channel, and queue a turn with `enqueueTurn`, acting as a real member, the same path as a message they send. Don't give automations their own permission path.

## Memory — `core/src/memory.ts`, `backend/convex/memoryOps.ts`
- Each memory belongs to one agent; scope `workspace` or `personal`. Rules live in `canReadMemory` / `canEditMemory` / `canCreateMemory`.
- App and agents both go through `memoryOps.ts`, so they can't drift. Agent calls re-read membership each call.
- Edits from the app send `expectedVersion`; agents edit the latest.

## Agents — `core/src/agents.ts`, `backend/convex/agents.ts`
- `AgentConfig` is the editable shape (`core/src/agent-config.ts`). Stored per workspace, versioned on every save. `validateAgentConfig` runs on save; add checks there.
- The runner reads the agent fresh each turn. Anything that changes how a reply runs belongs in `turns.turnContext` + `agent.ts`; what the model is fed belongs in `core/src/turn-input.ts`.

## The app and `core`
- The app imports only dependency-free modules from core, by deep path: `@companybot/core/permissions`, `@companybot/core/agent-config`. Importing the barrel would bundle the agent runtime (`ai`, zod) into the renderer. To expose another module, add it to `exports` in `core/package.json`.

## Shared settings
- Editable shared data gets a `version` field. Saves send the version they started from; `checkVersion` refuses stale ones. In the app, use `useDraft` + `ConflictNotice`.

## Before you finish
`pnpm typecheck && pnpm test`. Add a test for every new permission rule.
