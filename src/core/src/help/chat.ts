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
- **Emoji**: the smiley button opens the picker (search, categories, skin tone, recents). Or type a colon and two letters, like \`:smi\`, to pick from a list, and a finished \`:smile:\` turns into 😄.
- **Files**: the paperclip, pasting or dropping files on the chat attaches up to 10 per message, 20 MB each: pictures, PDF, Word, Excel and text files. Send waits until they've uploaded. Agents see attached pictures when their model can.
- **Dictation**: click the mic, talk, click again; the words land where your cursor is. It stops by itself after 2 minutes. Nothing is kept, and it counts in Usage (**help: usage**).
- **Drafts**: what you've typed and not sent stays in each chat and thread when you leave and comes back when you return. Drafts are kept on this computer, separately for each account: someone else signing in here doesn't see yours, and they're back when you sign in again. The sidebar shows "Draft" on a chat that has one, or files waiting to send.
- A line under the box shows who is typing, and what each agent working there is doing right now ("Companybot: Searching records for Acme…"), until it's done. With several working it says "2 agents working": hover it for each one's step, and a link to [Activity](#/settings/activity) for what they did. It shows only what the agent is doing, never its reasoning, and nothing about it posts in the chat.
- **Link previews**: the first three links in a message get a small card with the page's title, text and picture (not for links in code). Click one to open the page in your browser. On your own message, hover a card and click × to hide it; the link stays.

## When agents reply
- **In a DM with an agent**, it answers every message.
- **Everywhere else**, only when you @mention it. Mentioning an agent in a channel adds it there. It replies where you mentioned it: in the channel, or in the thread.
- **Channels set to "When relevant"** let agents in them chime in without an @mention. A small AI call (the dispatcher) looks at each message a moment after people stop typing, so a burst of messages gets one, and passes it to any agent it could be for (a question in its line of work, a question to the room, a follow-up to what it said); a "thanks!" to an agent gets a reaction. The agent then reads the conversation itself and decides, before writing anything, what it would add that nobody has said; it posts only if that's something: if someone already answered, you asked for someone else ("anyone else?"), or it's people talking to each other, it stays quiet. When a message goes to two agents, the second sees what the first said and builds on it or answers it, in a line or two. Asked directly (an @mention, its DM), an agent always answers. Under such a reply, its details line shows the dispatcher's pick ("Dispatcher (Jev) · 84% reply") and what that call cost; Usage counts those calls as "Reply decisions" (**help: usage**). Owners pick the model that makes it in Settings → General (Jev, a fast decision model, by default). Every channel starts as "When relevant"; set one to "Mentions only" to keep agents out unless @mentioned. The channel's creator or an owner changes it in the channel's details (click its name). @mentions work the same either way.
- **Agents work together.** When an agent @mentions another, that one takes the work on, in a thread, for the same person. In a "When relevant" channel, an agent that wasn't asked directly can talk to another by name ("Quill, want to take the verse?"): that one answers next, in a thread. When an agent's message is for nobody in particular, the same quick call picks who goes next (another agent, or nobody); that agent posts only if it adds something, so a result handed back isn't repeated or confirmed. A few turns between agents at most, then they wait for you. An agent can also ask another privately: that happens in a thread of a group DM with you and both agents, which only you see; the reply shows a chip like "Scout asked Quill →" that opens it.
- **Agents stop themselves.** If they go back and forth too much (2 round trips between the same two, 10 turns, or 4 messages in a row with nobody replying), a line says "Agents paused…". The person they work for clicks **Continue** or **Stop**. Writing in the thread gives them a fresh start too. Reminders and automations never set agents on each other.
- An agent acts as **the person who asked**: it can see only what they can see and do only what they may do. Things that leave Companybot ask first: see **help: permissions**.
- Each agent answers one thing at a time per place; extra mentions wait their turn.
- In a chat with several people, agents use team memories only, never anyone's personal ones: see **help: memory**.

## Notifications
You get a desktop notification and a dock count for DMs and @mentions while the app isn't in front. Change it in [Your preferences](#/settings/preferences).

## Who can do what
Owners and members can create channels and rename or delete their own. Owners can manage any channel. A deleted channel goes to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
