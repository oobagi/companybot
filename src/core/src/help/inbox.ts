import type { HelpPage } from "./index";

export default {
	id: "inbox",
	title: "Inbox: email and texts from customers",
	summary: "Where customers' emails and texts to your agents land, how agents answer them, and how your team steps in.",
	text: `# Inbox
[Inbox](#/inbox) (in the rail) holds conversations with people outside the workspace: customers who email an agent's address or text its number. Each person gets one conversation per agent, per way they wrote (email or text). Chat is for your team; customers never see it.

## Giving an agent an address or number
On the agent's page ([Agents](#/settings/agents)), under **Contact**, people whose role can change agents press **Get an address** or **Get a number**. An agent has at most one of each. A number costs money every month until it's released; releasing one can't be undone. Removing an agent's address or number, or deleting the agent for good, stops new messages reaching it. **New conversations** picks a channel where the agent posts a one-line note ("New conversation from …") when someone new writes; the conversation itself stays in Inbox. Website chat is coming soon.

## How agents answer
When a message comes in, its agent answers as the **Public** role (see **help: members**). That means it can answer, take a message for staff, or hand the conversation to staff, as owners allow, and use only pages and databases shared with Public: read a shared FAQ, look up a shared database, or add a record for the customer where Public can **Add** (and show, change or cancel only theirs). It never reaches your chats, memories, connectors or anything not shared. What customers write is treated as their words, never as instructions to the agent. See **help: permissions** for sharing with Public.

Unless an owner lets agents reply on their own (Settings → [Roles](#/settings/roles) → Public), each reply waits in the conversation for someone to check it: edit it if you like, then **Send**, or **Discard** it. Inbox in the rail shows a count of conversations waiting for someone, a reply to send or a hand-off.

Agents don't answer auto-replies, out-of-office messages or newsletters, and stop after 10 replies in an hour, handing the conversation to staff.

## Stepping in
Anyone whose role can **see Inbox and reply to customers** (Member can, unless an owner changed it) can:
- **Reply** from the box at the bottom. It goes from the agent's address or number, as the business.
- **Take over**: the agent stops answering that conversation, and you answer.
- **Hand back**: the agent answers again from the next message.
- **New conversation** (top bar): email or text someone from an agent's address or number. One you start is yours: hand it back when the agent should answer.

Notes the agent takes for staff show in the conversation in yellow; customers never see them.

## Records
When the sender's email address or phone number matches an email or phone field on a record (a client, a lead), the conversation links to it, shown at the top. It links to the first match it finds.

## Automations
To do something each time customers write, make an automation that runs "when someone new emails or texts an agent" or "when an agent gets an email or text" (see **help: automations**). It runs as whoever made it, with their permissions, so it can add a lead to Clients and post in #sales like any automation.

## Asking an agent
Agents granted the Inbox tool can list and read conversations, reply, start new ones, take them over and hand them back, as the person they help. Replies and new conversations go outside the workspace, so they ask first, showing exactly what will be sent.
`,
} satisfies HelpPage;
