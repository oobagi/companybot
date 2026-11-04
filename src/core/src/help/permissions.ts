import type { HelpPage } from "./index";

export default {
	id: "permissions",
	title: "Permissions and approvals",
	summary: "Who can access each channel, database and page; when agents ask first, Allow once / Always allow / Deny, and action locks.",
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

## Who can access
Each channel, database and page has a **Who can access** list: **Everyone**, or chosen roles, each at **View** or **Edit** (**Post**, for a channel). Like sharing in Google Drive or Notion.
- Not on the list means no access: they don't see it in the sidebar, search, links, Activity, history, Archive or unread counts, and their agents can't read it. A link to a record they can't see shows as a locked chip, without its name; a sub-page they can't open shows as "Page". What people typed stays as written, so a message can still mention it.
- **View** reads; **Edit** (or **Post**) also changes it. Owners always have Edit.
- Every place starts at Everyone, Edit, so nothing changes until someone restricts it. Examples: a read-only channel (Everyone: View, Office: Post), a read-only page, a private database (Deals: Office only).
- **Change it**: a channel's details (click its name), a database's settings, or a page's ⋯ menu. It takes the switch to change that kind of place, and Edit in it. A lock in the sidebar marks a restricted place; hover it for who can.
- **Sub-pages** follow their parent's list unless they set their own. A record's page follows its database. Moving a page never opens it to more people.
- **Private channels** keep their members; the list applies on top.
- **Agents** use the access of the person who asked. When that person can't see something, the agent says who can: "Only Office and Owners can see Deals." In a channel they can only view, agents don't reply or follow up for them.

## Roles
What else a person can do comes from their roles (managing members, agents, connectors, locks and more). See **help: members**.
`,
} satisfies HelpPage;
