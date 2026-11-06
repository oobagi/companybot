import type { HelpPage } from "./index";

export default {
	id: "overview",
	title: "What Companybot is, and finding your way around",
	summary: "What Companybot is, the screens, and the two kinds of settings.",
	text: `# What Companybot is
Companybot is where a team's chat, business data and AI agents live together. People talk in channels and DMs, keep their clients, deals and tasks in databases, write pages, keep files, and ask agents to do the work. **Companybot** is also the name of the main agent every workspace starts with.

A new workspace starts with one channel, #general, and one agent, Companybot. Databases, pages, skills and automations start empty: the team makes what it needs, and Companybot can help.

## Finding your way around
- **Rail** (far left): the parts of the app. [Chat](#/chat), Drive (pages, folders and files, #/pages), Databases (#/records) and Customize (agents, connectors, skills, automations). Press ⌘1–9 to jump to one, in the order shown (Ctrl+1–9 on Windows and Linux); it works while you type a message too. Chat shows a red count for unread mentions and DMs, or a dot when something is unread. Drag a tab to reorder them.
- **Pins and recents** (in the rail, under the tabs): anything you pin, then what you opened lately. Pin a channel, DM, side chat, page, folder, file or database with **Pin to rail** in its ⋯ menu in the sidebar, a single record (one client, one job) with **Pin** atop its page, or right-click any of them in the rail; drag pins to reorder. Pins, recents and the rail's order sync with your account, per workspace.
- **Your avatar** (bottom of the rail): [Your preferences](#/settings/preferences) and Sign out.
- **Workspace logo** (top of the rail): the open workspace. Its menu switches to another (⌃⌘1–9 also do; Ctrl+Shift+1–9 on Windows and Linux), answers invites, starts a new one, and opens Workspace settings or lets you leave. A red count means a mention or DM in another workspace; a dot means something unread there, or an invite.
- **Sidebar**: the open tab's things. For Chat: your channels, then your workspace's sections, then Direct messages. For Drive: Home, then All files (folders, pages and files), then the sections. For Databases: each database, then the sections. For Customize: Agents, Connectors, Skills and Automations. Click a section's title to fold it; a folded Chat section still shows the open channel and unread ones. **Sections** group things like folders in a sidebar: add one with **New section** in the + beside the tab's name, drag channels, top-level pages, folders and files, or databases into it, drag its title to move it, and use its ⋯ to rename or delete it (what it held goes back where it was). The + on a section's title makes something new in it. Press ⌥1–9 (Alt+1–9) to open the Nth item as shown, top level only; a folded section's items are skipped. Works while typing unless the key produces printable ASCII other than a digit (such as @, # or brackets). Shortcuts leave composing text alone.
- **Top bar**: where you are, plus that screen's actions.
- **Help button** (top right): What's new and Report a problem.

## What syncs
Your rail tabs, pins, recents, pin order, DM order, folded sections and expanded folders and pages follow your account in each workspace. Your workspace switcher order follows your account across workspaces.

Sidebar sections (their names, order and what's in them), channel order, page sibling order, database order, database view tab order, and each database's All tab columns and layout are shared with the workspace. People whose role can **rearrange shared sidebar lists** can change these; Member can unless an owner turned it off. Moving a page to another parent works as before.

Sidebar width, hidden state and chat drafts stay on this computer. On first load, existing arrangements from this computer are copied up only where nothing is saved yet, then the local keys are deleted. Recents start fresh; old pins are claimed by whoever signs in first on a shared computer. An import that fails retries next launch while you keep using the app.

## Two kinds of settings
- **Account settings** are yours alone: [Your preferences](#/settings/preferences).
- **Workspace settings** belong to the open workspace: [General](#/settings/general), [Members](#/settings/members), [Permissions](#/settings/permissions), [Memory](#/settings/memory), [Activity](#/settings/activity), [Usage](#/settings/usage), [Archive](#/settings/archive). Agents and what they work with open from Customize in the rail instead: [Agents](#/settings/agents), [Connectors](#/settings/connectors), [Skills](#/settings/skills), [Automations](#/settings/automations).

See the **help: settings** topic for who can change what.

## Roles
Each person holds one or more roles in each workspace, like **Owner** or **Member**. Roles decide what they can do; owners can do everything. See the **help: members** topic.

## Links
Screens have addresses you can link to: [Chat](#/chat), a database (#/records/<key>), a page or folder (#/pages/<page id>), a file (#/files/<file id>), and each settings tab (#/settings/<tab>).
`,
} satisfies HelpPage;
