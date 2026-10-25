# Extending

Rules each system relies on. Break one and something leaks or breaks silently.

## Permissions — `core/src/permissions.ts`
- Every workspace action has a permission listing the roles allowed. Backend mutations call `requirePermission(ctx, "x.y")`; the app calls `can(role, "x.y")`.
- New feature that needs a gate → add a permission first. Never check `role === "owner"` directly.
- New role → add it to `Role` (`types.ts`) and to `role` in `backend/convex/schema.ts`, then to each permission it should have.

## Tools — `core/src/tools.ts`, `builtin-tools.ts`
- One shape (`ToolDef`) for built-ins and connector tools. Ids are `group.name`; model names come from `modelToolName`.
- Add a built-in: `defineTool` in `builtin-tools.ts`. Set `roles` if not everyone may trigger it, `readOnly: true` if it changes nothing, and `risk` if it reaches outside (see Approvals).
- Tools reach data only through `ToolContext` (`memory`, `chat`, `skills`, `automations`), which enforce permissions. Don't do permission checks inside tools.
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
- Writes ask: connector tools without `readOnlyHint` wait for a yes in the chat; `destructiveHint` ones always ask (see Approvals). The tool list each server reports is saved to `connectorTools` for settings screens only. Not built yet: pre-registered OAuth clients (servers without dynamic registration).
- Test with `fakeMcpServer` (`core/src/test-mcp-server.ts`), or push a test connector into `connectorCatalog` (see backend tests).

## Approvals — `core/src/approvals.ts`, `backend/convex/approvals.ts`, `backend/convex/permissions.ts`
- **Declare risk on the tool** (`ToolDef.risk`): `"outside"` for anything with outside impact (sends, texts, calls, campaign sends), `"locked"` for payments, deleting records and bulk sends (always asks, no "Always allow"). Leave it out for internal changes. Connector tools default to `"outside"` unless read-only (`toolRisk`).
- **Every call is decided fresh:** the runner passes `toolApprovalPolicy(usable, check)` as the AI SDK's `toolApproval`; `check` runs `permissions.check` (person's rules, owner locks, automation grants; `permissionFor`, strictest wins). Ask → the run stops at the call, unexecuted. Deny → the model gets the reason. Run with a rule → logged with `allowed` (how, who, when, rule id). Never cache a decision into a session or prompt.
- Built-ins with no risk skip the check entirely. Connector reads are checked (owners may lock them).
- Held calls: the runner saves the exact call (`approvals.request`, with its `risk`) and puts an `approval` part in the reply. The app shows it as its own message from the agent ([Permissions](permissions.md) → The card).
- Lock: `approvalHash` = SHA-256 of canonical JSON of tool id + input. The app sends back the hash it showed; `decide` refuses any other; `claim` re-hashes the stored call and re-checks rules before it runs. Compare nothing else: unrelated changes must never block or void an approval.
- Who: only the person the agent acts for (`canDecideApproval`), while they can see the chat, within 24h. Owners can't approve for others; the call runs with that person's access and accounts.
- `decide({ always: true })` also saves an Always rule (scoped to the automation if the run was one's). Refused where the action always asks. Older apps send only `approve` and keep working.
- After a decision: `decide` queues a normal turn in the same place with `approvalId` (so one turn per place still holds). That turn runs the approved call first (approved only), then the agent is told the outcome in its new prompt (`approval` in `buildTurnPrompt`). Replies note held calls without their outcome, so replays stay byte-identical.
- Rules and locks key on person + action (+ connector install, + automation install for grants). Uninstalling a connector or removing an automation deletes theirs. Wording for "Always allow" comes only from `alwaysAllowText`, so the card and Settings say the same thing.
- Test new rules in `backend.test.ts` → `permissions`.

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
- Anyone can make their own (`skills.create` permission; `create` / `save` in `backend/convex/skills.ts`, or the `skills.create` agent tool; the guide adds a short how-to when it's granted). The maker or an owner can edit or delete (`canEditMade`). They live on their `skillInstalls` row (`custom`, id `custom-…`), are always installed, and `installedSkills` turns them into the same `Skill` shape, so agents can't tell them apart. Limits are in `customSkillError`: name 64 and no tags (Claude's SKILL.md rules), description 200 (stricter than Claude's 1,024, since it's in every prompt), instructions 20k chars.

## Automations — `core/src/automations.ts`, `backend/convex/automations.ts`
- Add one with `defineAutomation` to `automationCatalog`: trigger, `connectors` it needs (must be installed first), and the `prompt` the agent gets. `details` is the Markdown on its detail page.
- Triggers: `schedule`, `event` (in-app: add it to `appEvents` and call `fireEvent` where it happens), or `webhook`. A library automation can require a named event (add it to `webhookEvents`, set `webhookEvent` on the trigger); ones people make take any webhook. Give webhook triggers a `sample` ("Run now" sends it). Senders POST to the install's URL; there's no other way in.
- Member-made automations: `CustomAutomationConfig`, checked by `customAutomationError` on create and save, turned into an `Automation` by `customAutomation`. Saves send `expectedVersion`.
- Webhook data is untrusted: it only ever reaches the model inside `triggerPrompt`'s fenced block, never as instructions or as who to act as. `person.email` must match a workspace member.
- Runs go to the audience: each opted-in person's agent DM (`findOrCreateDm` + `insertMessage`), or the picked channel. Never message people who didn't opt in. Each run queues a turn with `enqueueTurn`, acting as a real member, the same path as a message they send. Don't give automations their own permission path.

## Memory — `core/src/memory.ts`, `backend/convex/memoryOps.ts`
- Each memory belongs to one agent; scope `workspace` or `personal`. Rules live in `canReadMemory` / `canEditMemory` / `canCreateMemory`.
- App and agents both go through `memoryOps.ts`, so they can't drift. Agent calls re-read membership each call.
- Edits from the app send `expectedVersion`; agents edit the latest.

## Agents — `core/src/agents.ts`, `backend/convex/agents.ts`
- `AgentConfig` is the editable shape (`core/src/agent-config.ts`). Stored per workspace, versioned on every save. `validateAgentConfig` runs on save; add checks there.
- The runner reads the agent fresh each turn. Anything that changes how a reply runs belongs in `turns.turnContext` + `agent.ts`; what the model is fed belongs in `core/src/turn-input.ts`.

## The app and `core`
- The app imports only dependency-free modules from core, by deep path: `@companybot/core/permissions`, `@companybot/core/agent-config`. Importing the barrel would bundle the agent runtime (`ai`, zod) into the renderer. To expose another module, add it to `exports` in `core/package.json`.

## Things people make
- Skills and automations share `canEditMade(who, managePermission, createdBy)` and one denial message. Pass no creator for library installs. Skills store the maker in `custom.createdBy`; automations use `installedBy`.
- Trim configs only in core (`normalizeCustomSkill` / `normalizeCustomAutomation`). Backend `madeCustom` adds creation metadata; `saveMade` checks the version, validates, then patches the next version and editor metadata. Agent creation uses `asToolResult` for expected errors.
- Delete custom items or uninstall library ones with `skills.remove` / `automations.remove`. `setInstalled(false)` stays for older apps; automation removal needs no time zone. New installs still need one.
- `ToolContext.skills` holds the installed `list` and `create`, like the automations store.

## Shared settings
- Editable shared data gets a `version` field. Saves send the version they started from; `checkVersion` refuses stale ones. In the app, use `useDraft` + `ConflictNotice`.

## Before you finish
`pnpm typecheck && pnpm test`. Add a test for every new permission rule.
