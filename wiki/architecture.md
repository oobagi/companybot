# Architecture

pnpm monorepo. Each folder in `src/` is a package.

| Package | What |
|---|---|
| `src/core` | Agent framework: agents, plugins, tools, memory, permissions. No I/O. |
| `src/server` | Hono API. Runs agents with AI SDK 7 + AI Gateway. |
| `src/desktop` | Electron app (electron-vite + React + Tailwind). Talks to the server over HTTP. |

## Concepts (`src/core`)
- **Plugin** — a bundle of tools plus a connection type (`none` / `api_key` / `oauth`). Lives in the catalog; the workspace installs it.
- **Tool** — `plugin.tool` id (e.g. `memory.save`). Optional `roles` limits who can trigger it.
- **Agent** — instructions, model, and the tool ids it's granted.
- **Tool visibility** — a tool reaches the model only if: agent grants it, plugin is installed, actor's role is allowed. See `describeToolAccess`.
- **Memory** — `workspace` or `personal` scope. Rules live in `memory.ts`; the store enforces them.

Default agents: **Companybot** (all built-in tools) and **Scribe** (`memory.search` only). Built-in plugins: Memory, Clock.

## Add things
- Plugin: `definePlugin` + `defineTool`, add to the registry catalog.
- Agent: `defineAgent`, list its tool ids.

## Run
```
pnpm install
pnpm dev:server    # needs AI_GATEWAY_API_KEY in .env.local
pnpm dev:desktop
pnpm test && pnpm typecheck
```
`pnpm --filter @companybot/desktop preview:web` runs the UI in a browser.

## Temporary shortcuts (replace before real users)
- Storage is in-memory; restarts wipe everything.
- Auth is a dev `x-user-id` header with two seeded users (owner, member).
- No conversation compaction yet.
- Electron fails if `ELECTRON_RUN_AS_NODE=1` is set in your shell (T3 Code sets it): `env -u ELECTRON_RUN_AS_NODE pnpm dev:desktop`.
