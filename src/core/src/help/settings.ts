import type { HelpPage } from "./index";

export default {
	id: "settings",
	title: "Settings: every tab and who can change it",
	summary: "Where each setting lives, account and workspace, and who can change it.",
	text: `# Settings
Open settings from your avatar (account) or the workspace logo at the top of the rail (workspace). Agents, Connectors, Skills and Automations keep settings addresses but open from Customize in the rail. Each tab has its own address, #/settings/<tab>.

## Account settings (only you)
| Tab | What | Topic |
|---|---|---|
| [Your preferences](#/settings/preferences) | Photo, name, time zone, send key, notifications, app updates, delete account | **help: account-settings** |

## Workspace settings
| Tab | What | Who can change |
|---|---|---|
| [General](#/settings/general) | Logo, name, currency, memory on/off, picture model and monthly image budget, reset or delete workspace | Roles that can change workspace settings (everyone can look); owners reset or delete it |
| [Members](#/settings/members) | Invite, give people roles, remove | Roles that can invite and change people's roles |
| [Roles](#/settings/roles) | What each role can do; new roles | Everyone can look; owners change them |
| [Permissions](#/settings/permissions) | Your Always/Never rules; action locks | You (rules); roles that can lock (locks) |
| [Memory](#/settings/memory) | Team and personal memories | Everyone (personal: only you) |
| [Channels](#/settings/channels) | Text, phone, email, Slack and website chat for agents. All coming soon | Nobody yet |
| [Activity](#/settings/activity) | Database changes and agent activity | Read only |
| [Usage](#/settings/usage) | What AI cost, by month | Read only (roles that can see everyone do; others their own) |
| [Archive](#/settings/archive) | Deleted things; restore | Anyone restores what they could delete; roles that can delete forever do |
| [Agents](#/settings/agents) | Agents, models, tools, instructions | Roles that can change agents |
| [Connectors](#/settings/connectors) | Outside services | Roles that can install connectors; everyone allowed connects their own |
| [Skills](#/settings/skills) | Personal or team instructions | Everyone for Just me; roles that can make and change team skills do the rest |
| [Automations](#/settings/automations) | Jobs on a schedule or event | Anyone makes personal ones; roles that can make and change team automations do the rest |

Shared settings (agents, workspace name and the like) are edited then saved. Unsaved edits stay when you leave a screen and come back, until you quit, sign out, save or discard them. Closing a database dialog cancels its edits. If someone saved first, you are asked whether to use theirs or keep yours.

Topics: **help: general**, **help: account-settings**, **help: members**, **help: permissions**, **help: memory**, **help: activity**, **help: trash**, **help: agents**, **help: connectors**, **help: skills**, **help: automations**.
`,
} satisfies HelpPage;
