import type { HelpPage } from "./index";

export default {
	id: "members",
	title: "Members and roles",
	summary: "Inviting people, Owner vs Member, removing or leaving, and who can do what.",
	text: `# Members and roles
People and their roles are in [Members](#/settings/members).

## Inviting
Owners enter an email and a role and press Invite. The person gets an email with the app link and joins when they sign in with **that email**. Pending invites can be resent or cancelled. Sign-in is an emailed code.

## Roles
Two roles, per workspace:
- **Owner**: everything below, plus managing the workspace.
- **Member**: uses the workspace.

| Action | Owner | Member |
|---|---|---|
| Read everything shared, chat, make channels | yes | yes |
| Add and edit records, pages, team memories | yes | yes |
| Add fields; make skills and automations | yes | yes |
| Connect your own connector account | yes | yes |
| Change or delete things others made | yes | only your own |
| Invite, remove, change roles | yes | no |
| Create or edit agents, manage connectors | yes | no |
| Workspace name, logo, currency, memory switch | yes | no |
| Create, rename, delete databases | yes | no |
| Action locks, delete forever from Trash | yes | no |
| Delete the workspace | yes | no |

## Changing a role, removing, leaving
Owners change roles with the menu beside a name and remove people with Remove; it takes effect at once. To leave, use the workspace name menu → leave. The last owner can't leave. Removed or leaving people lose their personal memories and automations only they could see; what they said in chats stays.

## Switching and joining
A person can be in many workspaces. Use the rail on the left: click a logo to switch, answer invites there, or press + to start your own.
`,
} satisfies HelpPage;
