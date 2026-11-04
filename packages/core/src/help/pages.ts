import type { HelpPage } from "./index";

export default {
	id: "pages",
	title: "Pages",
	summary: "Longer writing: wiki pages, how-tos, meeting notes, and notes on a record.",
	text: `# Pages
Pages are for longer writing, in the style of Notion. Find them under Pages in the sidebar; each opens at #/pages/<page id>.

- **Make one** with the + beside Pages. Nest pages by creating inside one (hover + on it) or using Move to…
- **Edit**: owners and members. Everyone can read. Type **/** in the page for blocks, including **Page** to create and open a child page. Child pages appear as blocks in their parent, with their current titles. Use a block’s menu to rename, move or archive its page.
- **History**: versions are saved as you edit. Open a version to read it, and restore it if you want it back. Restoring never loses the version it replaces.
- **Record notes**: every record has a page under its fields for notes about it (see **help: databases**).
- **With agents**: ask Companybot to find, read, write or move pages. It saves its edits in the page history, shown as "Edited by Companybot, for you".
- Archiving asks for confirmation and keeps the page and its sub-pages in [Archive](#/settings/archive). You can restore them at any time.
`,
} satisfies HelpPage;
