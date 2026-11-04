import type { HelpPage } from "./index";

export default {
	id: "overview",
	title: "What Companybot is, and finding your way around",
	summary: "What Companybot is, the screens, and the two kinds of settings.",
	text: `# What Companybot is
Companybot is where a team's chat, business data and AI agents live together. People talk in channels and DMs, keep their clients, deals and tasks in databases, write pages, and ask agents to do the work. **Companybot** is also the name of the main agent every workspace starts with.

A new workspace starts with one channel, #general, and one agent, Companybot. Databases, pages, skills and automations start empty: the team makes what it needs, and Companybot can help.

## Finding your way around
- **Rail** (far left): the parts of the app. [Chat](#/chat), Drive (your pages, #/pages), Databases (#/records) and Customize (agents, connectors, skills, automations). Press G, then C, F, D or X, to jump to one. Chat shows a red count for unread mentions and DMs, or a dot when something is unread. Drag a tab to reorder them.
- **Pins and recents** (in the rail, under the tabs): anything you pin, then what you opened lately. Pin a channel, DM, side chat, page or database with **Pin to rail** in its ⋯ menu in the sidebar, a single record (one client, one job) with **Pin** atop its page, or right-click any of them in the rail; drag pins to reorder. Pins, recents and the rail's order sync with your account, per workspace.
- **Your avatar** (bottom of the rail): [Your preferences](#/settings/preferences) and Sign out.
- **Workspace logo** (top of the rail): the open workspace. Its menu switches to another (⌘1–9 also do), answers invites, starts a new one, and opens Workspace settings or lets you leave. A red count means a mention or DM in another workspace; a dot means something unread there, or an invite.
- **Sidebar**: the open tab's things. For Chat: Channels and Direct messages (click a section title to fold it; drag to reorder). For Drive: pages. For Databases: each database. For Customize: Agents, Connectors, Skills and Automations.
- **Top bar**: where you are, plus that screen's actions.
- **Help button** (top right): What's new and Report a problem.

## What syncs
Your rail tabs, pins, recents, pin order, DM order, Chat section order, folded sections and expanded pages follow your account in each workspace. Your workspace switcher order follows your account across workspaces.

Channel order, page sibling order, database order, database view tab order, and each database's All tab columns and layout are shared with the workspace. People whose role can **rearrange shared sidebar lists** can move these; Member can unless an owner turned it off. Moving a page to another parent works as before.

Sidebar width, hidden state and chat drafts stay on this computer. On first load, existing arrangements from this computer are copied up only where nothing is saved yet, then the local keys are deleted. Recents start fresh; old pins are claimed by whoever signs in first on a shared computer. An import that fails retries next launch while you keep using the app.

## Two kinds of settings
- **Account settings** are yours alone: [Your preferences](#/settings/preferences).
- **Workspace settings** belong to the open workspace: [General](#/settings/general), [Members](#/settings/members), [Permissions](#/settings/permissions), [Memory](#/settings/memory), [Activity](#/settings/activity), [Usage](#/settings/usage), [Archive](#/settings/archive). Agents and what they work with open from Customize in the rail instead: [Agents](#/settings/agents), [Connectors](#/settings/connectors), [Skills](#/settings/skills), [Automations](#/settings/automations).

See the **help: settings** topic for who can change what.

## Roles
Each person holds one or more roles in each workspace, like **Owner** or **Member**. Roles decide what they can do; owners can do everything. See the **help: members** topic.

## Links
Screens have addresses you can link to: [Chat](#/chat), a database (#/records/<key>), a page (#/pages/<page id>), and each settings tab (#/settings/<tab>).
`,
} satisfies HelpPage;
