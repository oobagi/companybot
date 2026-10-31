import type { HelpPage } from "./index";

export default {
	id: "databases",
	title: "Databases and records",
	summary: "Clients, deals, tasks and anything else the team tracks: databases, fields, records, views.",
	text: `# Databases and records
A **database** is a collection of records the team tracks: clients, deals, jobs, anything. A **record** is one row. A **field** is one piece of info on it ("Stage", "Monthly retainer"). New workspaces start with none: create what you need.

Each database has its own entry under Databases in the sidebar; its address is #/records/<key>. Older shortcuts like #/clients still open too.

## Who can do what
- **Create, rename or delete databases**: owners (the + beside Databases).
- **Add and edit records, undo changes**: owners and members.
- **Add fields**: owners and members. You can rename, change or delete your own; owners can change anyone's.
- Everyone can read every record.

## Using a database
- **List**: pick columns, click a header to sort, and filter by any field. Search by name and text.
- **Saved views**: save a filter, sort and columns (or a board) to share with the workspace.
- **Record page**: edit fields in place. Below: linked records, chat messages that mention it, and the record's page for longer notes (see **help: pages**).
- **History**: every change with who and when (an agent shows as "Companybot, for Jaden"). Undo reverses one change.
- **Money**: each amount keeps its own currency. The workspace currency in [General](#/settings/general) only sets the default for new ones.

## With agents
Ask Companybot to find, add, change or delete records, or add fields ("start tracking roof type on clients"). It acts as you, and its changes appear in history and [Activity](#/settings/activity).

## Deleting
Deleted records, databases and fields go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
