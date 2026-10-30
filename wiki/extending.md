# Extending

Rules each system relies on. Break one and something leaks or breaks silently.

## Permissions — `core/src/permissions.ts`
- Every workspace action has a permission listing the roles allowed. Backend mutations call `requirePermission(ctx, "x.y")`; the app calls `can(role, "x.y")`.
- New feature that needs a gate → add a permission first. Never check `role === "owner"` directly.
- New role → add it to `roles` (`types.ts`; the schema's `role` validator is built from it), then to each permission it should have.

## Tools — `core/src/tools.ts`, `builtin-tools.ts`
- One shape (`ToolDef`) for built-ins and connector tools. Ids are `group.name`; model names come from `modelToolName`.
- Add a built-in: `defineTool` in `builtin-tools.ts`. Set `permission` if not everyone may trigger it (checked through the role table, like everything else), `readOnly: true` if it changes nothing, and `risk` if it reaches outside ([Permissions](permissions.md)).
- Tools reach data only through `ToolContext` (`memory`, `chat`, `skills`, `automations`, `records`, `pages`, `manage`, `web`), which enforce permissions. Don't do permission checks inside tools.
- Agents grant exact ids or whole groups (`memory.*`). `resolveTools` is the only place that decides what the model sees.

## Web — `core/src/web.ts`, `web-search.ts`, `safe-fetch.ts`, `backend/convex/webFetch.ts`
- New search provider: one function returning a `SearchProvider` (`search(query, { limit })` → title, url, snippet, published) in `web-search.ts`, picked by name in `searchProvider`. Test it with a stubbed `fetch`.
- `createWebTurn` is the only place that decides what `web.fetch` may open and how many calls a reply gets. Never let a fetch skip it, and never loosen `urlKey` to ignore the query string: that's where data would be smuggled out.
- Anything that fetches a URL someone else picked (imports, a page's picture) goes through `fetchBody` (`webFetch.ts`: `safeFetch` in a Node action, Node's DNS for `resolve` and a client that connects only to the checked addresses). Link previews (`linkUnfurl.ts`) are the model: bounded size and time, bytes sniffed before anything is stored, our own copy of any file, and the write-back rechecks the message and a live workspace.

## Connectors — `core/src/connectors.ts`, `mcp.ts`, `backend/convex/connectors.ts`
- A connector is a catalog entry pointing at a remote MCP server. Add it with `defineConnector` to `connectorCatalog`; `validateConnector` must pass (https only).
- `connection: "workspace"` = one shared account, set by owners. `"personal"` = each person connects their own; agents use the account of the person they're helping.
- Tools are discovered each turn (`openConnector`) as `<connector>.<tool>`. Agents usually grant `<connector>.*`.
- Connector tools load on demand (`connector-tools.ts`): the model gets two fixed tools, `connectors_search` (an empty query lists every tool plus the server's usage notes; words or exact ids return input schemas) and `connectors_call`. Never hand connector schemas to the model up front: one server can be 50k+ tokens per call, and a changing tool list breaks prompt caching.
- Credentials: `ConnectorCredentials`, encrypted in an **action** (`crypto.ts`) and decrypted only by the agent runner. Never return them from a query.
- Access = installed + role allowed (`connectorInstalls.roles`) + connected. Checked fresh each turn (`connectors.forTurn`).
- Auth: `none`, `api_key` (pasted in), or `oauth` (MCP OAuth: discovery, dynamic client registration, PKCE, refresh — all via `@ai-sdk/mcp`). OAuth flow: `connectors.startOAuth` → browser → `GET /oauth/callback` (`backend/convex/oauth.ts`) → `saveConnection`. State lives in `OAuthState` (`core/src/oauth.ts`), encrypted like any credentials. The runner saves refreshed tokens after each turn.
- Connector results keep structure (`structuredContent`, or JSON text) so widgets can show them by ref.
- Risk and approval rules: [Permissions](permissions.md). `backend/convex/connectorTools.ts` saves the reported tool list for settings screens only. Not built yet: pre-registered OAuth clients (servers without dynamic registration).
- Test with `fakeMcpServer` (`core/test/test-mcp-server.ts`), or push a test connector into `connectorCatalog` (see backend tests).

## Action rules and approvals
- Declare `ToolDef.risk` when adding a tool with outside impact. A built-in that changes nothing but reads what only the person sees (their chats, personal memory) declares `inside`; one that changes something harmless (display, a reaction) declares `none`. Follow [Permissions](permissions.md) for risk levels, rule order, the held-call card and replay rules.
- Use `action-words.ts` for action labels, asks, Always text and tool lines.
- Test rules in `backend/tests/permissions.test.ts`, cards in `backend/tests/approvals.test.ts`, and pure helpers in core's matching `*.test.ts` files.

## Widgets — `core/src/widgets.ts`, `desktop/src/renderer/src/widgets.tsx`
- Add one: `defineWidget` (type, description, zod `input`, `summary`, optional `prepare`) in `widgetCatalog`, then a component in the desktop `registry`. That's all; the tool `widgets.<type>` appears automatically.
- `description` and `.describe()` on input are how the model learns to use it. Write them for the model.
- **Refs:** tools with `returnsData` (connector tools, `memory.search`) reach the model as `{ ref: "r1", data }`, and their data is kept for the turn (`ResultStore`). A widget's `prepare` can look a ref up, so the model points at data instead of copying it (see `table`'s `from`). The model still sees the data; it just doesn't re-type it.
- **After a widget** the run goes on (`agentStopWhen` stops only at the step limit, `AGENT_STEPS`), so work can continue after a table. The last step offers only widgets and adds a note to answer now (`agentPrepareStep`; Sonnet ignores a narrowed tool list without it), so a reply always ends with an answer, never a lookup with no step left to use it. The receipt tells the model not to describe the widget or repeat it, and to end the reply unless the task needs more steps.
- `prepare` returns concrete props, which are stored and rendered by the app, so keep them plain data. Older apps show a placeholder for unknown types.
- Widgets are generic UI, not tied to a skill or connector. Skills and connectors produce data; any widget can show it.
- Connector-provided UI later: MCP Apps (`@ai-sdk/mcp` supports them) in a sandboxed frame, not this registry.

## Teaching agents — `core/src/guide.ts`
- App-wide rules for how replies render live in `platformGuide`, added after each agent's own instructions. Change them there, never in default agent instructions.
- Add a section only when the agent has the matching tools, so prompts stay small.

## Help — `core/src/help/`
- Docs for workspace members, not developers: plain short language, one module per area (`chat.ts`, `members.ts`…) exporting `{ id, title, summary, text }`, listed in `help/index.ts`. Plain TS strings, so they work in core, Convex's bundler and vitest alike (no `.md` loader).
- Link screens as `[Members](#/settings/members)`; `#/chat`, `#/records/<key>`, `#/pages/<page id>` and `#/settings/<tab>` are real addresses (`router.ts`), and agent replies open them in the app. Refer to another page as `**help: topic-id**`. Write only what the code or wiki says is true.
- **Add or change a settings tab or a top-level screen → update its help page in the same PR.** `desktop/.../help.test.ts` fails when a settings tab has no `(#/settings/<tab>)` link, a link names a tab that doesn't exist, or a top-level screen isn't mentioned; its message says which doc to edit. `settings.ts` lists every tab and who can change it, so keep it in step with permissions (`core/src/permissions.ts`).
- `help.read` is read-only with no permission, so every role can use it. Grant it in an agent's tools (`help.*` or `help.read`); `guide.ts` adds its line only when granted. New tools that change what people can do belong in the relevant help page too.
- Existing Companybots got `help.read` from the `companybotHelpTool` migration (only ones still on their default tools, as a new version); new workspaces from `default-agents.ts`.

## Skills — `core/src/skills.ts`
- Agents with `skills.load` see installed skills' one-line descriptions and load full text on demand. Keep descriptions short; they're in every prompt.
- Anyone can make their own (`skills.create` permission; `create` / `save` in `backend/convex/skills.ts`, or the `skills.create` agent tool; the guide adds a short how-to when it's granted). The maker or an owner can edit or delete (`canEditMade`). They live on their `skillInstalls` row (`custom`, id `custom-…`), are always installed, and `installedSkills` turns them into the same `Skill` shape, so agents can't tell them apart. Limits are in `customSkillError`: name 64 and no tags (Claude's SKILL.md rules), description 200 (stricter than Claude's 1,024, since it's in every prompt), instructions 20k chars.

## Automations — `core/src/automations.ts`
Backend: `automations.ts` (settings), `automationRuns.ts` (dispatch), `automationTools.ts` (agent tools), `automationOps.ts` (shared lookups).
- Triggers: `schedule`, `event` (in-app: add it to `appEvents` and call `automationRuns.fireEvent` where it happens), or `webhook`. Retired stored definitions can require a named event; ones people make take any webhook. Give webhook triggers a `sample` ("Run now" sends it). Senders POST to the install's URL; there's no other way in.
- Member-made automations: `CustomAutomationConfig`, checked by `customAutomationError` on create and save, turned into an `Automation` by `customAutomation`. Saves send `expectedVersion`.
- Webhook data is untrusted: it only ever reaches the model inside `triggerPrompt`'s fenced block, never as instructions or as who to act as. `person.email` must match a workspace member.
- Runs go to the audience: each opted-in person's agent DM (`findOrCreateDm` + `insertMessage`), or the picked channel. Never message people who didn't opt in. Each run queues a turn with `enqueueTurn`, acting as a real member, the same path as a message they send. Don't give automations their own permission path.

## Memory — `core/src/memory.ts`, `backend/convex/memoryOps.ts`
- Each memory belongs to one agent; scope `workspace` or `personal`. Rules live in `canReadMemory` / `canEditMemory` / `canCreateMemory`.
- Team memories are wiki-style (`memory.team.write`: every role). Don't narrow who can fix one; keep the undo instead: every edit saves the old content to `memoryVersions` first (`keepVersion`, last 20), a team delete goes to Trash (`removeMemory`), and anything reading memories skips `archived` ones.
- Personal memories are their owner's alone. No role reads, edits or deletes someone else's, so never add a permission that does; owners get only the on/off switch. Removing a member deletes theirs, agents' in Trash included, through the member cascade (`lifecycle.ts`, index `by_owner`).
- The switch is `workspaces.memory` (unset = on), read by `memoryOn`. Off: `memory.ts` refuses every agent call with a plain message, and the turn prompt says memory is off. People can still manage their memories in the app.
- App and agents both go through `memoryOps.ts` with a `Who` (member + optional agent), so they can't drift. Agent calls take the `turnId` and act through `runningTurn`, like every other agent tool; whether personal memories work is read from the chat on each call (`personalMemoryHere`).
- Agent search (`memory.search`) uses the `search_content` search index, filtered by agent, scope and owner, so it finds matches anywhere in the history; at most 50 back, oldest first. It matches words and prefixes, not substrings: "aus" finds "Austin", "ustin" doesn't; every word must match (`memoryMatches`). An empty query lists the newest 50.
- Edits from the app send `expectedVersion`; agents edit the latest.

## Agents — `core/src/agents.ts`, `backend/convex/agents.ts`
- `AgentConfig` is the editable shape (`core/src/agent-config.ts`). Stored per workspace, versioned on every save. `validateAgentConfig` runs on save; add checks there.
- The runner reads the agent fresh each turn. Anything that changes how a reply runs belongs in `turns.turnContext` + `agent.ts`; what the model is fed belongs in `core/src/turn-input.ts`.

- Agent management shares `createAgent`, `updateAgent` and `setAgentTrashed` with the app (delete goes to Trash, like every other delete tool: `skills.remove` and `automations.remove` trash custom and retained library installs), so both accept the same models (`allowedModels`). Tool-free creation cannot expand grants; schemas omit tools/reactivation and the backend refuses edits to the acting agent's own instructions/model. `agents_manage` lists models with `models` (search, 50 at a time), not inside `get`: the catalog runs to hundreds.

## The app and `core`
- The app imports only dependency-free modules from core, by deep path: `@companybot/core/permissions`, `@companybot/core/agent-config`. One exception: `@companybot/core/files` uses `fflate` (small, browser-safe) to list a ZIP's parts. `@companybot/core/file-text` pulls in PDF.js (unpdf), so only the backend's Node action (`fileText.ts`) imports it; it's kept out of the barrel. Importing the barrel would bundle the agent runtime (`ai`, zod) into the renderer. To expose another module, add it to `exports` in `core/package.json`.

## Things people make
- Skills and automations share `canEditMade(who, managePermission, createdBy)` and one denial message. Pass no creator for library installs. Skills store the maker in `custom.createdBy`; automations use `installedBy`.
- Trim configs only in core (`normalizeCustomSkill` / `normalizeCustomAutomation`). Backend `madeCustom` adds creation metadata; `saveMade` checks the version, validates, then patches the next version and editor metadata. Agent creation uses `asToolResult` for expected errors.
- Move custom and retained library installs to Trash with `skills.remove` / `automations.remove`. The old `setInstalled` endpoints only acknowledge existing installs or explain that the library has retired (COMPAT).
- `ToolContext.skills` holds the installed `list` and `create`, like the automations store.

## Databases and records — `core/src/records.ts`, `backend/convex/recordOps.ts`
- Databases and fields are workspace data, created through the app or agent tools. Never seed demo databases or fields in workspace creation or migrations.
- New field kind: add it to `fieldKinds` (`schema.ts` builds `fieldKind` from it), then `normalizeValue` and `indexEntries`.
- Every change goes through `recordOps` (`Who` in `lib.ts`: member + optional agent), so permissions, history and the index can't drift. Never write `records` or `recordValues` directly.
- Reads the app and agents share (lists, search, "what links here") live in `recordReads.ts`; use them instead of querying the indexes again.
- Heavy data for a type (recordings, transcripts, line items) gets its own table keyed by `recordId`, not a field.
- Agent tools (`core/src/record-tools.ts`, `backend/convex/recordTools.ts`) are the same `recordOps` calls with `agentId`, acting through `runningTurn` (role read fresh each call). Keep the list small since every tool is sent every turn. Database/view tools share `recordOps` and `databaseViews` with the app; keep their version checks and role gates on the server. Expected problems return `{ error }` (`asToolResult`); resolve names before any write so a refused call writes nothing.

## Data lifecycle — `backend/convex/lifecycle.ts`, `cascade.ts`
- New table → add it to `lifecycle` and decide, per scope, what happens to its rows when their workspace, member, account or install goes, or `keep` them with a reason. CI fails until you do. Rules: [Architecture](architecture.md#data-lifecycle).
- Workspace-scoped → give it a `workspaceId`-first index, or make it `childOf` the row it hangs off. Children go one level deep: a table whose rows have children of their own needs its own index.
- Prefer indexes on fields every row already has; a new required field needs a backfill migration (`migrations.ts`) before anything reads it.
- Never hand-write a delete loop for something going away. End access in the mutation (delete the gate row, or mark it), then `startCascade`. Anything that could bring old rows back (rejoining, reinstalling) checks `cascading` first.
- A mutation an action calls after a wait (a model call, a connector, a provider's redirect) rechecks what it writes under: a live workspace, the same install or membership. Otherwise its row can land after the cascade passed that table.
- Functions keyed on the signed-in person use `authUserId` (lib.ts), never `getAuthUserId`, so an erased account's old token acts as nobody.
- Rows that hold storage files list those fields in `files` (an id, or a list of `{ storageId }`); the runner deletes the files with each row. Replacing a file in a mutation deletes the old one (`deleteFile`, images.ts).
- Write-backs of what only the actor sees (`agentActivity.output`, `approvals.result`) drop it if the actor was erased (`erased`, lib.ts).
- Pointing at `users` is always safe: accounts are scrubbed, never deleted.

## Paid calls — `backend/convex/usage.ts`
- Anything that costs money (a model call, web search, an image) records its cost with `recordUsage(ctx, { workspaceId, userId?, agentId?, kind, model?, costUsd })`, in the mutation that saves its result, so the Usage screen and later plans' allowance see it. Add a `kind` to `usageKinds` (core `usage.ts`) with its label; the table's validator is built from it.
- `userId` is the person it ran for (the acting member, an automation's person); leave it out only when nobody did. Pass the cost as AI Gateway or the provider billed it, in USD.
- Pictures (`images.generate`, `backend/convex/imageGen.ts`) record kind `image` and are capped by the workspace's monthly image budget, read from the same rows (`imageSpent`). A call holds its estimated cost (`imageHolds`) while it runs, so parallel calls can't all pass the budget. Anything else that spends per call without a turn's reply to show it should get a budget the same way: a workspace setting, checked before the call, with a hold.
- Don't read costs from messages for totals: read `usage` rows (`usageReport`). The whole workspace's numbers need `usage.view`; everyone can read their own share.

## Shared settings
- Editable shared data gets a `version` field. Saves send the version they started from; `checkVersion` refuses stale ones. In the app, use `useDraft` + `ConflictNotice`.

## Before you finish
`pnpm typecheck && pnpm test`. Add a test for every new permission rule.

## Person–agent parity — `backend/convex/parity.ts`
- Every exported public Convex mutation names its agent tool/action (`agent`) or a one-line `humanOnly` reason. `tests/parity.test.ts` finds every registered mutation (re-exports and aliases too) and fails on missing or stale entries and unknown tools/actions. Unbuilt gaps cannot be labeled human-only: the test rejects Pending/deferred placeholders. Mixed entries explain the exact authority decision a person must make.
- Group related actions into one tool per area (`manage-tools.ts`): an object root with `request: { action, … }`, a discriminated union of strict objects. `manageTools.runFor` parses the same schema again; never cast a request into an operation.
- Use `riskFor` for call-specific risk within a grouped tool (chat/channel `delete` is locked); tests must exercise the actual nested request through approval resolution. Split tools where approval differs: `members.invite` and `skills.edit` are `outside`; `members.remove`, `skills.remove` and `automations.remove` are `locked`. Rules key on the tool id, so one tool for both would let an Always for invites cover removals. Members are targeted by email, so the card shows who.
- `runFor` calls the same functions the app's mutations do (`chats.ts`, `messages.ts`, `automations.ts`, `skills.ts`, `workspace.ts`) with the live `Member` (or `Who`, for message attribution) from `runningTurn`, and rechecks the agent's grant. Never call public mutations with the runner's auth or copy their rules. Lists page indexed ranges (30 rows).
- Automation runs act with the reader's rights but follow the prompt's author. Runs that follow someone else's words ask before every `inside` action, manage tools included ([Permissions](permissions.md#automations)); tools don't check this themselves.
- Member emails are normalized on join and indexed; invite checks fail closed on a row without one instead of scanning the team.
- `platformGuide` gets the runner's resolved tools and gates each line on exact ids; `manage-tools.test.ts` checks every single-tool grant and role so the guide never names a tool the agent lacks.

Page tool writes run in a nested mutation (`writeChecked`); expected errors are caught by its caller after Convex rolls its writes back. Keep this boundary so refused block edits cannot create blank pages or save partial renames.

Tool shape references: [Anthropic's tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [consolidating tools](https://www.anthropic.com/engineering/writing-tools-for-agents), [AI SDK tool schemas](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling). At implementation: AI SDK 7.0.148, Zod 4.6.7, Gateway provider 4.0.121; Claude Sonnet/Haiku/Opus 5.5 through Vercel AI Gateway. Separate action tools give simpler schemas and individual grants but expand model choice; nested unions retain an object root while expressing action-specific fields. Risk boundaries take precedence over grouping.
