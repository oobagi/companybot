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
- **List**: click a name to open the record; other cells edit in place. Columns picks, hides and edits fields. Click a header to sort (the sort shows as a chip to flip or remove), and Filter adds a chip per condition. Search by name and text.
- **Saved views**: save a filter, sort and columns (or a board) to share with the workspace. View tab order and the All tab's columns and layout are also shared. Only people whose role can rearrange shared sidebar lists can change these, and the All tab's layout also takes Edit in the database.
- **Field icons and option colors**: in a field's settings (click its name in Columns or on a record), the icon beside its name picks one from a set, or Reset to default for its kind's. Each option of a choice field has a color: click its swatch to change it. New options get the next color in turn.
- **Board**: cards grouped by a choice field. A database without one can't be shown as a board; add a choice field first.
- **Record page**: a page like any in Drive, with the record's fields at the top, edited in place. Under them, rows for records that link to it, **In chat**: the chat messages that tag it (with @ in a message, see **help: chat**; only ones you can see), and follow-ups agents set about it (see **help: automations**). Then the page itself, for longer notes, with sub-pages and everything else a page has (see **help: pages**).
- **History**: every change with who and when (an agent shows as "Companybot, for Jaden"). Undo reverses one change.
- **Changing a field**: click a field (in Columns, a header's menu, or on a record) to change any of its settings: name, kind, options, whether it holds several, and the database it links to. A new kind converts the values already there: anything becomes text the way it reads; text becomes numbers, amounts, dates, checkboxes, emails, phones or websites when it parses ("$1,234.56" → 1234.56), choices with one option per different value (up to 100), people by name or email, and links by a record's exact name. Several → one keeps each record's first value. If a change would clear values (or drop a view's filter), Edit field says so, with a few examples, before you save. Values convert in the background; the field reads "Converting…" and can't be edited until it's done. Saved views lose filters, sorts or grouping on it that no longer fit, and say so.
- **Undoing a field change**: Edit field and [Activity](#/settings/activity) show the last change with Undo. It brings back the old kind and every record's old value, cleared ones too, unless a record changed since (then its newer value converts back). Old values are kept for 30 days.
- **Money**: each amount keeps its own currency. The workspace currency in [General](#/settings/general) only sets the default for new ones.

## With agents
Ask Companybot to find, add, change or delete records, add fields ("start tracking roof type on clients") or change one ("make Budget a number"). It shows what a field change would do and asks before running it. It acts as you, and its changes appear in history and [Activity](#/settings/activity).

## Deleting
Deleted records, databases and fields go to [Archive](#/settings/archive). A record's pages go with it, and come back when you restore it.
`,
} satisfies HelpPage;
