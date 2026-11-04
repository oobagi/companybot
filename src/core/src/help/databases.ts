import type { HelpPage } from "./index";

export default {
	id: "databases",
	title: "Databases and records",
	summary: "Clients, deals, tasks and anything else the team tracks: databases, fields, records, views.",
	text: `# Databases and records
A **database** is a collection of records the team tracks: clients, deals, jobs, anything. A **record** is one row. A **field** is one piece of info on it ("Stage", "Monthly retainer"). New workspaces start with none: create what you need.

Each database has its own entry in Databases' sidebar (Databases in the rail); its address is #/records/<key>. Older shortcuts like #/clients still open too.

## Who can do what
- **Create, rename or delete databases, and add or change fields**: people whose role can add and change databases and fields (not Member, to start; an owner can turn it on). The + is beside Databases.
- **Add and edit records, undo changes**: people whose role can add and change records (Member, to start).
- **Who can access**: each database's settings has a Who can access list (Everyone, or chosen roles, at View or Edit). Its records and their pages follow it. People not on it don't see the database at all, and links to its records show as locked chips. See **help: permissions**.

## Using a database
- **List**: pick columns, click a header to sort, and filter by any field. Search by name and text.
- **Saved views**: save a filter, sort and columns (or a board) to share with the workspace. View tab order and the All tab's columns and layout are also shared. Only people whose role can rearrange shared sidebar lists can change these.
- **Record page**: edit fields in place. Below: pending follow-ups agents set about it (see **help: automations**), linked records, chat messages that mention it, and the record's page for longer notes (see **help: pages**).
- **History**: every change with who and when (an agent shows as "Companybot, for Jaden"). Undo reverses one change.
- **Money**: each amount keeps its own currency. The workspace currency in [General](#/settings/general) only sets the default for new ones.

## With agents
Ask Companybot to find, add, change or delete records, or add fields ("start tracking roof type on clients"). It acts as you, and its changes appear in history and [Activity](#/settings/activity).

## Deleting
Deleted records, databases and fields go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
