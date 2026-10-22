# Architecture

pnpm monorepo. Each folder in `src/` is a package.

| Package | What |
|---|---|
| `src/core` | Agent framework: agents, built-in tools, plugins, skills, memory rules. Pure logic, no I/O. |
| `src/backend` | Convex: database, sign-in, live updates, and the agent runner (`convex/`). |
| `src/desktop` | Electron app (electron-vite + React + Tailwind). Talks to Convex directly. |

## Concepts (`src/core`)
- **Built-in tools** — always on, no outside service: memory, clock, `skills.load`. Optional `roles` limits who can trigger one.
- **Agent** — name, instructions, model (from `models`), and the built-in tool ids it's granted. A tool reaches the model only if the agent grants it and the person's role allows it (`describeToolAccess`). `validateAgentConfig` checks edits.
- **Plugin** — a connector to an outside service through an MCP server (Gmail, Calendar…). Workspace installs it. Catalog is empty; runtime MCP loading gets built with the first connector.
- **Skill** — installable instructions. Agents see installed skills' one-line descriptions and call `skills_load` for the full text when needed.
- **Memory** — each agent has its own. Scope is `workspace` (team) or `personal`. Owners edit all; members edit only their own personal memories.

New workspaces get copies of the default agents: **Companybot** (all built-in tools) and **Scribe** (`memory.search`, `skills.load`).

## Backend (`src/backend/convex`)
- **Sign-in:** Convex Auth (beta) with a 6-digit email code sent through Resend.
- **Workspaces:** first sign-in creates a workspace as owner. Invited emails join as members on sign-in.
- **Chat:** one conversation per person per agent. `chat.send` stores the message and schedules `agent.respond`, which streams the reply into the database; the app sees it live. One reply at a time per conversation.
- **Agents:** stored per workspace. Owners create, edit, archive, and restore them. Every save writes an `agentVersions` row; restoring saves an old version as the newest. Replies read the agent fresh each turn, so edits apply from the next reply.
- **Three kinds of data:** shared content (chat, memory) is fully live. Shared settings (agents, workspace name) are edited as a draft and saved; each has a `version`, and a save from an old version is refused as a conflict (`checkVersion`), with a "Use theirs / Keep mine" prompt in the app. Personal preferences (`preferences` table) are per person and sync across their devices.
- **Permissions apply at once:** agent memory calls re-read the person's membership and role on every call, so removals and role changes take effect mid-reply.
- **Compaction:** past 40 messages, older ones fold into a running summary (newest 20 kept verbatim). The app still shows everything.

## Secrets (Convex env, `npx convex env set`)
`AI_GATEWAY_API_KEY`, `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`.

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
