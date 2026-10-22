# Architecture

pnpm monorepo. Each folder in `src/` is a package.

| Package | What |
|---|---|
| `src/core` | Agent framework: agents, built-in tools, plugins, skills, memory rules. Pure logic, no I/O. |
| `src/backend` | Convex: database, sign-in, live updates, and the agent runner (`convex/`). |
| `src/desktop` | Electron app (electron-vite + React + Tailwind). Talks to Convex directly. |

## Concepts (`src/core`)
What each piece is. The rules for changing them: [Extending](extending.md).
- **Permission** — a workspace action and the roles allowed to take it (`permissions.ts`). Backend and app both read this table.
- **Tool** — something an agent can call. Built-ins live in code; plugin tools are discovered from the plugin's MCP server each turn. Ids are `group.name`.
- **Agent** — name, instructions, model, tool grants. A tool reaches the model only if granted, allowed for the person's role, and (plugins) installed, allowed, and connected.
- **Plugin** — a catalog entry for a remote MCP server, with a workspace or personal connection and encrypted credentials. The catalog has one entry, Night Owl, for internal testing.
- **Skill** — installable instructions. Agents see one-line descriptions and load the full text on demand.
- **Widget** — UI an agent places in a reply (table, stats, card). Each is a tool; the app renders the stored props; the model gets a short receipt, not the data back.
- **Platform guide** — how replies render, added to every agent's prompt after its own instructions.
- **Memory** — per agent, scoped `workspace` (team) or `personal`. Agents and people follow the same rules.

New workspaces get copies of the default agents: **Companybot** (`memory.*`, clock, skills, widgets) and **Scribe** (`memory.search`, `skills.load`, widgets).

## Backend (`src/backend/convex`)
- **Sign-in:** Convex Auth (beta) with a 6-digit email code sent through Resend.
- **Workspaces:** first sign-in creates a workspace as owner. Invited emails join as members on sign-in.
- **Messages** are ordered `parts` (text, tool activity, widget) plus `text` (plain text only, for history and summaries). History shows the agent a one-line note for each widget it showed.
- **Chat:** one conversation per person per agent. `chat.send` stores the message and schedules `agent.respond`, which streams the reply into the database; the app sees it live. One reply at a time per conversation; a reply stuck over 5 minutes stops blocking.
- **Agents:** stored per workspace. Owners create, edit, archive, and restore them. Every save writes an `agentVersions` row; restoring saves an old version as the newest. Replies read the agent fresh each turn, so edits apply from the next reply.
- **Three kinds of data:** shared content (chat, memory) is fully live. Shared settings (agents, workspace name) are edited as a draft and saved; each has a `version`, and a save from an old version is refused as a conflict (`checkVersion`), with a "Use theirs / Keep mine" prompt in the app. Personal preferences (`preferences` table) are per person and sync across their devices.
- **Permissions apply at once:** agent memory and plugin calls re-read the person's membership and role, so removals and role changes take effect mid-reply.
- **Plugins:** `pluginInstalls` (roles allowed) and `pluginConnections` (AES-GCM encrypted with `CONNECTIONS_KEY`, encrypted in an action). OAuth sign-ins in progress sit in `pluginOAuthFlows` (one use, 15 min) until `/oauth/callback` finishes them. The runner connects only to plugins the agent's grants reach, skips any that fail or take over 10s, and tells the agent.
- **Compaction:** past 40 messages, older ones fold into a running summary (newest 20 kept verbatim). The app still shows everything.

## Secrets (Convex env, `npx convex env set`)
`AI_GATEWAY_API_KEY`, `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `CONNECTIONS_KEY`. Dev and prod each have their own; never copy `CONNECTIONS_KEY` between them.

## Deployments
- **Dev** `exciting-guanaco-266` — `npx convex dev`, used by `pnpm dev:desktop`.
- **Prod** `different-oyster-816` — `npx convex deploy`, used by released apps (URL in `.env.production`). Releases deploy it: [Releases](releases.md).

## Run
```
pnpm install
npx convex dev          # syncs backend, writes CONVEX_URL to .env.local
pnpm dev:desktop
pnpm test && pnpm typecheck
```
`pnpm --filter @companybot/desktop preview:web` runs the UI in a browser on port 5173.

If Electron crashes on launch from T3 Code's terminal: `env -u ELECTRON_RUN_AS_NODE pnpm dev:desktop`.

## Before launch
- Sign-in emails send from `signin@callnightowl.com` and AI bills to the Night Owl Vercel team ($25/mo cap). Swap both to Companybot accounts.
- Convex Auth is beta — re-check before real customers.
- The plugin catalog lists **Night Owl** (our own MCP server) for internal testing. Remove it.
