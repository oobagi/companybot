import type { HelpPage } from "./index";

export default {
	id: "account-settings",
	title: "Your preferences (account settings)",
	summary: "Your photo, name, time zone, send key, notifications, updates, and deleting your account.",
	text: `# Your preferences
[Your preferences](#/settings/preferences): open your avatar at the bottom of the rail → Account settings. Only you see these, except your photo, name and time zone. They follow you to every device and workspace.

- **Photo**: PNG, JPEG, WebP or GIF, up to 2 MB.
- **Name**: what agents and teammates call you.
- **Time zone**: automatic (your computer's) or one you pick. Agents use it for dates and times.
- **Send messages with**: Enter (Shift+Enter for a new line) or ⌘ Enter.
- **Notifications**: DMs and mentions, mentions only, or off. Applies when Companybot isn't in front, and to the dock count.
- **App**: your version, Check for updates, and Restart to update when one is ready.
- **Delete account**: leaves every workspace and erases your account. Type your email to confirm. Workspaces only you are in are deleted; if you are the only owner of one with others, make someone else an owner first. What you said in shared chats stays, as a former member's.
`,
} satisfies HelpPage;
