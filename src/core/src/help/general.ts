import type { HelpPage } from "./index";

export default {
	id: "general",
	title: "Workspace settings: General, and managing workspaces",
	summary: "Logo, name, currency, memory on/off, deleting the workspace, and starting more.",
	text: `# General
[General](#/settings/general): open the workspace name above the sidebar → Workspace settings. Everyone can look; **only owners** change it. Edits are saved with the Save bar.

- **Logo**: its icon in the rail. PNG, JPEG, WebP or GIF, up to 2 MB.
- **Name**: the workspace's name.
- **Currency**: the default for new amounts. Existing amounts keep theirs.
- **Memory**: whether agents remember things. Off keeps existing memories for later. See **help: memory**.
- **Delete workspace** (owners, under Danger zone): deletes it and everything in it for everyone. Type its name to confirm.

## More workspaces
Press + in the rail to start another (you are its owner). You can own up to 10. To leave one, use the workspace name menu; the last owner can't leave.

The other workspace tabs are covered in **help: settings**.
`,
} satisfies HelpPage;
