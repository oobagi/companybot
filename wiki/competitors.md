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

## Gaps
- The bundle (CRM + calls + email + ads) already exists in GoHighLevel. What doesn't exist is one AI that runs it end to end.
- AI-first team chats exist: Buzz (self-hosted, for dev teams) and Sumus (hosted, AI included, general-purpose). None is built to run a business: no records, no approvals.
- Buzz and Sumus let you bring your own agents; with Buzz you run them yourself.
- Sameday already sells the AI front office (calls, texts, booking, follow-up, approvals) to trades, but bolted onto someone else's CRM. Nobody owns the data and runs the back office too.
- Everyone gets complaints about unpredictable credit bills.

## Worth copying
- Lindy: editable memory files (personal + team); skills owned by the workspace.
- Viktor: per-workspace pricing.
- Polsia: morning plan / evening summary — but post it to a channel.
- All: named approver for actions with outside impact.
- Buzz: a full record of what each agent did. We have it now (Settings → Activity); Buzz's is also cryptographically signed, which we don't need yet.
- Sameday: "Hand to AI" during a live call; call → text fallback in campaigns; per-rep call scoring against a playbook; prebuilt playbooks (after-hours, speed-to-lead, reactivation) as the onboarding.
- Sumus: outside agents (Codex, Claude) join a chat as themselves; a free tier for small teams; sponsoring mcp.so to reach agent-savvy early adopters.

## Threat
Buzz is free and backed by Block, and Sumus is $24/mo with a free tier, so "team chat with agents" alone won't sell. Neither will "CRM + calls + email in one" (GoHighLevel has it), or "AI answers your phone and books jobs" (Sameday has ~2,000 trades businesses at $449+/mo). Sell the agency's work done for you: zero setup, AI included, agents that run the whole loop.

Sameday already sells the call → book step to trades, and trades buy it as an add-on to the job software they already use (ServiceTitan, Housecall Pro), not as a replacement. What's still open is the whole loop from [Product](product.md): lead → answer and book → job → review and invoice chase → reactivation, run by one AI on records it owns. So the next features should each close a step of that loop (email, phone), and connectors to job software (Jobber, Housecall Pro) should copy their data into Companybot's records rather than reading it live, so we're an easy add-on on day one and still own the data later.
