import type { HelpPage } from "./index";

export default {
	id: "inbox",
	title: "Inbox: email and texts from customers",
	summary: "Where customers' emails and texts to your agents land, how agents answer them, and how your team steps in.",
	text: `# Inbox
[Inbox](#/inbox) (in the rail) holds conversations with people outside the workspace: customers who email an agent's address or text its number. Each person gets one conversation per agent, per way they wrote (email or text). Chat is for your team; customers never see it.

## Giving an agent an address or number
On the agent's page ([Agents](#/settings/agents)), under **Contact**, people whose role can change agents press **Get an address** or **Get a number**. An agent has at most one of each. A number costs money every month until it's released; releasing one can't be undone. Removing an agent's address or number, or deleting the agent for good, stops new messages reaching it. Website chat is coming soon.

## How agents answer
When a message comes in, its agent answers as the **Public** role (see **help: members**). That means it can answer, take a message for staff, or hand the conversation to staff, as owners allow, and use only pages and databases shared with Public: read a shared FAQ, look up a shared database, or add a record for the customer where Public can **Add** (and show, change or cancel only theirs). It never reaches your chats, memories, connectors or anything not shared. What customers write is treated as their words, never as instructions to the agent. See **help: permissions** for sharing with Public.

Unless an owner lets agents reply on their own (Settings → [Roles](#/settings/roles) → Public), each reply waits in the conversation for someone to check it: edit it if you like, then **Send**, or **Discard** it. Inbox in the rail shows a count of conversations waiting for someone, a reply to send or a hand-off.

Agents don't answer auto-replies, out-of-office messages or newsletters, and stop after 10 replies in an hour, handing the conversation to staff.

## Stepping in
Anyone whose role can **see Inbox and reply to customers** (Member can, unless an owner changed it) can:
- **Reply** from the box at the bottom. It goes from the agent's address or number, as the business.
- **Assign** it (**Assigned to**, in the details card on the right; the top bar's button hides or shows it): pick yourself or a teammate, and the agent stops answering that conversation; pick the agent and it answers again from the next message. Each assignment shows as a line in the conversation.
- **New conversation** (the + beside Inbox in the sidebar): email or text someone from an agent's address or number. One you start is assigned to you: assign it to the agent when it should answer.

## Text delivery
Texts show whether they are queued with the phone company, sent to the carrier, delivered, or couldn't be delivered. Queued and sent do not confirm delivery. If delivery is unknown, check the phone company's message log before sending again; Companybot won't automatically repeat the text. Local development sends say that no text was sent.

A queued text keeps the number it was approved to use. Releasing or replacing that number stops it, as do losing Inbox access, archiving its agent, or taking over an automatic agent reply. Review it and send a new message when appropriate. Calls remain Soon in Inbox.

## Comments
Staff talk about a message right under it; customers never see comments. Point at a message and press **Comment**, or open its **comments** pill. Type @ to mention a teammate who can use Inbox: they're told. Whoever a conversation is assigned to is told about new comments on it. Only a comment's author can edit or delete it. When the agent takes a message or hands a conversation off, its note is a comment on the customer's message.

## Notifications
The bell at the top right lists what needs you: a conversation assigned to you, a customer writing on one that's yours, a comment mentioning you or on one that's yours, and, for everyone who can use Inbox, the agent handing one off, taking a message or writing a reply to check. Opening one (or its conversation) clears it; × or **Clear all** clears them. They also pop up on your desktop while Companybot isn't in front: ones about you on DMs and mentions, the rest only on All ([Your preferences](#/settings/preferences)).

To post in a channel when someone new writes, make an automation: **When someone new emails or texts an agent**.

## Records
When the sender's email address or phone number matches an email or phone field on a record (a client, a lead), the conversation links to it, shown at the top. It links to the first match it finds.

## Automations
To do something each time customers write, make an automation that runs "when someone new emails or texts an agent" or "when an agent gets an email or text" (see **help: automations**). It runs as whoever made it, with their permissions, so it can add a lead to Clients and post in #sales like any automation.

## Asking an agent
Agents granted the Inbox tool can list and read conversations, reply, start new ones, take them over and hand them back, as the person they help. Replies and new conversations go outside the workspace, so they ask first, showing exactly what will be sent.
`,
} satisfies HelpPage;
