# Extending

Rules each system relies on. Break one and something leaks or breaks silently.

## Permissions — `core/src/permissions.ts`
- Every workspace action has a permission listing the roles allowed. Backend mutations call `requirePermission(ctx, "x.y")`; UI reads the same table.
- New feature that needs a gate → add a permission first. Never check `role === "owner"` directly.
- New role → add it to `Role` (`types.ts`) and to `role` in `backend/convex/schema.ts`, then to each permission it should have.

## Tools — `core/src/tools.ts`, `builtin-tools.ts`
- One shape (`ToolDef`) for built-ins and plugin tools. Ids are `group.name`; model names come from `modelToolName`.
- Add a built-in: `defineTool` in `builtin-tools.ts`. Set `roles` if not everyone may trigger it, and `readOnly: true` if it changes nothing.
- Tools reach data only through `ToolContext` (`memory`, `skills`), which enforce permissions. Don't do permission checks inside tools.
- Agents grant exact ids or whole groups (`memory.*`). `resolveTools` is the only place that decides what the model sees.

## Plugins — `core/src/plugins.ts`, `mcp.ts`, `backend/convex/plugins.ts`
- A plugin is a catalog entry pointing at a remote MCP server. Add it with `definePlugin` to `pluginCatalog`; `validatePlugin` must pass (https only).
- `connection: "workspace"` = one shared account, set by owners. `"personal"` = each person connects their own; agents use the account of the person they're helping.
- Tools are discovered each turn (`openPlugin`) as `<plugin>.<tool>`. Agents usually grant `<plugin>.*`.
- Credentials: `PluginCredentials`, encrypted in an **action** (`crypto.ts`) and decrypted only by the agent runner. Never return them from a query.
- Access = installed + role allowed (`pluginInstalls.roles`) + connected. Checked fresh each turn (`plugins.forTurn`).
- Not built yet: OAuth sign-in (`auth.type: "oauth"`), approvals for write tools (use `readOnly`), per-tool policy.
- Test with `fakeMcpServer` (`core/src/test-mcp-server.ts`), or push a test plugin into `pluginCatalog` (see backend tests).

## Widgets — `core/src/widgets.ts`, `desktop/src/renderer/src/widgets.tsx`
- Add one: `defineWidget` (type, description, zod `props`, `summary`, optional `check`) in `widgetCatalog`, then a component in the desktop `registry`. That's all; the tool `widgets.<type>` appears automatically.
- `description` and `.describe()` on props are how the model learns to use it. Write them for the model.
- Props are stored as-is and rendered by the app, so keep them plain data. Older apps show a placeholder for unknown types.
- Plugin-provided UI later: MCP Apps (`@ai-sdk/mcp` supports them) in a sandboxed frame, not this registry.

## Teaching agents — `core/src/guide.ts`
- App-wide rules for how replies render live in `platformGuide`, added after each agent's own instructions. Change them there, never in default agent instructions.
- Add a section only when the agent has the matching tools, so prompts stay small.

## Skills — `core/src/skills.ts`
- Add one with `defineSkill` to `skillCatalog`. Owners install per workspace.
- Agents with `skills.load` see installed skills' one-line descriptions and load full text on demand. Keep descriptions short; they're in every prompt.

## Memory — `core/src/memory.ts`, `backend/convex/memoryOps.ts`
- Each memory belongs to one agent; scope `workspace` or `personal`. Rules live in `canReadMemory` / `canEditMemory` / `canCreateMemory`.
- App and agents both go through `memoryOps.ts`, so they can't drift. Agent calls re-read membership each call.
- Edits from the app send `expectedVersion`; agents edit the latest.

## Agents — `core/src/agents.ts`, `backend/convex/agents.ts`
- Stored per workspace, versioned on every save. `validateAgentConfig` runs on save; add checks there.
- The runner reads the agent fresh each turn. Anything that changes how a reply runs belongs in `chat.turnContext` + `agent.ts`.

## Shared settings
- Editable shared data gets a `version` field. Saves send the version they started from; `checkVersion` refuses stale ones. In the app, use `useDraft` + `ConflictNotice`.

## Before you finish
`pnpm typecheck && pnpm test`. Add a test for every new permission rule.
