import type { HelpPage } from "./index";

export default {
	id: "pages",
	title: "Pages",
	summary: "Longer writing: wiki pages, how-tos, meeting notes, and notes on a record.",
	text: `# Pages
Pages are for longer writing, in the style of Notion. Find them under Pages in the sidebar; each opens at #/pages/<page id>.

- **Make one** with the + beside Pages. Nest pages by creating inside one (hover + on it) or using Move to…
- **Edit**: owners and members. Everyone can read. Type **/** in the page for blocks, including a link to a new child page.
- **History**: versions are saved as you edit. Open a version to read it, and restore it if you want it back. Restoring never loses the version it replaces.
- **Record notes**: every record has a page under its fields for notes about it (see **help: databases**).
- **With agents**: ask Companybot to find, read, write or move pages. It saves its edits in the page history, shown as "Edited by Companybot, for you".
- Deleted pages go to [Trash](#/settings/trash) for 30 days.
`,
} satisfies HelpPage;
