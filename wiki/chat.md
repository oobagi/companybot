# Chat

Channels, DMs (people and agents), threads, and reactions. One model for all of them. Tables: `chats`, `chatMembers`, `chatMessages`, `reactions`, `agentTurns`, `agentSessions` (`backend/convex/schema.ts`).

## Kinds
- **Channel** — named (`#sales`), public or private. Public: any member can read, and posting joins you. Private: members only; members add others. Every workspace has `#general` (`isDefault`): everyone is in it, it can't be left or made private.
- **DM** — a fixed set of participants, found by `dmKey`. Person ↔ person, a group of people, or person ↔ agent (an **agent DM**). Each active agent shows in the sidebar as a DM even before the first message.
- **Thread** — replies under a message (`threadId` = parent). The parent keeps `replyCount` and `lastReplyAt`. Threads are one level deep.
- **Reaction** — one emoji from one person or agent on one message. Toggling again removes it.

## When agents reply
- **Agent DM** (one person + one agent): every message the person sends, including automation runs posted as them.
- **Everywhere else:** only when @mentioned. Mentioning an agent in a channel adds it to the channel's members. In a DM, only agents already in it answer (a DM's participants are fixed).
- The reply goes **where it was mentioned**: the main timeline, or the thread.
- **Agents never trigger agents.** An agent's @mention of another agent is just text.
- **One turn per agent per place** (chat + thread). Extra mentions queue in `agentTurns`; a person's message always posts. A turn stuck `running` over 5 minutes is failed and the queue moves on.

## Whose access
- The agent acts as **the person who triggered it** (`agentTurns.actorId`): their role, connector connections, and what chats they can see. Re-read each call, as before.
- **Personal memories are read only in DMs with exactly one person.** Anywhere with 2+ people, agents read and change team memories only, so one person's private facts never land in a shared chat. They can still save a new personal memory there, always for the person who asked: it was already said in the chat, so nothing leaks, and it lets onboarding in #general build each person's own context.
- Chat tools (`chat.read`, `chat.search`) only see chats the actor can see.

## What an agent is fed each turn
Built for prompt caching: the cache matches an exact prefix, so nothing earlier in the prompt may change between turns. Same pattern as OpenClaw and Hermes Agent.

1. **System prompt** — agent instructions + platform guide (+ skills index). Nothing per-chat or per-turn, so it's byte-identical in every chat and caches across all of them. Tools in a fixed order.
2. **A session per agent per place** (`agentSessions`: agent + chat + thread) — append-only. Each past turn replays exactly as sent: the stored user message (`agentTurns.prompt`), then the agent's reply as `assistant`. Never rebuilt from current messages, so edits elsewhere can't break the cache.
3. **One new user message per turn**, appended at the end:
   - Where you are: chat, who's in it, who triggered you, memory mode.
   - Everything said in the place since the agent's last reply, including messages not addressed to it, each labeled `[Name time]` with its text as a JSON string. Names and topics lose brackets and line breaks, and the asker's lines are marked `(asker)`, so no message (or look-alike name) can fake a line from someone else: Anthropic's advice for untrusted text. The guide tells the agent only the asker can direct it, and compaction credits a request only to whoever's labeled line made it. A thread's first turn starts with its parent. Capped at ~50 messages; past that, a note says to use `chat.read`.
   - The trigger message, marked as the one to answer. A turn queued by an approval decision gets the outcome (approved + result, failed, or denied) here instead.
4. **Compaction** — once the session passes ~40k tokens, older turns fold into the session's summary and a ~15k-token tail stays verbatim. One cache miss, then append-only again.
5. **Chat tools** — `chat.react` (react to the trigger message), `chat.read` (older history or another place), `chat.search` (search chats the actor can see). Granted like other built-ins (`chat.*`).

Foreign automation runs skip session replay and summaries and see only their trigger or its own thread. Other history must be read through the consent-gated chat tools.

Code: `core/src/turn-input.ts` builds all of it (`systemPrompt`, `buildTurnPrompt`, `buildTurnInput`); change the strategy there. `backend/convex/turns.ts` runs the queue and reads turn context; `chatTools.ts` owns agent chat tools, using the shared channel lookup in `chatOps.ts`; `agent.ts` streams the reply.

Not a skill: chat is the platform, so every agent has it.

## Backend API (`backend/convex/chats.ts`, `messages.ts`)
Queries return display-ready data (names resolved) so the app never joins tables.

**`chats.ts`**
- `list()` → `{ me, channels: ChatItem[], dms: ChatItem[], agents: AgentItem[] }`, or null before you're in a workspace. Only chats you're in; `dms` includes agent DMs. `me` is your user id.
  - `ChatItem`: `{ _id, kind, name, topic, private, isDefault, title, agentId, members: Participant[], unread: boolean, mentioned: boolean, lastMessageAt }`. `title` is `name` for channels, other participants' names for DMs. `agentId` is set for agent DMs, else null.
  - `AgentItem`: `{ _id, name, description, dmId, unread, mentioned, lastMessageAt }` for each active agent. `dmId` is its agent DM with you, or null; the rest come from that DM.
  - `Participant`: `{ type: "user", id: Id<"users">, name } | { type: "agent", id: Id<"agents">, name }`.
  - Unread: the chat's newest main-timeline message is after your `lastReadAt`. `mentioned`: an unread main-timeline message mentions you. Mentions are indexed in `userMentions` (one row per person mentioned in a main-timeline message, removed when the message is deleted), so an old unread mention is found however many messages follow it. The migration that backfilled it runs 20 messages a batch; a message naming over 100 people adds its rows 100 at a time in scheduled follow-ups (`userMentionsFrom`), which `migrations:status` doesn't track.
- `browse()` → public channels you're not in: `{ _id, name, topic, memberCount }[]`.
- `get({ chatId })` → `ChatItem` plus `canManage: boolean`, or null if you can't see it.
- `createChannel({ name, topic?, private })` → chatId. Name normalized to lowercase-dashed; refused if taken.
- `updateChannel({ chatId, name?, topic? })`.
- `join({ chatId })` — public channels. `leave({ chatId })` — any channel you're in, except `#general`.
- `addMembers({ chatId, userIds, agentIds })` — channels only; by its members, or anyone who can manage it.
- `openDm({ userIds, agentIds })` → chatId. Finds or creates. You're always included. The app's New message picks people and agents, so a group DM can include agents (they answer when @mentioned).
- `markRead({ chatId })` — sets your `lastReadAt` to now.
- `alerts()` → `{ workspaceId, chatId, messageId, title, text }[]`: each chat's newest unread message meant for you (DMs, agents' replies once done, @mentions from `userMentions`, the same rows as the sidebar's `mentioned`; main timelines), filtered by your `notify` preference (`all` default, `mentions`, `off`). The app shows a desktop notification for new ones while it isn't in front (`notifications.ts`) and puts the count on the dock badge. Clicking one reopens its workspace if the window has switched since (only if you're still in it), then its chat.
- `place({ chatId, threadId? })` → `{ summary, summarizedUpTo, compacting, costUsd }`, or null. Summaries belong to agent sessions, so only agent DMs have one (`summarizedUpTo` is a turn time); elsewhere summary is null. `costUsd` is the chat's (or thread's) running total.

**`messages.ts`**
- `list({ chatId, threadId? })` → newest 200 of the main timeline (or the thread, parent first), oldest first. Each `Message`:
  `{ _id, _creationTime, chatId, threadId, author: Participant, text, parts, fullParts, status, error, stats, editedAt, deleted, mine: boolean, replyCount, lastReplyAt, replyAuthors: Participant[] (up to 3), automation: { id, name } | null, reactions: { emoji, count, mine, names: string[] }[] }`.
- `parts` includes approval cards; `fullParts` is the same array, retained for alpha.6 apps.
- `send({ chatId, threadId?, text, mentions: { userIds, agentIds, recordIds? } })` → messageId. The app sends mention ids picked from autocomplete; the server drops ids outside the workspace and agents in Trash. `recordIds` are records the message references ([Data](data.md)). Schedules agent turns, and starts automations watching the channel (`message.posted`, top-level channel messages only).
- `edit({ messageId, text })`, `remove({ messageId })` — your own messages. Removing keeps the row (threads hang off it) and clears text, parts, and reactions.
- `react({ messageId, emoji })` — toggles your reaction.

**`typing.ts`**
- `ping({ chatId, threadId? })` — you're typing there. The app sends it on keystrokes, at most every 4s (`TYPING_PING_MS`, core `typing.ts`). Ignored in agent DMs (nobody else would see it) and for a thread that isn't one.
- `list({ chatId, threadId? })` → `{ people: (Participant & { at })[], agents: Participant[] }`, at most 10 each. People who pinged in the last 6s (`TYPING_MS`), you left out. A query doesn't re-run as time passes, so the app also expires each ping 6s after it saw it (its own clock, so a computer with the wrong time still works). `agents`: turns running there (index `agentTurns.by_chat`), minus ones stuck past `STALE_TURN_MS`. No extra writes for them.
- One `typing` row per person per place, overwritten by each ping, so one person can't grow the table. Sending a message deletes yours; an hourly cron deletes the rest (typed, never sent). Like Discord, there's no "stopped typing": a ping runs out.

## In the app
Under every composer, one line says who's typing there ("Ada and Companybot are typing…"). Its space is always kept, so the box doesn't jump. A thread has its own line. The line (`TypingLine`) is its own component, so its timer doesn't re-render the messages.

Click a name or avatar for a profile card (`views/chat/Profile.tsx`, from `workspace.team` and `chats.list`): name, email, role, local time, Message.

## Permissions
`channels.create` (owner, member), `channels.manage` (owner: rename, set topic, delete, remove members, add members to any channel; members can manage channels they created).

Agent delivery and management: `chat.manage` finds the directory (people, agents, or owner-visible invites), lists joined chats, opens fixed-participant DMs and sends to a chat id/#channel and optional thread. `channels.manage` browses public channels, pages participants, creates/renames/sets topic, adds/removes participants, joins/leaves. Shared operations serve the app and tools; `chats.removeMember` allows managers only and protects people in #general. Delivery stores `authorAgentId` and `actingFor`, displayed as “Companybot, for Dana”; it never queues turns or fires automation events. `chat.read` and `chat.search` also accept chat ids for DMs. Deleting a channel moves it to [Trash](data.md#trash), with its messages and members; #general stays. Agents ask first to delete a channel.
