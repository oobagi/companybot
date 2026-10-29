import type { HelpPage } from "./index";

export default {
	id: "trash",
	title: "Trash",
	summary: "Where deleted things go for 30 days, and how to restore them.",
	text: `# Trash
[Trash](#/settings/trash) holds everything deleted, for **30 days**, then it is deleted forever.

- **What goes there**: records, databases, fields, pages, channels, agents, skills, automations and team memories. Personal memories are deleted for good.
- **Restore**: anyone who could delete the item can restore it, whoever deleted it. It comes back where it was, links included.
- **Delete forever**: owners only (agents never can).
- Search it, or filter by kind. An item can't be restored while its database is in Trash, or if its name was taken meanwhile.
- Things agents delete go to Trash too, and you can restore them the same way.
`,
} satisfies HelpPage;
