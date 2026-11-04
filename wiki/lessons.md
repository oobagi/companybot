# Lessons from Cottonwood and Night Owl

## What failed
- **Night Owl's in-app agents (Sep 2026):** per-teammate DMs, group chats, scoped memory. 49 messages total in prod, then deleted. Built well, not used.
- **Schedules died with their owner:** a Cottonwood task paused when its chat was deleted; Night Owl campaigns stopped when one person's login expired.
- **Instructions ignored:** fresh ChatGPT chats skipped saved project instructions.
- **Shared chat with two people:** both turns ran at once, neither saw the other.
- **Approvals broke silently:** a snapshot-based check paused 134 recipients after an unrelated change.
- **Cost:** every tool + 44k chars of instructions per turn = up to $0.53/turn.

## Rules
- The workspace owns connections, inference, and schedules — never one person, chat, or login.
- Instructions and memory live server-side, versioned, applied to every chat and run.
- One AI turn per thread at a time; stream live to everyone.
- Approvals happen in-thread and lock to the exact content approved: bind ids and revisions, never names; recheck inside the effect's transaction; every write gets a durable call key in `toolReceipts` (#239).
- Show what's running: every agent and automation, with on/off.
- Track cost per message from day one. Keep tools and per-turn context small.
- Plain language. No vendor names, OAuth screens, or 2FA codes for teammates.
- Admin handoff: backup admin, so it survives when the technical person leaves.

## Scale and design rules (Nov 4 audit)
- **No fan-out in one transaction.** Work for N people or items runs as a batched or scheduled job (100 per run), never a loop in one mutation. See #228, `lifecycle.ts` cascades.
- **Fields that change often get their own doc.** Activity, counters and timestamps live apart (`chatActivity`, seat activity), so parent subscriptions don't re-run and writes don't conflict with `markRead`. See #237, #232.
- **Store counts and copies; don't collect them.** `memberCount` with ±1 at every write site; profile copied onto `members`. No list does one read per item. See #240.
- **Filter by permission in the index, never after `take`.** Otherwise others' rows crowd out yours. Public chats via a filter field; restricted chats per chat, with a cap the tool reports. See #232.
- **Label every private read; check the label at every destination.** Sources cover private chats, personal memory/skills, role-limited connectors and files. A write only reaches an audience that can open every source; outbound calls always ask when sources are restricted. See #210, #234, #239.
- **Keep the released app working.** Backend deploys before apps update (check every 4h, install on quit). Public functions keep old args and response shape, marked `COMPAT(<version>)`, until the version after next; readers fall back until backfill finishes, with one indexed read per place. Check against the last release tag before merging. See #237, #243.
- **Scale tests run the full `SCALE=1` suite with real Convex limits**, not just new tests. Seed in bulk; test helpers must not hide per-item reads that production has. See #240.
- **One failure must not stop everyone.** Count failures per recipient; pause only after repeated whole-run failures, reset on resume, retry transient errors with backoff. See #228.
