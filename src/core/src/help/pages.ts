import type { HelpPage } from "./index";

export default {
	id: "pages",
	title: "Pages",
	summary: "Longer writing: wiki pages, how-tos, meeting notes, and notes on a record.",
	text: `# Pages
Pages are for longer writing, in the style of Notion. Find them in Drive (in the rail), in its sidebar with folders and files (see **help: drive**); each opens at #/pages/<page id>.

- **Make one** with the + beside Drive (New page), or inside a folder. Nest a page by typing /page in the page it goes in; that's the only way in, so you always see where it went. Put files and folders in folders.
- **Edit**: people whose role can write and change pages (Member, to start), and who have Edit in the page.
- **Who can access**: in a page's ⋯ menu. Everyone, or chosen roles, at View or Edit; or **Public** at View, so agents can answer customers from it (an FAQ, opening hours). Sub-pages follow their parent's list until you change theirs ("Use parent page's" goes back); one with its own list isn't shared because its parent is. See **help: permissions**. Type **/** in the page for blocks, including **Page** to create and open a child page. Child pages appear as blocks in their parent, with their current titles (one you can't open shows as "Page"). Use a block’s menu to rename, move or archive its page.
- **History**: versions are saved as you edit. Open a version to read it, and restore it if you want it back. Restoring never loses the version it replaces.
- **Record pages**: every record is a page too, with its fields at the top (see **help: databases**). It works like any page, sub-pages included; a page inside a record shows the database and record in its trail, follows the database's Who can access list, and goes to Archive with the record.
- **With agents**: ask Companybot to find, read, write or move pages, or make folders for them. It saves its edits in the page history, shown as "Edited by Companybot, for you".
- Archiving asks for confirmation and keeps the page and its sub-pages in [Archive](#/settings/archive). You can restore them at any time.
`,
} satisfies HelpPage;
