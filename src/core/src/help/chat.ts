import type { HelpPage } from "./index";

export default {
	id: "chat",
	title: "Chat: channels, DMs, threads, reactions, mentions",
	summary: "Talking with people and agents, and when an agent replies.",
	text: `# Chat
Open [Chat](#/chat) from the sidebar.

## Where people talk
- **Channels** (#sales): public or private. Anyone can read a public one, and posting joins you. Private ones are for their members, who can add others. **#general** is for everyone and can't be left or made private. Make one with the + beside Channels; browse public ones to join.
- **DMs**: a fixed set of people, or a person and an agent. Every active agent is in your sidebar as a DM. Start a group DM with New message.
- **Threads**: reply under a message to keep a side conversation together. Threads go one level deep.
- **Reactions**: pick an emoji on a message; click it again to remove it.
- You can edit or delete your own messages. Click a name or avatar for their profile card (role, local time, Message).

## The message box
- **@** picks a person or agent, **#** a channel, **/** a skill. Each becomes a chip. Enter sends (or ⌘Enter, your choice in [Your preferences](#/settings/preferences)); Shift+Enter makes a new line.
- A line under the box shows who is typing.

## When agents reply
- **In a DM with an agent**, it answers every message.
- **Everywhere else**, only when you @mention it. Mentioning an agent in a channel adds it there. It replies where you mentioned it: in the channel, or in the thread.
- **Agents never trigger other agents.** An @mention by an agent is just text.
- An agent acts as **the person who asked**: it can see only what they can see and do only what they may do. Things that leave Companybot ask first: see **help: permissions**.
- Each agent answers one thing at a time per place; extra mentions wait their turn.
- In a chat with several people, agents use team memories only, never anyone's personal ones: see **help: memory**.

## Notifications
You get a desktop notification and a dock count for DMs and @mentions while the app isn't in front. Change it in [Your preferences](#/settings/preferences).

## Who can do what
Owners and members can create channels and rename or delete their own. Owners can manage any channel. A deleted channel goes to [Trash](#/settings/trash).
`,
} satisfies HelpPage;
