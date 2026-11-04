import type { HelpPage } from "./index";

export default {
	id: "trash",
	title: "Archive",
	summary: "Keep archived items and restore them at any time.",
	text: `# Archive
[Archive](#/settings/archive) holds archived items until you restore them or explicitly delete them forever.

- **What goes there**: records, databases, fields, pages, channels, agents, skills, automations and team memories. Personal memories are deleted for good.
- **Restore**: anyone who could delete the item can restore it, whoever deleted it. It comes back where it was, links included.
- **Before archiving**: Companybot asks you to confirm. Archiving preserves content and never automatically deletes it.
- **Delete forever**: owners only (agents never can).
- Search it, or filter by kind. An item can't be restored while its database is in Archive, or if its name was taken meanwhile.
- Things agents delete go to Archive too, and you can restore them the same way.
`,
} satisfies HelpPage;
