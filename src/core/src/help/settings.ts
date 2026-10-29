import type { HelpPage } from "./index";

export default {
	id: "settings",
	title: "Settings: every tab and who can change it",
	summary: "Where each setting lives, account and workspace, and who can change it.",
	text: `# Settings
Open settings from your avatar (account) or the workspace name above the sidebar (workspace). Each tab has its own address, #/settings/<tab>.

## Account settings (only you)
| Tab | What | Topic |
|---|---|---|
| [Your preferences](#/settings/preferences) | Photo, name, time zone, send key, notifications, app updates, delete account | **help: account-settings** |

## Workspace settings
| Tab | What | Who can change |
|---|---|---|
| [General](#/settings/general) | Logo, name, currency, memory on/off, delete workspace | Owners (everyone can look) |
| [Members](#/settings/members) | Invite, roles, remove | Owners |
| [Permissions](#/settings/permissions) | Your Always/Never rules; action locks | You (rules); owners (locks) |
| [Memory](#/settings/memory) | Team and personal memories | Everyone (personal: only you) |
| [Activity](#/settings/activity) | Database changes and agent activity | Read only |
| [Trash](#/settings/trash) | Deleted things; restore | Anyone restores what they could delete; owners delete forever |
| [Agents](#/settings/agents) | Agents, models, tools, instructions | Owners |
| [Connectors](#/settings/connectors) | Outside services | Owners install; everyone connects their own |
| [Skills](#/settings/skills) | Shared instructions | Anyone makes; maker or owner edits |
| [Automations](#/settings/automations) | Jobs on a schedule or event | Anyone makes; maker or owner edits |

Shared settings (agents, workspace name and the like) are edited then saved. If someone saved first, you are asked whether to use theirs or keep yours.

Topics: **help: general**, **help: account-settings**, **help: members**, **help: permissions**, **help: memory**, **help: activity**, **help: trash**, **help: agents**, **help: connectors**, **help: skills**, **help: automations**.
`,
} satisfies HelpPage;
