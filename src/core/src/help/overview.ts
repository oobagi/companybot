import type { HelpPage } from "./index";

export default {
	id: "overview",
	title: "What Companybot is, and finding your way around",
	summary: "What Companybot is, the screens, and the two kinds of settings.",
	text: `# What Companybot is
Companybot is where a team's chat, business data and AI agents live together. People talk in channels and DMs, keep their clients, deals and tasks in databases, write pages, and ask agents to do the work. **Companybot** is also the name of the main agent every workspace starts with.

A new workspace starts with one channel, #general, and one agent, Companybot. Databases, pages, skills and automations start empty: the team makes what it needs, and Companybot can help.

## Finding your way around
- **Rail** (far left): the parts of the app. [Chat](#/chat), Drive (your pages, #/pages), Databases (#/records), [Agents](#/settings/agents) and Customize (connectors, skills, automations). Press G, then C, F, D, A or X, to jump to one. Chat shows a red count for unread mentions and DMs, or a dot when something is unread.
- **Your avatar** (bottom of the rail): [Your preferences](#/settings/preferences) and Sign out.
- **Workspace switcher** (title bar, next to Back and Forward): the open workspace. Its menu switches to another (⌘1–9 also do), answers invites, starts a new one, and opens Workspace settings or lets you leave. A red count means a mention or DM in another workspace; a dot means something unread there, or an invite.
- **Sidebar**: the open tab's things. For Chat: Channels and Direct messages (click a section title to fold it; drag to reorder). For Drive: pages. For Databases: each database. For Agents: each agent. For Customize: Connectors, Skills and Automations.
- **Top bar**: where you are, plus that screen's actions.
- **Help button** (top right): What's new and Report a problem.

## Two kinds of settings
- **Account settings** are yours alone: [Your preferences](#/settings/preferences).
- **Workspace settings** belong to the open workspace: [General](#/settings/general), [Members](#/settings/members), [Permissions](#/settings/permissions), [Memory](#/settings/memory), [Activity](#/settings/activity), [Usage](#/settings/usage), [Archive](#/settings/archive). Agents and what they work with open from the rail instead: [Agents](#/settings/agents), and under Customize [Connectors](#/settings/connectors), [Skills](#/settings/skills), [Automations](#/settings/automations).

See the **help: settings** topic for who can change what.

## Roles
Each person is an **Owner** or a **Member** in each workspace. Owners manage the workspace; members use it. See the **help: members** topic.

## Links
Screens have addresses you can link to: [Chat](#/chat), a database (#/records/<key>), a page (#/pages/<page id>), and each settings tab (#/settings/<tab>).
`,
} satisfies HelpPage;
