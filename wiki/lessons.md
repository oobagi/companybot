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
- Approvals happen in-thread and lock to the exact content approved.
- Show what's running: every agent and automation, with on/off.
- Track cost per message from day one. Keep tools and per-turn context small.
- Plain language. No vendor names, OAuth screens, or 2FA codes for teammates.
- Admin handoff: backup admin, so it survives when the technical person leaves.
