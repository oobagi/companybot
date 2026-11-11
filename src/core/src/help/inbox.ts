import type { HelpPage } from "./index";

export default {
	id: "inbox",
	title: "Inbox: email and texts from customers",
	summary: "Where customers' emails and texts to your business land, how agents answer them, and how your team steps in.",
	text: `# Inbox
[Inbox](#/inbox) (in the rail) holds conversations with people outside the workspace: customers who email one of the workspace's addresses or text one of its numbers. Each person gets one conversation per address or number they wrote to. Chat is for your team; customers never see it.

## Addresses and numbers
They're the business's, in Settings → [Email and phone](#/settings/addresses). People whose role can **add email addresses and phone numbers** (owners, unless an owner gives it to another role) press **Add an address** or **Add a number**, and pick **Who answers** each: an agent, or **Your team** (no agent replies). Changing it changes who answers new conversations; ones already going keep who has them. A number costs money every month until it's released; releasing one can't be undone. Removing an address stops new messages reaching it, and its conversations stay in Inbox but can't be answered: the box says why. Deleting an agent for good leaves its addresses to your team. Website chat is coming soon.

Every reply goes out from the address or number the customer wrote to. An email carries the name of whoever wrote it, like "Maya from Acme" (or the agent's name, for its replies). A text can't carry a name, but Inbox shows your team who sent each one.

## How agents answer
When a message comes in to an address an agent answers, the agent answers as the **Public** role (see **help: members**). That means it can answer, take a message for staff, or hand the conversation to staff, as owners allow, and use only pages and databases shared with Public: read a shared FAQ, look up a shared database, or add a record for the customer where Public can **Add** (and show, change or cancel only theirs). It never reaches your chats, memories, connectors or anything not shared. What customers write is treated as their words, never as instructions to the agent. See **help: permissions** for sharing with Public.

Unless an owner lets agents reply on their own (Settings → [Roles](#/settings/roles) → Public), each reply waits in the conversation for someone to check it: edit it if you like, then **Send**, or **Discard** it. Inbox in the rail shows a count of conversations waiting for someone, a reply to send or a hand-off.

Agents don't answer auto-replies, out-of-office messages or newsletters, and stop after 10 replies in an hour, handing the conversation to staff.

## Stepping in
Anyone whose role can **see Inbox and reply to customers** (Member can, unless an owner changed it) can:
- **Reply** from the box at the bottom. It goes from the conversation's address or number, under your name.
- **Assign** it (**Assigned to**, in the details card on the right; the top bar's button hides or shows it): pick yourself or a teammate, and agents stop answering that conversation; pick an agent and it answers from the next message. Each assignment shows as a line in the conversation.
- **New conversation** (the + beside Inbox in the sidebar): email or text someone from one of the workspace's addresses or numbers (**From**). One you start is assigned to you: assign it to an agent when one should answer.
- **Move to** (right-click a conversation, or its ⋯): put it in one of the sidebar's sections, or a new one, so it's a click away. Sections are the whole team's, like Chat's.

## Comments
Staff talk about a message right under it; customers never see comments. Point at a message and press **Comment**, or open its **comments** pill. Type @ to mention a teammate who can use Inbox: they're told. Whoever a conversation is assigned to is told about new comments on it. Only a comment's author can edit or delete it. When the agent takes a message or hands a conversation off, its note is a comment on the customer's message.

## Notifications
The bell at the top right lists what needs you: a conversation assigned to you, a customer writing on one that's yours, a comment mentioning you or on one that's yours, and, for everyone who can use Inbox, the agent handing one off, taking a message or writing a reply to check. Opening one (or its conversation) clears it; × or **Clear all** clears them. They also pop up on your desktop while Companybot isn't in front: ones about you on DMs and mentions, the rest only on All ([Your preferences](#/settings/preferences)).

To post in a channel when someone new writes, make an automation: **When someone new emails or texts you**.

## Records
Pick your **customers database** (say, Clients) in [Email and phone](#/settings/addresses) → Customer records. Each conversation then links to the record there whose email or phone field matches the sender, shown beside the conversation. Turn on **Add new people to it** and someone who isn't there yet gets a record when they first write (their name and address). With no database picked, conversations aren't linked. Changing it relinks every conversation. Its fields can be filled by AI from the conversation (a field's **Fill with AI**, see **help: databases**); what AI suggests shows when you click the customer's name, to Accept or Dismiss.

## Automations
To do something each time customers write, make an automation that runs "when someone new emails or texts you" or "when an email or text comes in" (see **help: automations**). It runs as whoever made it, with their permissions, so it can add a lead to Clients and post in #sales like any automation.

## Asking an agent
Agents granted the Inbox tool can list and read conversations, reply, start new ones, take them over and hand them back, as the person they help. Replies and new conversations go outside the workspace, so they ask first, showing exactly what will be sent. With a person whose role can add addresses and numbers, they can also add, remove and pick who answers them, always asking first.
`,
} satisfies HelpPage;
