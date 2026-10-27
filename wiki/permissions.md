# Permissions

How agents get the go-ahead for actions that leave the building. Start strict, loosen as trust builds. This page owns action rules and approval invariants. How to add a tool: [Extending](extending.md#action-rules-and-approvals).

## What asks
- Every tool has a **risk** (`toolRisk`): `none` runs right away; `outside` asks first; `locked` always asks and never offers "Always allow".
- Default: connector tools not marked read-only are `outside` (unlabeled tools ask; a server's read-only label is its claim). A connector tool the server marks `destructiveHint` is `locked`, even if it also claims read-only (hints only ever tighten). Built-ins are `none` unless they declare `risk`. Member invitations (including resend/cancel in the invitation group) declare `outside`; member removal, skill deletion/uninstall and automation deletion/uninstall declare `locked`. Future outside sends and calls declare `outside`; payments, deleting records and bulk sends declare `locked`.
- Internal message delivery, channel changes, skill edits/installs, automation edits/pause/resume and non-security workspace settings follow the acting person's normal rights and run immediately. An agent delivery names the agent and person, does not mark the person's destination read, and never triggers another agent or automation. Resuming or subscribing never grants Always consent.
- Internal changes (record edits, database management, shared sorting and filtering) run right away and are logged. Records have undo; database and saved-view changes do not. Owners create, rename and archive databases (`fields.manage`); owners and members manage shared views (`records.edit`). Both the app and agents use the same server checks.

## Rules
- Grouped tools use an action union but one approval identity per tool. Separate outside invitations from locked removals; an Always rule for invitations must never authorize a removal. The exact nested request is hashed and shown on the card.
- The parity registry (`parity.ts`, tested against every public mutation) maps agent actions and human-only reasons. Role changes, owner invites, agent grants/self-modification, credentials, consent policy and account erasure stay direct human decisions. `Pending` entries are existing follow-up gaps, not new policy restrictions.
- **Per person, per action.** An action is one tool on one connector install (`crm.send_sms`), or a built-in. A rule (`permissionRules`) is Always or Never; no rule = Ask. Agents act as whoever asked, so a rule only applies to that person's calls and never reaches anyone else's accounts.
- **Owner locks** (`permissionLocks`, `actions.lock` permission): Always ask, Blocked, or (for `locked` tools) Unlocked. Apply to everyone, reads included.
- **Strictest wins** (`permissionFor`): owner block → person's Never → owner/default lock (ask, no Always) → no risk (run) → person's Always → automation grant → ask.
- **Checked fresh at every call** (`permissions.check`, via the AI SDK's `toolApproval`). Nothing is cached in a session, so revoking or locking applies to the very next call. A call approved on the card is re-checked before it runs: a block or Never set since wins.
- Rules key on the person and the action only, never on a snapshot of content, so unrelated changes can't void or block them (the "approvals broke silently" lesson).
- Uninstalling a connector deletes its rules and locks; removing a member deletes theirs. Reinstalling or rejoining starts strict.

## The card
- The held call shows as **its own message from the agent**, after its reply: "I'd like to send an email to dana@acme.com from your Gmail.", the exact input, then **Allow once / Always allow / Deny**. It stays in the timeline with the outcome ("Allowed once by Jaden"); what the call returned sits behind **Raw**, since the agent's reply says it in words.
- Actions are named the same everywhere (`actionLabel`): the MCP tool's title, else its name in words ("send_sms" → "Send SMS"). Phone numbers show laid out; what runs and what's hashed is the exact input. Tool lines under replies say what happened ("Sent SMS with Fake CRM", `toolLine`); a tool with `label` names what this call touched ("Saved Acme Roofing"). Labels are stored on the reply's tool part, never replayed to the model.
- Under the buttons, in plain words, what "always" covers: "Always allow: agents can send email from your Gmail without asking you first. Only when acting for you." Settings uses the same text (`alwaysAllowText`), minus the pointer to Settings.
- "Always allow" saves the rule and runs the call. Not shown for locked actions or to anyone but the person the agent acts for. The server enforces it too: `decide({ always: true })` is refused wherever the action always asks (locked, or an owner's "ask" lock), and scoped to the automation if the run was one's.
- The runner saves the exact held call with its `risk` (`approvals.request`).
- The lock is SHA-256 of canonical JSON of the tool id and exact input (`approvalHash`). The app returns the hash it showed; `decide` refuses any other; `claim` re-hashes before running. Only the acting person decides, while they can see the chat, within 24h. Owners cannot decide for someone else. Compare nothing else: unrelated changes never void a call.
- `approvals.decide` queues a normal turn in the same place with `approvalId`. It runs the approved call first, then gives the agent its outcome through `buildTurnPrompt`. Replays note the held call without its outcome, staying byte-identical.
- Cards are `approval` message parts. `messages.list` returns them in `fullParts`; older apps get a text line in `parts`.
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

## Code
- `core/src/action-rules.ts`: risk, per-person rules, owner locks, `permissionFor` and denial reasons. Role gates stay in `core/src/permissions.ts`.
- `core/src/action-words.ts`: labels, asks, Always text and tool lines. The card and Settings use the same helpers.
- `core/src/approvals.ts`: exact-call hashes, status, expiry and who may decide.
- `backend/convex/permissions.ts`: stores rules and locks, checks calls, and grants automation actions. `connectorTools.ts` owns the last-listed connector metadata; settings read it, but calls use the live tool.
- The runner supplies `toolApprovalPolicy(usable, check)` as the AI SDK's `toolApproval`. Built-ins with no risk skip the check; connector reads are checked too. A rule-allowed call logs `allowed` (how, who, when, rule id).
- `backend/convex/approvals.ts`: holds, decides and claims calls. Tests: `backend/tests/permissions.test.ts` and `approvals.test.ts`; pure helpers have matching core tests.

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
