import { imageMaxMb, pictureLimits } from "../images";
import type { HelpPage } from "./index";

export default {
	id: "general",
	title: "Workspace settings: General, and managing workspaces",
	summary: "Logo, name, currency, memory on/off, the picture model and monthly image budget, resetting or deleting the workspace, and starting more.",
	text: `# General
[General](#/settings/general): open the workspace logo at the top of the rail → Workspace settings. Everyone can look; people whose role can change workspace settings change it. Edits are saved with **Save** at the top right (**Discard** drops them); both stay off until something changes.

- **Logo**: its icon at the top of the rail. ${pictureLimits}.
- **Name**: the workspace's name.
- **Currency**: the default for new amounts. Existing amounts keep theirs.
- **Memory**: whether agents remember things. Off keeps existing memories for later. See **help: memory**.

## Pictures
Agents with the picture tool (Companybot has it) make a picture when you ask ("make a logo for our roofing ad"), or edit one attached in the chat ("make the roof red"). The picture is attached to their reply. They can only edit pictures from chats you can see.

They can also use a picture from the chat, one they made or one someone attached, as the workspace logo (owners), your photo or an agent's picture ("make that our logo"), put it in a page, or send it to another chat. Each use is a copy, so it stays if the message is deleted. Pictures can be up to ${imageMaxMb} MB. With web access they can save a picture or file from a website too ("use the logo from acme.com").
- **Picture model**: what they make pictures with, from a short list we've tried, each with what it's best at and its price per picture: GPT Image 2.5 Flare (the default), GPT Image 2.5 Sunburst, Nano Banana 2.1, FLUX 3 and Recraft V4.1. If a model is retired, workspaces on it switch to the default.
- **Monthly budget**: what agents may spend on pictures each month, in US dollars ($20 to start). People who can change it also see what's been used this month. Pictures still being made count too, so several at once can't go past it by more than one picture. Once it's used up, agents say so until next month or until someone raises it. **$0 turns pictures off.** Picture costs show under Images on [Usage](#/settings/usage).

## Danger zone (owners only)
Both ask you to type the workspace's name first, and neither can be undone.
- **Reset workspace**: puts it back to how it was when it was made. Every message, chat, DM, memory, database, page, automation, connector, skill (personal ones too), permission rule, file and everything in Archive is deleted, and it starts again with the default agents and #general, everyone in it, and the tutorial from the start. **Kept:** its members, its roles (custom ones too) and who has which, pending invites, its name, logo and settings, and its usage (what was spent still counts). It's closed to everyone while it resets, then everyone's app opens #general. General shows who last reset it, and when.
- **Delete workspace**: deletes it and everything in it for everyone.

## More workspaces
Pick **New workspace** in the workspace logo's menu (top of the rail) to start another (you are its owner). You can own up to 10. To leave one, pick **Leave** in the same menu; the last owner can't leave.

The other workspace tabs are covered in **help: settings**.
`,
} satisfies HelpPage;
