import type { HelpPage } from "./index";

export default {
	id: "overview",
	title: "What Companybot is, and finding your way around",
	summary: "What Companybot is, the screens, and the two kinds of settings.",
	text: `# What Companybot is
Companybot is where a team's chat, business data and AI agents live together. People talk in channels and DMs, keep their clients, deals and tasks in databases, write pages, and ask agents to do the work. **Companybot** is also the name of the main agent every workspace starts with.

A new workspace starts with one channel, #general, and one agent, Companybot. Databases, pages, skills and automations start empty: the team makes what it needs, and Companybot can help.

## Finding your way around
- **Workspace rail** (far left): one logo per workspace. Click to switch (⌘1–9), + to start another, and answer invites. A dot means something unread; a red count means a mention or DM.
- **Your avatar** (bottom of the rail): [Your preferences](#/settings/preferences) and Sign out.
- **Sidebar**: Databases, Pages, Channels and Direct messages. Click a section title to fold it; drag to reorder. The workspace name above it opens Workspace settings or lets you leave.
- **Top bar**: where you are, plus that screen's actions.
- **Help button** (top right): What's new and Report a problem.

## Two kinds of settings
- **Account settings** are yours alone: [Your preferences](#/settings/preferences).
- **Workspace settings** belong to the open workspace: [General](#/settings/general), [Members](#/settings/members), [Permissions](#/settings/permissions), [Memory](#/settings/memory), [Activity](#/settings/activity), [Trash](#/settings/trash), and Customize: [Agents](#/settings/agents), [Connectors](#/settings/connectors), [Skills](#/settings/skills), [Automations](#/settings/automations).

See the **help: settings** topic for who can change what.

## Roles
Each person is an **Owner** or a **Member** in each workspace. Owners manage the workspace; members use it. See the **help: members** topic.

## Links
Screens have addresses you can link to: [Chat](#/chat), a database (#/records/<key>), a page (#/pages/<page id>), and each settings tab (#/settings/<tab>).
`,
} satisfies HelpPage;
