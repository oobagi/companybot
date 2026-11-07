import type { HelpPage } from "./index";

export default {
	id: "drive",
	title: "Drive: folders and files",
	summary: "Where pages, folders and files live: upload, organize, open and share them, and what agents can do with them.",
	text: `# Drive
Drive (in the rail, #/pages) holds the team's pages, folders and files, like Google Drive. Its sidebar is the tree: folders, pages and files in the order you put them (new ones go last), or with folders above the rest if you turn on **Folders on top** in [Your preferences](#/settings/preferences). The top level and each folder also have a screen that lists what's in them.

- **Folders** hold folders, pages and files. Pages hold sub-pages only (see **help: pages**). Files sit in a folder or at the top level.
- **Make one** with the + beside Drive: New page, New folder or Upload files. A folder's ⋯ menu has New page inside, New folder inside and Upload here. On a folder's screen, use + New, or drop files onto the list.
- **Files** can be pictures (PNG, JPEG, WebP, GIF), PDF, Word, Excel, PowerPoint, and plain text (Markdown, CSV, JSON), up to 20 MB each, the same as chat attachments. A file opens at #/files/<file id>: pictures and PDFs show as they are; Word, Excel, CSV and PowerPoint show their text, tables and slides; **Open in browser** downloads the original.
- **Rename** a file or folder in the sidebar's ⋯ menu or by clicking its title on its screen. **Move** by dragging: the row follows the pointer and the others make room; drag left to leave a folder or right to stay in it, drop it onto a folder (a page onto a page) to put it in there, last, or onto Home for the top level. Anything also drags up and down to reorder (people whose role can rearrange the sidebar). **Move to…** in the ⋯ menu does the same from a list: a page into any page or folder, a folder or file into any folder (or the top level).
- **Who can access**: a folder or file follows its folder's list until you change theirs ("Use folder's" goes back); a top-level one follows the default, Everyone at Edit ("Reset to default"). People need the role switch to write and change pages, folders and files (Member, to start), and Edit in the place, to change it. See **help: permissions**.
- **Archive**: archiving a folder archives everything in it; restore from [Archive](#/settings/archive) at any time. A file restored while its folder is still archived lands at the top level.
- **Pins**: Pin to rail is in every row's ⋯ menu, for folders and files too.
- **Recent**, **Shared in chat** and **Private** sit under Home in the sidebar (#/drive/recent, #/drive/shared, #/drive/private). They say "Coming soon" for now: nothing is in them yet.
- **With agents**: ask Companybot to find a file ("the Q3 budget spreadsheet"), read it (text, tables and slides; pictures only through chat), save a chat attachment into a folder, write a text, Markdown, CSV or JSON file, or rename, move and archive files. It can also make folders and put pages in them.
`,
} satisfies HelpPage;
