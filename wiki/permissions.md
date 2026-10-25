# Permissions (planned)

How agents get the go-ahead for actions that leave the building. Today's approval card is the base; this page is where it goes next. How the current card works: [Extending → Approvals](extending.md).

## Today
- Only connector writes ask (`needsApproval`: connector tools not marked read-only). No built-in does.
- The card offers Approve / Deny, once per call, locked to the exact call. Only the person the agent acts for decides, within 24h.
- Automations ask in that person's DM, every time, so a busy automation means a tap per send.

## The plan
- **Three answers on the card: Allow once / Always allow / Deny.** "Always allow" saves a rule, and the call runs.
- **Three settings per action: Ask (default) / Always / Never.** Strictest wins: an owner's lock beats a person's rule, and Never beats Ask, which beats Always.
- **Rules belong to a person and one action.** "Agents may send email from *my* Gmail without asking." Agents act as whoever asked, so a grant follows that person and never reaches anyone else's accounts.
- **Owner locks.** Owners can force an action to always ask, or block it, for everyone. Payments, deleting records and bulk sends are locked by default, so "Always allow" never appears for them.
- **Automations ask up front.** Turning one on lists what it will do ("sends email from your Gmail, texts leads") and asks once. Those grants are scoped to that automation. If it later tries something new, it pauses and asks in a DM.
- **What asks:** anything with outside impact: sends (email, texts, campaigns), calls, payments, and connector writes. Internal changes (editing a CRM record, moving a deal) run right away, are logged, and can be undone.
- **Every auto-approved action says why** in Activity: "Always allowed by Jaden, Oct 25."
- **Untrusted hints stay untrusted.** A connector's "read-only" label is the server's claim. Unlabeled tools ask; owners can override a label.

## Where it shows up
1. **Chat:** the approval card, with three buttons.
2. **Turning on an automation:** one screen listing its actions → Allow / Cancel.
3. **Settings → Your preferences → Permissions:** everything you've set to Always or Never, with a way to change it.
4. **Connector detail page:** each action set to Ask / Always / Never (the same rules as #3, seen from the connector's side).
5. **Settings (owners):** workspace locks.
6. **Activity:** how each action was approved.

## How others do it (Oct 2026)
- **Claude Code:** allow / ask / deny rules, checked deny → ask → allow; admin-managed rules can't be overridden; `/permissions` lists every rule and where it came from. [Docs](https://code.claude.com/docs/en/permissions)
- **ChatGPT workspace agents:** connector writes default to "Always ask"; builders can set some to "Never ask" or approve specific actions; admins can limit what connectors may be asked to do. [Help](https://help.openai.com/en/articles/20001143-workspace-agents-in-chatgpt)
- **Lindy:** a per-action "Ask for confirmation" toggle on anything with side effects; the agent pauses and emails you, and you approve in the app. Their advice: start with oversight and loosen as trust builds. [Docs](https://docs.lindy.ai/testing/human-in-the-loop.md)
- **Copilot Studio:** per-tool approval with approve / approve for this session / deny; admins classify connectors (business, non-business, blocked). [Summary](https://m365admin.handsontek.net/?p=23665)
- **MCP tool hints:** clients usually auto-approve read-only tools and confirm destructive ones, but hints aren't guarantees; unlabeled tools should be treated as destructive. [Speakeasy](https://www.speakeasy.com/docs/mcp/build/gram-functions/tool-annotations)

What we take: Claude Code's strictest-wins order and owner locks, Lindy's per-action toggle and "loosen as trust builds," and MCP's untrusted hints. We skip "for this session" because Companybot has no sessions (one continuous conversation per agent).
