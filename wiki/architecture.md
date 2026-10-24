# Architecture

pnpm monorepo. Each folder in `src/` is a package.

| Package | What |
|---|---|
| `src/core` | Agent framework: agents, built-in tools, connectors, skills, memory rules. Pure logic, no I/O. |
| `src/backend` | Convex: database, sign-in, live updates, and the agent runner (`convex/`). |
| `src/desktop` | Electron app (electron-vite + React + Tailwind). Talks to Convex directly. |

## Concepts (`src/core`)
What each piece is. The rules for changing them: [Extending](extending.md).
- **Permission** — a workspace action and the roles allowed to take it (`permissions.ts`). Backend and app both read this table.
- **Tool** — something an agent can call. Built-ins live in code; connector tools are discovered from the connector's MCP server each turn and reach the model on demand through `connectors_search` / `connectors_call`, not up front. Ids are `group.name`.
- **Agent** — name, instructions, model, tool grants. A tool reaches the model only if granted, allowed for the person's role, and (connectors) installed, allowed, and connected.
- **Connector** — a catalog entry for a remote MCP server, with a workspace or personal connection and encrypted credentials. The catalog has one entry, Night Owl, for internal testing.
- **Skill** — installable instructions: name, a short description, and Markdown instructions (Claude's SKILL.md fields). Agents see the descriptions and load the full text on demand. From the library (owners install), or made by anyone (`skills.create`), in Customize or by asking an agent (`skills_create`).
- **Automation** — a trigger (schedule, in-app event, or webhook) plus a prompt. Library ones come from `automationCatalog`; anyone can make their own. Each run posts the prompt in the chosen agent's DM with each person it runs for, as them, so the reply uses their permissions and connector accounts. Or, with a channel picked, once in that channel, as its maker (library ones: whoever picked the channel).
- **Widget** — UI an agent places in a reply (table, stats, card). Each is a tool; the app renders the stored props; the model gets a short receipt, not the data back.
- **Platform guide** — how replies render, added to every agent's prompt after its own instructions.
- **Memory** — per agent, scoped `workspace` (team) or `personal`. Agents and people follow the same rules. In chats with 2+ people, agents get team memories only.
- **Chat** — channels, DMs, threads, reactions; agents reply when mentioned (or to everything in their DM), acting as the person who asked. See [Chat](chat.md).
- **Approval** — a connector write the agent holds until the person it acts for approves it in the chat. Locked to a hash of the exact tool and input (`approvals.ts`).
- **Activity** — every tool call an agent makes, with its input and result (`activity.ts`). Widgets and `connectors_search` aren't logged; read-only tools are marked so the app can show changes only.
- **Turn input** — what the model gets each turn (`turn-input.ts`): a fixed system prompt, the agent's session in that place replayed exactly, and one new message. Built for prompt caching.

New workspaces get copies of the default agents: **Companybot** (`memory.*`, clock, `skills.load`, `skills.create`, widgets, `chat.*`, `automations.*`) and **Scribe** (`memory.search`, `skills.load`, widgets, `chat.react`, `chat.read`).

## Backend (`src/backend/convex`)
- **Sign-in:** Convex Auth (beta) with a 6-digit email code sent through Resend.
- **Workspaces:** first sign-in creates a workspace as owner, with `#general`. Invited emails join as members (and `#general`) on sign-in.
- **Messages** are ordered `parts` (text, tool activity, widget) plus `text` (plain text only, for history and summaries). History shows the agent a one-line note for each widget it showed.
- **Chat:** `chats.ts` (channels, DMs, unread) and `messages.ts` (timeline, threads, reactions); shared rules in `chatOps.ts`. Public channels are readable by the workspace; private channels and DMs by members.
- **Agent turns:** `messages.send` queues an `agentTurns` row per responding agent (`turns.ts`). One runs per agent per place (chat + thread); the rest wait; one stuck over 5 minutes is failed. A running turn streams its reply into the database via `agent.respond`; the app sees it live. Agent replies never queue turns.
- **Sessions:** `agentSessions` holds each agent's context per place. Each turn's prompt is stored (`agentTurns.prompt`) and replayed byte-identical later. Model calls send `x-session-affinity`.
- **Agents:** stored per workspace. Owners create, edit, archive, and restore them. Every save writes an `agentVersions` row; restoring saves an old version as the newest. Replies read the agent fresh each turn, so edits apply from the next reply.
- **Three kinds of data:** shared content (chat, memory) is fully live. Shared settings (agents, workspace name) are edited as a draft and saved; each has a `version`, and a save from an old version is refused as a conflict (`checkVersion`), with a "Use theirs / Keep mine" prompt in the app. Personal preferences (`preferences` table) are per person and sync across their devices.
- **Time zones:** each person has one: the zone they picked in Your preferences, else automatic (their computer's, which the app reports on launch), else UTC (`timeZoneOf`). Agents get it in the turn prompt, chat times in prompts use it, and `clock.now` answers in it. It isn't private: `workspace.team` returns it for profiles. Automation schedules use the zone of whoever made or installed them.
- **Permissions apply at once:** agent memory and connector calls re-read the person's membership and role, so removals and role changes take effect mid-reply.
- **Connectors:** (called plugins until Oct 2026; the `connector*` migrations moved the old `plugin*` tables' rows, which stay in the schema empty until that has run on prod) `connectorInstalls` (roles allowed) and `connectorConnections` (AES-GCM encrypted with `CONNECTIONS_KEY`, encrypted in an action). OAuth sign-ins in progress sit in `connectorOAuthFlows` (one use, 15 min) until `/oauth/callback` finishes them. The runner connects only to connectors the agent's grants reach, skips any that fail or take over 10s, and tells the agent.
- **Skills:** `skillInstalls` (one row per installed library skill). Skills people make live on their row (`custom`: name, description, instructions, `createdBy`; versioned; id `custom-…`), are on for the whole workspace, and can be changed or deleted by the maker or an owner (`canEditMade`); deleting one deletes the row. Agents make them through `skills.create` → `skills.createFor`, as the person they help. `installedSkills` (`lib.ts`) feeds both to each turn.
- **Automations:** `automationInstalls` (agent, on/off, time zone, `audience`, channel, last run). Library automations: one install per workspace (owners). Member-made ones (`automations.create`) live on their install (`custom`: name, prompt, trigger; versioned like other shared settings; id `custom-…`) and run through the same code (`definitionOf`); the maker or an owner can edit (`canEditMade`). `audience` decides who it runs for: `creator` (only the maker; hidden from everyone else), `subscribers` (people who opted in, `automationSubscriptions`; the maker or installer is subscribed automatically), or `channel` (one post there acting as whoever picked it, falling back to an owner who can see it). DM runs post as the person in their agent DM (tagged `automation`, shown collapsed in chat). A cron (`crons.ts`, every 5 min) runs due schedules once per local day. In-app events go through `fireEvent`: `message.posted` (from `messages.send`, top-level channel messages, optionally one channel; posting back to that channel replies in the thread) and `member.joined` (from `workspace.ensure`). "Run now" runs it for you with sample data. Agents can list, create, and opt in through `automations_list` / `automations_create` / `automations_set_mine` (`automation-tools.ts`; the guide adds a short how-to when granted). Migration `automationAudiences` sets `audience` on old installs and subscribes the installer.
- **Webhook automations** get a secret URL: `POST <site>/automations/<token>` (`http.ts` → `automations.receive`). Body `{ event?, id, person?: { email }, data? }` (`event` must match when the trigger names one, like `call.ended`; ones people make take any), max 32 KB; `id` dedupes retries (`automationEvents` holds webhook delivery ids, kept 7 days by `forgetOldWebhooks`, deleted on uninstall); `data` is appended to the prompt as fenced JSON. Runs in the channel if one is picked; otherwise in the DM of the member whose email is `person` (they must be subscribed, or be the maker of a just-me one), or for every subscriber if no `person`. Replies: 200 (ran, skipped, or duplicate; the reason is in `message` and `lastResult`), 400 bad body, 404 unknown token, 413 too big. Sender contract: oobagi/ai-agency#1052.
- **Activity log:** the runner writes an `agentActivity` row as each tool call finishes (input and result as JSON, cut to 4k chars; calls cut off by a failed reply are logged as errors). An entry is as private as its chat; results show only to the person the agent acted for, since they can hold things only that person may see. Owners get no extra access. The app shows it in Settings → Activity and when you click a tool line in a reply. Memories an agent changed carry `updatedByAgent` until a person edits them.
- **Approvals:** `approvals` rows (exact input as canonical JSON, `hash`, status, 24h expiry). The reply shows a card (`approval` part; `messages.list` sends it only in `fullParts`, and as a line of text in `parts` for apps from before approvals); `approvals.decide` takes the hash the person saw and queues a turn in the same place, which runs the call if approved and tells the agent. Results show only to the person, like the activity log.
- **Usage:** each reply stores `stats` (model, tokens, time, AI Gateway's `cost`), plus its place's running total (`costUsd` on the chat or thread parent, summaries included). The app shows them under each reply. Prompt caching is on for every model call (AI Gateway `caching: "auto"`).
- **Compaction:** once a reply leaves a session's context over 40k tokens, older turns fold into the session's summary (a ~15k-token tail kept verbatim). The app still shows everything; agent DMs show a divider where the summary starts.

## Secrets (Convex env, `npx convex env set`)
`AI_GATEWAY_API_KEY`, `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `CONNECTIONS_KEY`. Dev and prod each have their own; never copy `CONNECTIONS_KEY` between them.

## Deployments
- **Dev** `exciting-guanaco-266` — `npx convex dev`, used by `pnpm dev:desktop`.
- **Prod** `different-oyster-816` — `npx convex deploy`, used by released apps (URL in `.env.production`). Releases deploy it: [Releases](releases.md).

## Run
```
pnpm dev                # this checkout's own local backend + the desktop app
pnpm test && pnpm typecheck
```
`pnpm dev` (`scripts/dev.mjs`, the `/dev` skill) gives each checkout its own local Convex backend and data, so worktrees never fight over the cloud dev deployment. Sign in with any email; local backends send no code (`auth.ts`). `--reset` wipes local data. Local backends have no public URL, so connector OAuth only works on cloud dev (`npx convex dev` against `exciting-guanaco-266`, `pnpm dev:desktop`).

The app's screens are hash paths (`router.ts`): `#/chat`, `#/customize/<tab>[/<item>]`, `#/settings/<tab>`. Opening an item pushes its own screen; back returns to the list. `pnpm --filter @companybot/desktop preview:web` serves the UI in a browser on port 5173.

## Before launch
- Sign-in emails send from `signin@callnightowl.com` and AI bills to the Night Owl Vercel team ($25/mo cap). Swap both to Companybot accounts.
- Convex Auth is beta — re-check before real customers.
- The connector catalog lists **Night Owl** (our own MCP server) for internal testing. Remove it.
