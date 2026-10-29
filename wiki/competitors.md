# Competitors (Oct 2026)

| Product | What it is | Weakness |
|---|---|---|
| GoHighLevel | All-in-one for small businesses and agencies: CRM, pipelines, email/SMS, AI voice agents, ads | A toolbox an agency has to set up and run; the AI doesn't run the business. **Closest to what we're building.** |
| Dust | Agent builder, separate chat sessions | Not a team chat |
| Lindy | Slack bot ("Teammate"), 3rd pivot | Needs paid Slack; unreliable |
| Viktor | Slack bot that builds and runs code | Needs Slack; claims done when not |
| Polsia | Solo-founder dashboard, nightly agents | No teams; spam, unapproved sends |
| Cofounder | Dashboard, agents by department | Team plan is waitlist-only |
| Whop | Commerce platform + agent CLI/MCP | Not a workspace; possible connector |
| Buzz (Block) | Free, open-source team chat for people + agents (Nostr), with git hosting | Self-host + BYO agents and models; built for coding, not business tools; approvals unfinished, no mobile yet |
| [Sumus](https://sumus.im) | Hosted group chat for people + AI teammates, "for work, life, and everything in between." Agents hand work to other agents; each has its own computer; Codex and Claude can join with their own name and role. Free up to 3 members, Plus $24/mo, credits | No business data (no CRM or records), no approvals; general-purpose, pitched at group projects (research, charts, slides). Browser only. Tiny so far (X account from Sep 2026). **Looks most like us at a glance.** |
| [Sameday](https://sameday.ai) | "The AI front office for home services" (YC W23, Lehi UT, ~7 people). AI agents answer calls, text, book jobs and follow up; sensitive actions wait for owner approval. Phone system (port your number, ring groups, "Hand to AI" mid-call), one thread per customer for calls + texts, reactivation campaigns, call scoring per rep, mobile apps. Syncs to ServiceTitan, Housecall Pro, FieldRoutes etc. and lead sources (Thumbtack, Angi, Google LSA). From $449/mo (500 min) / $789/mo (1,000 min). Claims ~2,000 businesses, 4M+ calls | Voice-first front office, not a workspace: no team chat, no general agents, and the CRM of record stays in ServiceTitan etc. Home services only. Closed source, pricey, minutes-metered. **Closest to what we sell (and to Night Owl's receptionist) today.** |
| Airtable | Databases for teams: tables, formulas, interfaces, automations, AI (Omni). Bought by Bending Spoons (Evernote, Vimeo) Aug 2026 for $1.29B, ~2.7x its ~$480M ARR; a "large part" of the team laid off Oct 12. **Our Databases follow its model.** | Users expect the Evernote playbook (price hikes, smaller free tier); record comments are weak for project work; power users dislike the AI push. Open-source clones (NocoDB, Baserow, Teable) and Softr, Zite and Gridfox are already courting its users. |
| [Anytwo](https://community.anytype.io/t/anytwo-and-the-future-of-anytype/31235) (Anytype) | Rebuild of Anytype (Berlin, ~$13M Series A 2023), a Notion alternative that keeps data on your devices, encrypted end to end. Public v1 by end of 2026. Runs on [Any](https://docs.any.org) (MIT, developer preview): typed records, block docs, live queries, an agent with tools, memory and connectors, chat, and Python scripts on schedules or events. **Closest to our design.** | Personal notes first (a separate Anytype for Business); no business data (CRM, calls, pipelines); end-to-end encryption makes always-on server agents hard. Not backward compatible: Anytype users must migrate. |
| [Baserow](https://baserow.io) | Open-source Airtable (Dutch, since 2020, ~$6M raised, claims 200k active users; 6.2k GitHub stars, Python). Views (grid, kanban, calendar, timeline, form), app builder, automations, dashboards, AI assistant (Kuma) that builds databases, formulas, automations and apps; MCP server. SOC 2, HIPAA; $10–18/user/mo | A toolkit someone has to set up; no chat, no CRM out of the box. Sells to enterprises and the EU on compliance. Open core: MIT, with paid features in `premium/` and `enterprise/` |
| [Teable](https://teable.ai) | "AI Spreadsheet for Business" (Teable Inc., angel round Sep 2025; **21.9k GitHub stars**, TypeScript). Every table is real Postgres, millions of rows. An agent builds apps in a sandbox and deploys each to its own URL; scheduled AI routines; MCP server + CLI for Claude Code and Cursor. $13–20/seat/mo with 2–3k AI credits per seat | No chat, no CRM, no follow-up: it builds tools, it doesn't run the business. **Closest open-source rival for Databases: same license (AGPL), stack and "agents inside your data" pitch.** |
| ChatGPT Sites (OpenAI) | Describe a site or small web app in chat and ChatGPT builds and hosts it (public beta Jul 2026, paid plans). A small database (SQLite), file storage, custom domains. Wix also has a site builder inside ChatGPT | One-off builds: no CRM behind the forms, nobody answering leads, no upkeep. No payments; not in the EEA or UK at launch. **Makes "AI builds your website" table stakes** ([Product → Sites](product.md#sites-not-built-yet)). |

## Gaps
- The bundle (CRM + calls + email + ads) already exists in GoHighLevel. What doesn't exist is one AI that runs it end to end.
- AI-first team chats exist: Buzz (self-hosted, for dev teams) and Sumus (hosted, AI included, general-purpose). None is built to run a business: no records, no approvals.
- Buzz and Sumus let you bring your own agents; with Buzz you run them yourself.
- Sameday already sells the AI front office (calls, texts, booking, follow-up, approvals) to trades, but bolted onto someone else's CRM. Nobody owns the data and runs the back office too.
- Everyone gets complaints about unpredictable credit bills.
- Airtable's users want a home that can't be bought and squeezed ("immune from the fate of Airtable," r/Airtable). Open source + self-host is exactly that. What keeps them stuck is switching cost: an agent-run Airtable importer (bases → databases, links kept) answers it. A thread on every record would beat their weak comments; records already list the chat messages that mention them.
- Anytwo makes the same bet we did: agents query typed records instead of rewriting whole Markdown files.

## Worth copying
- Lindy: editable memory files (personal + team); skills owned by the workspace.
- Viktor: per-workspace pricing.
- Polsia: morning plan / evening summary — but post it to a channel.
- All: named approver for actions with outside impact.
- Buzz: a full record of what each agent did. We have it now (Settings → Activity); Buzz's is also cryptographically signed, which we don't need yet.
- Sameday: "Hand to AI" during a live call; call → text fallback in campaigns; per-rep call scoring against a playbook; prebuilt playbooks (after-hours, speed-to-lead, reactivation) as the onboarding.
- Sumus: outside agents (Codex, Claude) join a chat as themselves; a free tier for small teams; sponsoring mcp.so to reach agent-savvy early adopters.
- Teable and Baserow: an MCP server of our own, so outside agents (Claude Code, Cursor) can work in a workspace. Today we only connect out to other tools' MCP servers (connectors).
- Teable: AGPL plus a Section 7 clause that stops forks from rebranding it, with SDK packages under MIT.
- Baserow: proof that the open-core split we planned for Enterprise works (paid features in their own folder under a commercial license; ours is `ee/`, see [Product → Open source](product.md#open-source)).
- Pricing benchmark: $10–20 per seat per month; Teable includes AI credits per seat.

## Threat
Buzz is free and backed by Block, and Sumus is $24/mo with a free tier, so "team chat with agents" alone won't sell. Neither will "CRM + calls + email in one" (GoHighLevel has it), or "AI answers your phone and books jobs" (Sameday has ~2,000 trades businesses at $449+/mo). Sell the agency's work done for you: zero setup, AI included, agents that run the whole loop.

Sameday already sells the call → book step to trades, and trades buy it as an add-on to the job software they already use (ServiceTitan, Housecall Pro), not as a replacement. What's still open is the whole loop from [Product](product.md): lead → answer and book → job → review and invoice chase → reactivation, run by one AI on records it owns. So the next features should each close a step of that loop (email, phone), and connectors to job software (Jobber, Housecall Pro) should copy their data into Companybot's records rather than reading it live, so we're an easy add-on on day one and still own the data later.

Don't chase Airtable parity. Its loudest users are consultants building custom apps who want formulas, rollups, forms and scale, and less AI. Take the small teams using it as a homemade CRM or job tracker next to Slack and Notion. Someone who just wants an Airtable replacement will pick Teable or Baserow, and that's fine. Anytwo is the one to watch on design, but it's built for personal notes, not running a business.
