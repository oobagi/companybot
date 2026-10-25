# Permissions

How agents get the go-ahead for actions that leave the building. Start strict, loosen as trust builds. Code: `core/src/approvals.ts` (rules), `backend/convex/permissions.ts` (storage, checks), `backend/convex/approvals.ts` (the card). How to add a risky tool: [Extending → Approvals](extending.md).

## What asks
- Every tool has a **risk** (`toolRisk`): `none` runs right away; `outside` asks first; `locked` always asks and never offers "Always allow".
- Default: connector tools not marked read-only are `outside` (unlabeled tools ask; a server's read-only label is its claim). A connector tool the server marks `destructiveHint` is `locked`, even if it also claims read-only (hints only ever tighten). Built-ins are `none` unless they declare `risk`; none do yet. Future sends, calls and campaign tools declare `outside`; payments, deleting records and bulk sends declare `locked`.
- Internal changes (CRM edits, moving a deal) run right away, are logged, and can be undone.

## Rules
- **Per person, per action.** An action is one tool on one connector install (`crm.send_sms`), or a built-in. A rule (`permissionRules`) is Always or Never; no rule = Ask. Agents act as whoever asked, so a rule only applies to that person's calls and never reaches anyone else's accounts.
- **Owner locks** (`permissionLocks`, `actions.lock` permission): Always ask, Blocked, or (for `locked` tools) Unlocked. Apply to everyone, reads included.
- **Strictest wins** (`permissionFor`): owner block → person's Never → owner/default lock (ask, no Always) → no risk (run) → person's Always → automation grant → ask.
- **Checked fresh at every call** (`permissions.check`, via the AI SDK's `toolApproval`). Nothing is cached in a session, so revoking or locking applies to the very next call. A call approved on the card is re-checked before it runs: a block or Never set since wins.
- Rules key on the person and the action only, never on a snapshot of content, so unrelated changes can't void or block them (the "approvals broke silently" lesson).
- Uninstalling a connector deletes its rules and locks; removing a member deletes theirs. Reinstalling or rejoining starts strict.

## The card
- The held call shows as **its own message from the agent**, after its reply: "I'd like to send an email to dana@acme.com from your Gmail.", the exact input, then **Allow once / Always allow / Deny**. It stays in the timeline with the outcome ("Allowed once by Jaden"); what the call returned sits behind **Raw**, since the agent's reply says it in words.
- Actions are named the same everywhere (`actionLabel`): the MCP tool's title, else its name in words ("send_sms" → "Send SMS"). Phone numbers show laid out; what runs and what's hashed is the exact input. Tool lines under replies say what happened ("Sent SMS with Fake CRM", `toolLine`).
- Under the buttons, in plain words, what "always" covers: "Always allow: agents can send email from your Gmail without asking you first. Only when acting for you." Settings uses the same text (`alwaysAllowText`), minus the pointer to Settings.
- "Always allow" saves the rule and runs the call. Not shown for locked actions or to anyone but the person the agent acts for.
- Unchanged: locked to the hash of the exact call, only the acting person decides, 24h window, byte-identical replays.
- Blocked calls (Never or owner block) don't run; the model is told why, and the tool line shows failed.

## Automations
- Turning one on (or "Turn on for me", or resuming a paused one) lists what its agent may do that would ask: only tools the agent is granted, and only for automations the person can see. **Allow** saves Always grants scoped to that automation and person (`automationInstallId` on the rule); Cancel does nothing. If nothing would ask, it just turns on.
- A run belongs to an automation when its trigger message was posted by it. Grants apply only to those runs; the same person chatting normally is still asked.
- A held call remembers its automation (`approvals.automationInstallId`). If the automation is deleted, its card no longer offers "Always allow": a grant is never widened to a person-wide rule.
- Anything new pauses and asks in the DM, as before. Turning it off for yourself, or deleting it, removes the grants.

## Where it shows up
1. **Chat:** the permission message with three buttons.
2. **Turning on an automation:** one screen listing its actions → Allow / Cancel. Its page shows what's allowed, with Review.
3. **Settings → Your preferences → Permissions:** your Always and Never rules and automation grants, editable.
4. **Connector detail page → Actions:** each action Ask / Always / Never (same rules as #3). Listed from what the server last reported (`connectorTools`, updated each turn or with "Refresh list"); display only, calls are decided on the live tool.
5. **Settings → General (owners) → Action locks.**
6. **Activity:** each auto-allowed call says how ("Always allowed by Jaden, Oct 25"), links to the rule, or notes it was removed since.

## Later
- Recipient-scoped grants ("always allow emails to @acme.com").
- Personal-data detection: ask even under Always when a send carries an address, phone or payment details.

## How others do it (Oct 2026)
- **Claude Code:** allow / ask / deny rules, checked deny → ask → allow; admin-managed rules can't be overridden; `/permissions` lists every rule and where it came from. [Docs](https://code.claude.com/docs/en/permissions)
- **ChatGPT workspace agents:** connector writes default to "Always ask"; builders can set some to "Never ask" or approve specific actions; admins can limit what connectors may be asked to do. [Help](https://help.openai.com/en/articles/20001143-workspace-agents-in-chatgpt)
- **Lindy:** a per-action "Ask for confirmation" toggle on anything with side effects; the agent pauses and emails you, and you approve in the app. Their advice: start with oversight and loosen as trust builds. [Docs](https://docs.lindy.ai/testing/human-in-the-loop.md)
- **Copilot Studio:** per-tool approval with approve / approve for this session / deny; admins classify connectors (business, non-business, blocked). [Summary](https://m365admin.handsontek.net/?p=23665)
- **Meta Muse:** permission prompts appear as chat messages from the agent, not tool boxes. Its "Allow Always" let it message Marketplace buyers on its own, including a seller's home address: he expected to still be asked at key steps. Lesson: say exactly what "always" covers and that you won't be asked again. [Write-up](https://redreamality.com/blog/meta-muse-allow-always-agent-permission-defaults/)
- **MCP tool hints:** clients usually auto-approve read-only tools and confirm destructive ones, but hints aren't guarantees; unlabeled tools should be treated as destructive. [Speakeasy](https://www.speakeasy.com/docs/mcp/build/gram-functions/tool-annotations)

What we take: Claude Code's strictest-wins order and owner locks, Lindy's per-action toggle and "loosen as trust builds," MCP's untrusted hints, and Muse's in-chat prompts with plainer "always" wording. We skip "for this session" because Companybot has no sessions (one continuous conversation per agent).
