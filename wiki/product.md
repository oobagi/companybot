# Product

Companybot: AI-first team chat. Agents are teammates, not bots. Companybot is also the name of the main agent.

This page is the vision. What's built today: [Architecture](architecture.md).

## Core
- `#` text channels, threads, DMs, reactions, per-channel permissions.
- Memory: each agent has its own. Team memories (shared) + personal memories. Editable in Settings → Memory. Owners edit all; members edit only their own personal memories.
- Agents reply only when @mentioned or DM'd — never butt in. They can react to messages that @mention them, and only those.
- Replies render Markdown and **widgets**: real UI under the message (tables, stat tiles; more later), e.g. "last 10 leads" → a table.
- One continuous conversation per agent; it auto-compacts. No separate sessions. Channels keep normal threads.
- Settings: General (workspace name), Members, Memory, Your preferences (name, time zone, send key). Time zone defaults to automatic (the computer's). Shared settings are saved explicitly, with a conflict warning.
- Customize tab: **Agents** (owners edit; every save is versioned and restorable), **Plugins** (connectors to outside services via MCP — Gmail, Calendar…), **Skills** (a marketplace of installable instructions) and **Automations** (below). Memory and clock are built in, not plugins.
- Plugins, Skills and Automations are libraries: browse, install what you want, turn it off anytime. Click any item to open its detail page — what it does, who made it, version, what it needs (plugins, permissions, account), and for skills the full instructions.
- **Automations**: short, ready-made jobs that run on their own, from a trigger (event or schedule) to an agent action. Install one, pick its agent and where results go, toggle on/off. Each shows when it last ran and what it did. Examples:
  - **After-call summary** — when a call ends (needs a calls plugin, e.g. Night Owl), post a summary with next steps and action items.
  - **Morning brief** — every weekday at 8am, DM each person their meetings, open tasks, and anything that changed overnight.

## Platform
- Desktop app first (Electron). Standalone mobile app later. No web app.
- Cloud backend on Convex: agents run server-side so schedules work when nobody's online.
- Sign-in: email code only.

## UI
- Profile cards (planned): click a person's name or avatar to see their details, like GitHub. Show their time zone and local time.
- Clean home: a few starter suggestions + chat box (Ollama-style).
- Sidebar for navigation. Agent switcher at the top.

## Inference
- Default: workspace-paid plan via Vercel AI Gateway. Teammates need no AI subscription.
- Later: bring-your-own API keys; "Sign in with ChatGPT" (OpenAI partner program).
- Not possible: Claude subscriptions (Anthropic bans third-party use). OpenRouter takes API keys only — no service wraps every subscription.
- Price per workspace with a usage pool. Pause at the limit; never surprise overage.

## Rollout
Test with our own team first. Charge outsiders once the team opens it daily.

## Biggest risk
Adoption. Companybot must replace how the team already talks, not sit beside it.
