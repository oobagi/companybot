# Wiki index

One line per page: `- [Title](path.md) — what it covers`. Keep this file a table of contents only.

- [Product](product.md) — what Companybot is ("Night Owl, as software": CRM + chat + agents, owns the data), CRM, calls, lead gen, sites (agent-built websites and funnels), platform, inference, open source (AGPL) and what we charge for, rollout, biggest risk
- [Architecture](architecture.md) — packages, agents/tools/connectors/skills/memory, Convex backend (incl. the AI Gateway model catalog), data lifecycle (what's deleted when a workspace, member, account or install goes), how to run, web and desktop (one renderer; running, building and hosting the web app, what differs in a browser), before-launch swaps
- [Data](data.md) — records (clients, deals, tasks, calls), custom fields, links, history and undo; Archive; agent tools; why one generic records table; the API
- [Pages](pages.md) — standalone pages and every record's body, one concept; BlockNote + prosemirror-sync, Notion-style history and restore, agent tools, storage bounds
- [Chat](chat.md) — channels, DMs, threads, reactions; when agents reply, agents working together (handoffs, asks, loop limits), what they're fed, the chat API
- [Permissions](permissions.md) — who can access each channel, database and page; what asks, Allow once / Always / Deny, per-person rules, roles, workspace locks, automation grants, where it shows up, how others do it
- [Extending](extending.md) — how to add tools, connectors, skills, permissions, roles, memory rules; keeping the in-app help docs current; invariants to keep
- [Testing](testing.md) — what to test and what not to (behavior, not wording or markup), how to write one, where tests live, how to run them
- [Releases](releases.md) — cutting a release, CI, signing secrets, in-app updates, how the web app ships
- [Lessons](lessons.md) — what failed in Cottonwood/Night Owl and the rules that follow, plus scale/design rules from the Nov 4 audit
- [Competitors](competitors.md) — GoHighLevel, Dust, Lindy, Viktor, Polsia, Cofounder, Whop, Buzz, Sumus, Sameday, Airtable, Anytwo, Baserow, Teable, ChatGPT Sites; gaps, what to copy, threat
- [Sandbox](sandbox.md) — where agents run code, spreadsheets and a real browser: E2B vs Vercel Sandbox vs Daytona and others (license, self-host, price, isolation), recommendation, Convex fit, tool design, security rules
