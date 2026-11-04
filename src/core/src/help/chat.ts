import type { HelpPage } from "./index";

export default {
	id: "chat",
	title: "Chat: channels, DMs, threads, reactions, mentions",
	summary: "Talking with people and agents, and when an agent replies.",
	text: `# Chat
Open [Chat](#/chat) from the sidebar.

## Where people talk
- **Channels** (#sales): public or private. Anyone can read a public one, and posting joins you. Private ones are for their members, who can add others. **#general** is for everyone and can't be left or made private. Make one with the + beside Channels; browse public ones to join.
- **DMs**: a fixed set of people, or a person and an agent. Every active agent is in your sidebar as a DM. Start a group DM with New message. To tidy your sidebar, pick **Close conversation** in a DM's ⋯ menu: it's hidden for you only, the messages stay, and it comes back with the next message there, or when you open it again from New message. A DM with an agent stays, since it's how you reach that agent.
- **Threads**: reply under a message to keep a side conversation together. Threads go one level deep.
- **Reactions**: pick an emoji on a message; click it again to remove it. Hover a reaction to see who added it; for everyone, open the message's ⋯ menu → Reactions.
- You can edit or delete your own messages. Click a name or avatar for their profile card (roles, local time, Message).

## The message box
- **@** picks a person or agent, **#** a channel, **/** a skill. Each becomes a chip. Enter sends (or ⌘Enter, your choice in [Your preferences](#/settings/preferences)); Shift+Enter makes a new line.
- **Emoji**: the smiley button opens the picker (search, categories, skin tone, recents). Or type a colon and two letters, like \`:smi\`, to pick from a list, and a finished \`:smile:\` turns into 😄.
- **Files**: the paperclip, pasting or dropping files on the chat attaches up to 10 per message, 20 MB each: pictures, PDF, Word, Excel and text files. Send waits until they've uploaded. Agents see attached pictures when their model can.
- **Dictation**: click the mic, talk, click again; the words land where your cursor is. It stops by itself after 2 minutes. Nothing is kept, and it counts in Usage (**help: usage**).
- **Drafts**: what you've typed and not sent stays in each chat and thread when you leave and comes back when you return. Drafts are kept on this computer, separately for each account: someone else signing in here doesn't see yours, and they're back when you sign in again. The sidebar shows "Draft" on a chat that has one, or files waiting to send.
- A line under the box shows who is typing, and what each agent working there is doing right now ("Companybot: Searching records for Acme…"), until it's done. With several working it says "2 agents working": hover it for each one's step, and a link to [Activity](#/settings/activity) for what they did. It shows only what the agent is doing, never its reasoning, and nothing about it posts in the chat.
- **Stop** on that line ends an agent's reply early (with several working, hover "2 agents working" for each one's Stop). It stops within about a second: if it's in the middle of an action (searching, saving a record), that action finishes first, and nothing after it runs. What it already wrote stays, marked "Stopped by" you, and nothing it already did is undone. You can stop a reply the agent is writing for you; people whose role can stop agents working for someone else can stop anyone's. Typing "stop" in the chat isn't the Stop button: it's a message the agent reads, and it decides to stop (see below).
- **Link previews**: the first three links in a message get a small card with the page's title, text and picture (not for links in code). Click one to open the page in your browser. On your own message, hover a card and click × to hide it; the link stays.

## When agents reply
- **In a DM with an agent**, it answers every message. It waits a moment after you stop sending, so several quick messages in a row get one reply that covers them all.
- **Changing your mind while it works**: any message you send while an agent is replying to you reaches that reply, as long as it's in the same chat or thread: no @mention needed. Your message comes first: the agent reads it before its next step, says briefly that it's switching ("On it, switching to…"), then carries on with what you want now, or stops if that's what you said. If it was already writing its answer, it starts that answer over with your message in it. You get one reply covering everything. "Stop", "never mind" or "actually, make it shorter" are just messages it reads; there are no magic words. That includes an agent that chimed in on its own in a "When relevant" channel: your "never mind" reaches it, and it may then post nothing. Only the person it's working for redirects it: another person's message waits for its own reply. Reminders and automations aren't redirected: your message gets its own reply after.
- **Everywhere else**, only when you @mention it. Mentioning an agent in a channel adds it there. It replies where you mentioned it: in the channel, or in the thread.
- **Channels set to "When relevant"** let agents in them chime in without an @mention. A small AI call (the dispatcher) looks at each message a moment after people stop typing, so a burst of messages gets one, and passes it to any agent it could be for (a question in its line of work, a question to the room, a follow-up to what it said); a "thanks!" to an agent gets a reaction. The agent then reads the conversation itself and decides, before writing anything, what it would add that nobody has said; it posts only if that's something: if someone already answered, you asked for someone else ("anyone else?"), or it's people talking to each other, it stays quiet. When a message goes to two agents, the second sees what the first said and builds on it or answers it, in a line or two. Asked directly (an @mention, its DM), an agent always answers. Under such a reply, its details line shows the dispatcher's pick ("Dispatcher (Jev) · 84% reply") and what that call cost; Usage counts those calls as "Reply decisions" (**help: usage**). People who can change workspace settings pick the model that makes it in Settings → General (Jev, a fast decision model, by default). Every channel starts as "When relevant"; set one to "Mentions only" to keep agents out unless @mentioned. Anyone whose role can make and change channels changes it in the channel's details (click its name). @mentions work the same either way.
- **Agents work together.** When an agent @mentions another, that one takes the work on, in a thread, for the same person. In a "When relevant" channel, an agent that wasn't asked directly can talk to another by name ("Quill, want to take the verse?"): that one answers next, in a thread. When an agent's message is for nobody in particular, the same quick call picks who goes next (another agent, or nobody); that agent posts only if it adds something, so a result handed back isn't repeated or confirmed. A few turns between agents at most, then they wait for you. An agent can also ask another privately, out of the chat: the reply shows a chip like "Scout asked Quill →" that opens the question and answer beside the chat, read-only. To step in, reply in the chat.
- **Agents stop themselves.** If they go back and forth too much (2 round trips between the same two, 10 turns, or 4 messages in a row with nobody replying), a line says "Agents paused…". The person they work for clicks **Continue** or **Stop**. Writing in the thread gives them a fresh start too. Reminders and automations never set agents on each other.
- An agent acts as **the person who asked**: it can see only what they can see and do only what they may do. Things that leave Companybot ask first: see **help: permissions**.
- Each agent answers one thing at a time per place; extra mentions wait their turn.
- In a chat with several people, agents use team memories only, never anyone's personal ones: see **help: memory**.

## Private agent replies
An agent can use a database, page or channel that you can open but others in the chat cannot. Its reply says **🔒 Only Office and Owners can see this**. Hover the lock for why, like **Uses the Deals database**. Anyone missing one of its sources sees only **🔒 Replied to Dana. Only Office and Owners can see this.** Its files, tool cards, approvals and Activity stay hidden too.

Access is checked when you read: gaining a role later reveals earlier replies. Agents answering someone without access leave those replies out of their context. The same rule applies in channels, group DMs and side chats; a primary DM with one person looks as usual.

Anyone who can see a finished private reply can choose **Share to channel**. It asks **Not everyone in #general can see Deals. Share anyway?** Confirming shows the reply to the chat and labels it **Shared by Dana**. It also shares the turn's tool cards; personal connector results still show only to the person the agent acted for.

## Notifications
You get a desktop notification and a dock count for DMs and @mentions while the app isn't in front. Change it in [Your preferences](#/settings/preferences).

## Who can do what
People whose role can make and change channels (Member, to start) create, rename and delete them; making a channel gives no extra rights over it. A channel's details also have **Who can access**: Everyone, or chosen roles, at View or Post. Make a read-only channel with Everyone at View and the roles that announce at Post: everyone else reads it but can't post or react. People not on the list don't see it at all. #general always stays open to everyone, at least to read. See **help: permissions**. A deleted channel goes to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
