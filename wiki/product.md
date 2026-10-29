# Product

Companybot is the platform you run your business on: a CRM, team chat, and AI agents in one, each making the others stronger. Agents are teammates, not bots. Companybot is also the name of the main agent.

This page is the vision. What's built today: [Architecture](architecture.md).

## The idea
- **Night Owl, as software.** An agency's worth of work (finding leads, answering calls, following up, running the pipeline), done by agents, for businesses that could never afford an agency. The pitch is "fire your agency," not "switch from Slack."
- **One AI sees the whole loop.** An ad brings a lead, the voice agent answers, the call is recorded and summarized on the client's record, a job gets booked, and the team talks about it in chat. Point tools each see one slice; all-in-one suites see it all but can't act on it (see [Competitors](competitors.md)).
- **The edge is the harness.** CRM, calls, email and ads can be built or bought by anyone. Agents that reliably do the work across all of them are the hard part, and the part we own.
- **Companybot owns the data.** Business records live in Companybot, not in HubSpot or a spreadsheet reached through a connector. Connectors bring data in; they aren't where it lives. Once the team creates its databases, agents can answer questions and update their records.
- **Companybot absorbs Night Owl.** Everything Night Owl does for clients moves in, rebuilt around the records, agents and automations.

## CRM (data layer and screens built)
- Records: clients, deals/pipeline, jobs or projects, tasks, invoices. Each database gets its own sidebar entry (e.g. Clients) and lives next to the chat about it.
- **Built:** the data layer ([Data](data.md)): Owners create the databases their team needs; new workspaces start with none. Custom fields, links between records, filtering and sorting on any field, history with undo, and chat messages that reference records.
- **Screens (built):** one design for every database. Campaigns isn't built yet (see Lead gen and campaigns).
  - **List:** a table with columns you pick (name plus the next four fields by default; remembered per computer in All records, or saved as a shared named view). Click a column to sort. Filter bar: any number of conditions (is, is any of, at least/at most/more/less than, empty/not empty, checked). Search by name and text (top 20; filters don't apply). Deleted records go to Trash. Scrolls in more as you go. "+ New" asks for a name, then opens the record.
  - **Record page:** every field editable in place, with an input per kind (amounts with their currency, dates, choices, people, record pickers for links). Removed options show as "(removed)"; links to deleted records as "(deleted)", not clickable. "+ Add field" (members); renaming, options and deleting for the field's maker or an owner. Linked records grouped by type and field. Discussion: chat messages that mention it, each opening the message. History: who ("Companybot, for Jaden"), old → new, Undo on each; refusals show as they come.
  - Permissions hide what you can't do (`records.edit`, `fields.create`, a field's `canEdit`).
- **Custom fields from the start.** A field is one piece of info on a record (name, phone, "Roof type", "Monthly retainer"). Each business adds its own, so the facts that matter aren't buried in notes. Designing for this up front is cheap; adding it later means migrating every record.
- **Agents are wired in natively.** They can read and change any field and add new ones ("start tracking roof type on clients"), limited to what the person who asked may do. Every change is in the activity log, and records keep history so changes can be undone.
- Record changes are automation triggers ("deal moved to Won" → welcome email + onboarding tasks).
- **Built:** agent tools for records (find, read, create, change, delete and restore, undo, add fields), acting as the person who asked; Companybot has them. See [Data → Agent tools](data.md).
- Owners create databases from the sidebar and rename or delete them from the list. Everything deleted sits in Trash for 30 days ([Data → Trash](data.md#trash)). Saved views share sorting, filtering and columns with the workspace; people and agents can create, update and delete them.
- Next: record triggers for automations, a pipeline board.

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
- Memory: each agent has its own. Team memories (shared) + personal memories. Editable in Settings → Memory. Everyone reads, adds, fixes and deletes team memories, wiki-style: each shows who saved and last edited it, keeps old versions you can restore, and goes to Trash when deleted. Personal memories belong to the person: only they can see, edit or delete them, owners included, in the app and through agents. Owners can turn memory off for the workspace (Settings → General): agents then neither read nor save memories, and nothing is deleted. Removing a member deletes their personal memories.
  - How others do it: ChatGPT and Claude business plans treat personal memory as the person's. They view, edit and delete it; admins only turn memory on or off and can't browse anyone's. Slack keeps DMs from owners in the app.
- Agents reply only when @mentioned or DM'd — never butt in. They can react to messages that @mention them, and only those.
- Replies render Markdown and **widgets**: real UI under the message (tables, stat tiles; more later), e.g. "last 10 leads" → a table.
- One continuous conversation per agent; it auto-compacts. No separate sessions. Channels keep normal threads.
- Settings come in two kinds, never listed together; the sidebar swaps to the open kind's tabs. **Account settings** (your avatar, bottom of the rail): Your preferences (name, time zone, send key, notifications, app updates). **Workspace settings** (the workspace name's menu): Workspace → General (workspace name, currency, memory on/off), Members, Permissions (your rules, owners' locks), Memory, Activity, Usage (what AI cost this month: owners see the whole workspace by agent, person, kind and model; everyone else only their own share), Trash; Customize → Agents, Connectors, Skills, Automations.
- Notifications: a desktop notification for each DM and @mention while the app isn't in front, and the count on the dock icon. Per person: DMs and mentions, mentions only, or off. Time zone defaults to automatic (the computer's). Shared settings are saved explicitly, with a conflict warning.
- Customize (in Settings): **Agents** (owners edit; every save is versioned and restorable), **Connectors** (links to outside services over MCP — Gmail, Calendar…), **Skills** (instructions anyone can write, or ask Companybot to save one ("here's how we write proposals"); they're shared with the team, only the maker or an owner can change them) and **Automations** (below). Memory and clock are built in, not connectors.
- **Onboarding (built):** signed in with no workspace (first time, or after deleting your last), three steps: your name, the company and its currency, and emails to invite; one call makes it all ([Architecture](architecture.md), Workspaces). Then Companybot speaks first with a fixed message (no model call, so it's free): in #general when someone makes a workspace (a short intro, then one ask: @mention it about the company), and in their DM with it when someone joins (role and current work). Answers are ordinary turns, saved to memory in plain sight. New people get a tutorial tray on the composer ([Chat](chat.md#onboarding)).
- New workspaces start with **#general** and **Companybot** only. Connectors are currently unavailable; skills and automations start empty with a path to create your own. Existing databases, agents, pages and installed skills/automations remain available after upgrading.
- **Automations**: short jobs that run on their own: a schedule, an in-app event, or a webhook; a prompt; an agent; and who it runs for. Anyone can create one in Settings → Automations or by asking Companybot. The maker or an owner can edit, pause or delete it. Each shows when it last ran and what it did.
- **Naming** follows Claude and ChatGPT: a **connector** links to an outside service (an MCP server); a **skill** is instructions; a **plugin** (later) bundles connectors, skills, and automations into one install. Triggers are a **schedule**, an in-app **event** (a message posted in a channel, someone joined), or a **webhook** from another app.

## Platform
- Desktop app first (Electron). Standalone mobile app later. No web app.
- Cloud backend on Convex: agents run server-side so schedules work when nobody's online.
- Sign-in: email code only.
- Teammates: owners invite by email (the email links the download); one person can be in several workspaces and switches from the rail of workspace logos at the far left (like Discord).

## UI
- Profile cards (built): click a name or avatar in chat (or a channel's member list) to see name, email, role, time zone and local time, and **Message**. Agents show their description.
- Typing indicators (built): a line under the composer, for people and agents ([Chat](chat.md)). Only written while someone types, so no heartbeat.
- Not built: online status (it needs a heartbeat write per person every few seconds; not worth it yet).
- Home opens #general, ready for the team to talk.
- Sidebar for navigation. Agent switcher at the top.

## Inference
- Default: workspace-paid plan via Vercel AI Gateway. Teammates need no AI subscription.
- Later: bring-your-own API keys; "Sign in with ChatGPT" (OpenAI partner program).
- Not possible: Claude subscriptions (Anthropic bans third-party use). OpenRouter takes API keys only — no service wraps every subscription.
- Price per workspace with a usage pool. Pause at the limit; never surprise overage. The monthly cost per workspace is already tracked (Settings → Usage), as the foundation for plans.

## Open source
- The code is AGPL-3.0 (`LICENSE`): anyone can self-host; anyone who runs a changed version as a service must publish their changes.
- Three editions, like Dify:
  - **Community** — free, AGPL, self-hosted. Self-hosters bring their own keys as server config.
  - **Cloud** — we host it. Paid plans with a monthly AI allowance (models, search, images) we resell at a markup; pauses at the limit, top-ups available.
  - **Enterprise** — a paid license to self-host with enterprise features (single sign-on, audit logs, compliance, support). Those features live in an `ee/` folder under a commercial license. Not built yet.
- Outside contributors sign a contributor agreement (CLA) before their code is merged, so we can sell it in Enterprise.

## Rollout
Test with our own team first. Charge outsiders once the team opens it daily.

## Biggest risk
Adoption. Companybot must replace how the team already talks, not sit beside it.
