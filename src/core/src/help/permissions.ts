import type { HelpPage } from "./index";

export default {
	id: "permissions",
	title: "Permissions and approvals",
	summary: "When agents ask first, Allow once / Always allow / Deny, and action locks.",
	text: `# Permissions and approvals
Agents act as the person who asked. Anything that leaves Companybot (a send, a call, a payment, a change in another app) **asks first**. Companybot's own work (records, pages, memory) runs right away and is logged in [Activity](#/settings/activity).

## The approval card
An agent's held action appears in the chat as a card from the agent, saying exactly what it wants to do, with three buttons:
- **Allow once**: run it this time.
- **Always allow**: run it now and don't ask again for this action. Only you can choose it, and not for locked actions. The card says what "always" covers.
- **Deny**: don't run it. The agent is told and carries on.

Only the person the agent is acting for can decide, within 24 hours. No role can decide for someone else.

## Automations
In an automation someone else wrote, or one fed by outside text, acting as you also asks the first time. Choosing Always there covers that automation only. One held action never stops the rest of a run.

## Your rules and action locks
[Permissions](#/settings/permissions):
- **Yours**: your Always and Never rules and automation grants. Change or remove them any time.
- **Action locks** (people whose role can lock agent actions): make an action Always ask or Blocked for everyone, or lift a default lock. Strictest wins: a block beats your Always.

## Roles
What else a person can do comes from their roles (managing members, agents, connectors, locks and more). See **help: members**.
`,
} satisfies HelpPage;
