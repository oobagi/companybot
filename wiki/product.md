# Product

Companybot is the platform you run your business on: a CRM, team chat, and AI agents in one, each making the others stronger. Agents are teammates, not bots. Companybot is also the name of the main agent.

This page is the vision. What's built today: [Architecture](architecture.md).

## The idea
- **Night Owl, as software.** An agency's worth of work (finding leads, answering calls, following up, running the pipeline), done by agents, for businesses that could never afford an agency. The pitch is "fire your agency," not "switch from Slack."
- **One AI sees the whole loop.** An ad brings a lead, the voice agent answers, the call is recorded and summarized on the client's record, a job gets booked, and the team talks about it in chat. Point tools each see one slice; all-in-one suites see it all but can't act on it (see [Competitors](competitors.md)).
- **The edge is the harness.** CRM, calls, email and ads can be built or bought by anyone. Agents that reliably do the work across all of them are the hard part, and the part we own.
- **Companybot owns the data.** Business records live in Companybot, not in HubSpot or a spreadsheet reached through a connector. Connectors bring data in; they aren't where it lives. Because of that, "who hasn't paid?" or "move Acme to won" works with zero setup.
- **Companybot absorbs Night Owl.** Everything Night Owl does for clients moves in, rebuilt around the records, agents and automations.

## CRM (data layer and screens built)
- Records: clients, deals/pipeline, jobs or projects, tasks, invoices. Each type gets its own tab (e.g. Clients) and lives next to the chat about it.
- **Built:** the data layer ([Data](data.md)): Clients, Deals, Tasks and Calls ship as built-in types; owners can add more. Custom fields, links between records, filtering and sorting on any field, history with undo, and chat messages that reference records.
- **Screens (built):** one design for every type, built-in or added (added types get their own tab). Campaigns is still "Coming soon".
  - **List:** a table with columns you pick (name plus the next four fields by default; remembered per computer). Click a column to sort. Filter bar: any number of conditions (is, is any of, at least/at most/more/less than, empty/not empty, checked). Search by name and text (top 20; filters don't apply). Archived behind "Show archived". Scrolls in more as you go. "+ New" asks for a name, then opens the record.
  - **Record page:** every field editable in place, with an input per kind (amounts with their currency, dates, choices, people, record pickers for links). Removed options show as "(removed)"; links to archived records as "(archived)". "+ Add field" (members); renaming, options and archiving for the field's maker or an owner. Linked records grouped by type and field. Discussion: chat messages that mention it, each opening the message. History: who ("Companybot, for Jaden"), old → new, Undo on each; refusals show as they come.
  - Permissions hide what you can't do (`records.edit`, `fields.create`, a field's `canEdit`).
- **Custom fields from the start.** A field is one piece of info on a record (name, phone, "Roof type", "Monthly retainer"). Each business adds its own, so the facts that matter aren't buried in notes. Designing for this up front is cheap; adding it later means migrating every record.
- **Agents are wired in natively.** They can read and change any field and add new ones ("start tracking roof type on clients"), limited to what the person who asked may do. Every change is in the activity log, and records keep history so changes can be undone.
- Record changes are automation triggers ("deal moved to Won" → welcome email + onboarding tasks).
- Next: agent tools for records, record triggers for automations, a pipeline board, saved views.

## Calls (not built yet)
- Voice agents (like Night Owl's receptionist) run from Companybot.
- Every call lands on the client's record: recording, transcript, AI summary, next steps. Summaries can post to chat, and call events can start automations.

## Lead gen and campaigns (not built yet)
- Generate leads and work them in the same pipeline. Lead lists, campaigns, follow-up steps and replies live natively in Companybot.
- **We don't build the sending machinery.** Mailboxes, warm-up, sending, and bounce/spam tracking sit behind a swappable sending service, out of sight. Companybot sets mailboxes up for the customer, the way Night Owl does today.
- Flow: the agent writes the emails → the person approves (see [Permissions](permissions.md)) → the service sends from warmed mailboxes → replies come back by webhook, land on the lead's record, move it in the pipeline, and the agent drafts an answer.
- Email to people who already know the business (leads, past clients, check-ins) uses the same pipeline.

## Later
- **Ads manager:** run marketing campaigns from Companybot, with results tied back to the leads they brought in.

## Core
- `#` text channels, threads, DMs, reactions, per-channel permissions.
- Memory: each agent has its own. Team memories (shared) + personal memories. Editable in Settings → Memory. Owners edit all; members edit only their own personal memories.
- Agents reply only when @mentioned or DM'd — never butt in. They can react to messages that @mention them, and only those.
- Replies render Markdown and **widgets**: real UI under the message (tables, stat tiles; more later), e.g. "last 10 leads" → a table.
- One continuous conversation per agent; it auto-compacts. No separate sessions. Channels keep normal threads.
- Settings: General (workspace name), Members, Memory, Activity, Your preferences (name, time zone, send key). Time zone defaults to automatic (the computer's). Shared settings are saved explicitly, with a conflict warning.
- Customize tab: **Agents** (owners edit; every save is versioned and restorable), **Connectors** (links to outside services over MCP — Gmail, Calendar…), **Skills** (a marketplace of installable instructions; anyone can also write their own, or ask Companybot to save one ("here's how we write proposals"); they're shared with the team, shown under "Made by your team", and only the maker or an owner can change them) and **Automations** (below). Memory and clock are built in, not connectors.
- Connectors, Skills and Automations are libraries: browse, install what you want, turn it off anytime. Click any item to open its detail page — what it does, who made it, version, what it needs (connectors, permissions, account), and for skills the full instructions.
- **Automations**: short jobs that run on their own: a trigger (a schedule, something in the app like a new message in a channel or a new teammate, or a webhook from another app), a prompt, an agent, and who it runs for: just the person who made it, people who choose "Turn on for me", or one channel. Nobody gets messages they didn't opt into. Anyone can make their own, in Customize or by asking Companybot in chat; owners install from the library. The maker or an owner can edit, toggle, or delete it. Each shows when it last ran and what it did. Library examples:
  - **After-call summary** — when a phone system's webhook says a call ended, post a summary with next steps and action items.
  - **Morning brief** — every weekday at 8am, DM each person their meetings, open tasks, and anything that changed overnight.
- **Naming** follows Claude and ChatGPT: a **connector** links to an outside service (an MCP server); a **skill** is instructions; a **plugin** (later) bundles connectors, skills, and automations into one install. Triggers are a **schedule**, an in-app **event** (a message posted in a channel, someone joined), or a **webhook** from another app.

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
