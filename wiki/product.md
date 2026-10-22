# Product

Companybot: AI-first team chat. Agents are teammates, not bots. Companybot is also the name of the main agent.

## Core
- Channels, threads, DMs, reactions, per-channel permissions.
- Memory: team memories (shared) + personal memories. Editable in the app. Owners edit all; members edit only their own personal memories.
- Agents reply when @mentioned or DM'd. Otherwise a 👀 reaction and an offer to help — never butt in.
- One continuous conversation per agent; it auto-compacts. No separate sessions. Channels keep normal threads.
- Customize tab: **Plugins** (connectors to outside services via MCP — Gmail, Calendar…) and **Skills** (a marketplace of installable instructions). Memory and clock are built in, not plugins.
- Built-in automations and schedules.

## Platform
- Desktop app first (Electron). Standalone mobile app later. No web app.
- Cloud backend on Convex: agents run server-side so schedules work when nobody's online.
- Sign-in: email code only.

## UI
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
