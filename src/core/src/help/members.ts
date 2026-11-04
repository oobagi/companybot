import type { HelpPage } from "./index";

export default {
	id: "members",
	title: "Members and roles",
	summary: "Inviting people, roles and their switches, removing or leaving, and who can do what.",
	text: `# Members and roles
People and their roles are in [Members](#/settings/members).

## Inviting
People whose role can invite enter an email, pick one or more roles (Member to start) and press Invite. The person gets an email with the app link and joins when they sign in with **that email**. Pending invites can be resent or cancelled. Sign-in is an emailed code.

## Roles
Each workspace has its own roles, listed under Roles in [Members](#/settings/members). A person can hold several and can do anything **any** of their roles allows.
- **Owner**: can do everything, always. It can't be changed or deleted, and every workspace keeps at least one owner. Only owners give or take Owner.
- **Member**: what new people get. Owners can change its switches; anything they leave alone follows the default below, including switches added in later updates.
- **Your own roles**: owners can add more (like Office or Crew), rename them and delete them. Deleting one takes it from everyone; anyone left without a role keeps only shared reads, chat and personal items until an owner assigns a role.

Each role is a list of switches, each one thing a person may do:

| Switch | Member, unless an owner changed it |
|---|---|
| Change workspace settings (name, logo, currency, memory) | no |
| Rearrange shared sidebar lists (channel, page, database and view order; a database's All tab columns and layout) | yes |
| Invite and remove people and change their roles | no |
| Change agents | no |
| Install connectors and choose who can use them | no |
| Connect their own accounts to connectors | yes |
| Lock agent actions for everyone | no |
| Make and change skills | yes |
| Make and change team automations | yes |
| Change team memories | yes |
| Add and change records | yes |
| Write and change pages | yes |
| Add and change databases and fields | yes |
| Make and change channels | yes |
| Stop agents working for someone else | no |
| Delete things forever from Archive | no |
| See the whole workspace's AI usage | no |

Everyone can read what's shared with them, chat, and keep personal memories and personal automations. Only owners edit the roles themselves, or reset or delete the workspace. Agents work as the person they help: if that person's roles can't do something, the agent says which roles can.

## Changing roles, removing, leaving
Click the roles beside a name to change them, or press Remove; it takes effect at once. To leave, open the workspace logo's menu (top of the rail) → Leave. The last owner can't leave. Removed or leaving people lose their personal memories and automations only they could see; what they said in chats stays.

## Switching and joining
A person can be in many workspaces. Use the workspace logo at the top of the rail: pick one in its menu to switch (or press ⌘1–9), answer invites there, or pick New workspace to start your own.
`,
} satisfies HelpPage;
