import type { HelpPage } from "./index";

export default {
	id: "general",
	title: "Workspace settings: General, and managing workspaces",
	summary: "Logo, name, currency, memory on/off, the picture model and monthly image budget, deleting the workspace, and starting more.",
	text: `# General
[General](#/settings/general): open the workspace name above the sidebar → Workspace settings. Everyone can look; **only owners** change it. Edits are saved with the Save bar.

- **Logo**: its icon in the rail. PNG, JPEG, WebP or GIF, up to 2 MB.
- **Name**: the workspace's name.
- **Currency**: the default for new amounts. Existing amounts keep theirs.
- **Memory**: whether agents remember things. Off keeps existing memories for later. See **help: memory**.

## Pictures
Agents with the picture tool (Companybot has it) make a picture when you ask ("make a logo for our roofing ad"), or edit one attached in the chat ("make the roof red"). The picture is attached to their reply. They can only edit pictures from chats you can see.
- **Picture model**: what they make pictures with, from AI Gateway's list. Nano Banana is the default.
- **Monthly budget**: what agents may spend on pictures each month, in US dollars ($20 to start). Owners also see what's been used this month. Pictures still being made count too, so several at once can't go past it by more than one picture. Once it's used up, agents say so until next month or until an owner raises it. **$0 turns pictures off.** Picture costs show under Images on [Usage](#/settings/usage).

- **Delete workspace** (owners, under Danger zone): deletes it and everything in it for everyone. Type its name to confirm.

## More workspaces
Press + in the rail to start another (you are its owner). You can own up to 10. To leave one, use the workspace name menu; the last owner can't leave.

The other workspace tabs are covered in **help: settings**.
`,
} satisfies HelpPage;
