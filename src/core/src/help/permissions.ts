import type { HelpPage } from "./index";

export default {
	id: "permissions",
	title: "Permissions and approvals",
	summary: "Who can access each channel, database and page; when agents ask first, Allow once / Always allow / Deny, and action locks.",
	text: `# Permissions and approvals
Agents act as the person who asked. Anything that leaves Companybot (a send, a call, a payment, a change in another app) **asks first**. Companybot's own work (records, pages, memory) runs right away and is logged in [Activity](#/settings/activity); archiving anything always asks.

## The approval card
An agent's held action appears in the chat as a card from the agent, saying exactly what it wants to do ("Archive page"), with what it touches by name: the page, record or channel as you can see it, or "a page you can't see" when you can't. **Raw** shows the exact input. Three buttons:
- **Allow once**: run it this time.
- **Always allow**: run it now and don't ask again for this action. Only you can choose it, and not for locked actions. The card says what "always" covers.
- **Deny**: don't run it. The agent is told and carries on.

Only the person the agent is acting for can decide, within 24 hours. No role can decide for someone else. If it was already answered (on another device, say), the card just shows that answer.

What you approve is exactly what runs. The card names the exact page, record, field or chat, and if it's edited before the action runs (say, someone changes the page it would overwrite, or adds a record to a database it would archive), the action doesn't run; ask again. An approved action runs once, even if something retries it. If an action in another app gets cut off, its card says it **may or may not have happened**: check there before trying again.

## Web searches after private reads
Agents search the web and open links without asking. But once a reply has used anything not everyone in the workspace can see (a restricted database, page or channel, a connector only some roles can use, or a private channel or group DM it's working in), each web search, link it opens or call to another app asks first, showing exactly what goes out. There's no Always for these, and no lock or rule turns them off. Your own things in your own chat with an agent (your DM, personal memory) don't count, and an agent can keep reading from the same app it read from. Anything it sends or changes through that app still asks.

## Automations
In an automation someone else wrote, or one fed by outside text, acting as you also asks the first time. Choosing Always there covers that automation only. One held action never stops the rest of a run.

## Your rules and action locks
[Permissions](#/settings/permissions):
- **Yours**: your Always and Never rules and automation grants. Change or remove them any time.
- **Action locks** (people whose role can lock agent actions): make an action Always ask or Blocked for everyone, or lift a default lock. Strictest wins: a block beats your Always.

## Who can access
Each channel, database and page has a **Who can access** list: **Everyone**, chosen roles, or **Public** (people outside, below), each at **View** or **Edit** (**Post**, for a channel), or **Add** in a database. Like sharing in Google Drive or Notion.
- Not on the list means no access: they don't see it in the sidebar, search, links, Activity, history, Archive or unread counts, and their agents can't read it. A link to a record they can't see shows as a locked chip, without its name; a sub-page they can't open shows as "Page". What people typed stays as written, so a message can still mention it.
- **View** reads; **Edit** (or **Post**) also changes it. Owners always have Edit.
- **Add** (databases only) lets people add records and see, change or archive only the ones they made, like your own answers to a form. They never see anyone else's records, and can't change the database or its fields. They find their records in the database itself; search and Activity don't show them.
- Every place starts at Everyone, Edit, so nothing changes until someone restricts it. Examples: a read-only channel (Everyone: View, Office: Post), a read-only page, a private database (Deals: Office only).
- **Change it**: a channel's details (click its name), a database's settings, or a page's ⋯ menu. It takes the switch to change that kind of place, and Edit in it. A lock in the sidebar marks a restricted place; hover it for who can.
- **You can't lock yourself out**: a change that would take away your own Edit (Post, for a channel) is refused with "You'd lose edit access. Ask an Owner." Only owners can make it, since nobody else could undo it.
- **Sub-pages** follow their parent's list unless they set their own. A record's page, and the pages inside it, follow its database unless they set their own. Moving a page never opens it to more people.
- **Private channels** keep their members; the list applies on top.
- **Agents** use the access of the person who asked. When that person can't see something, the agent says who can: "Only Office and Owners can see Deals." It names the place only if they asked for it by that name; otherwise it's "this database". In a channel they can only view, agents don't reply or follow up for them, and a reply already under way stops when they lose Post.

## Customers
When a customer emails or texts an agent, nobody on the team asked, so the agent acts as the **Public** role. It can answer, take a message or hand off, as owners allow in [Roles](#/settings/roles), and use only what's shared with Public:
- Add **Public** to a page's or database's Who can access list, like any role. A page at View, and the sub-pages that follow its list, can be read to customers. A database at View lets the agent look up its records; at **Add**, the agent can add records for the customer and show, change or cancel only theirs (the customer is whoever writes from that email address or number).
- Public can never hold Edit, a channel, settings, members, roles, memory, connectors or automations. That ceiling is fixed; sharing anything above it is refused.
- Customers see records' plain fields only: never teammates, links to other records, or a record's page. Keep internal notes out of databases shared with Public.
- A place holding facts from somewhere restricted can't be shared with Public.
- Changes show in history as the agent, for the customer: "Companybot, for (555) 123-4567 by text".

Unless agents may reply on their own, each reply waits in [Inbox](#/inbox) for someone to send it. When you ask an agent to email or text someone, that's yours: it asks first, like any message leaving the workspace. To do more when customers write (add a lead, tell #sales), make an automation that runs when someone new emails or texts (see **help: automations**): it runs as you, not as the customer.

## Roles
What else a person can do comes from their roles (managing members, agents, connectors, locks and more). See **help: members**.
`,
} satisfies HelpPage;
