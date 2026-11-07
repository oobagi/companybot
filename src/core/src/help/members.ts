import type { HelpPage } from "./index";

export default {
	id: "members",
	title: "Members and roles",
	summary: "Inviting people, roles and their switches, removing or leaving, and who can do what.",
	text: `# Members and roles
People are in [Members](#/settings/members); what each role can do is in [Roles](#/settings/roles).

## Inviting
People whose role can invite press **Invite people** at the top of Members, enter an email, pick one or more roles (Member to start) and press Invite. The person gets an email with the app link and joins when they sign in with **that email**. Pending invites can be resent or cancelled from their row's ⋯ menu; so can removing someone. Sign-in is an emailed code.

## Roles
Each workspace has its own roles, listed in [Roles](#/settings/roles); open one to see and change its switches. A person can hold several and can do anything **any** of their roles allows.
- **Owner**: can do everything, always. It can't be changed or deleted, and every workspace keeps at least one owner. Only owners give or take Owner.
- **Member**: what new people get. Owners can change its switches; anything they leave alone follows the default below, including switches added in later updates.
- **Public**: anyone outside the workspace who reaches an agent, by email or text. It applies by itself: nobody holds it, nobody signs in with it, and it can't be deleted. Owners choose what agents may do for them (reply without staff checking each message, take a message for staff, hand the conversation to staff), and share pages and databases with Public in their Who can access lists (View, or Add in a database) like any role. Staff powers, like Edit anywhere, chat, money and settings, can never be given to Public. See **help: permissions** and **help: inbox**.
- **Your own roles**: owners can add more with **New role** (like Office or Crew), and rename or delete them from the role's page. Deleting one takes it from everyone; anyone left without a role keeps only shared reads, chat and personal items until an owner assigns a role. A pending invite left without a role joins as Member. The confirmation counts people and pending invites.

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
| Make and change team skills | no |
| Make and change team automations | no |
| Change team memories | yes |
| Add and change records | yes |
| Write and change pages | yes |
| Add and change databases and fields | no |
| See Inbox and reply to customers | yes |
| Make and change channels | yes |
| Stop agents working for someone else | no |
| Delete things forever from Archive | no |
| See the whole workspace's AI usage | no |

Everyone can read what's shared with them, chat, and keep personal memories, personal skills and personal automations. Only owners edit the roles themselves, or reset or delete the workspace. Agents work as the person they help: if that person's roles can't do something, the agent says which roles can.

## Changing roles, removing, leaving
Click the roles beside a name to change them, or press Remove; it takes effect at once. People who aren't owners can give or take only Member and roles they have themselves, and can't change their own roles. The same goes for removing someone or cancelling an invite: they can only if they could take every role it has. To leave, open the workspace logo's menu (top of the rail) → Leave. The last owner can't leave. Removed or leaving people lose their personal memories and automations only they could see; what they said in chats stays.

## Switching and joining
A person can be in many workspaces. Use the workspace logo at the top of the rail: pick one in its menu to switch (or press ⌃⌘1–9; Ctrl+Shift+1–9 on Windows and Linux), answer invites there, or pick New workspace to start your own.
`,
} satisfies HelpPage;
