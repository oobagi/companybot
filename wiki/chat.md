# Chat

Channels, DMs (people and agents), threads, and reactions. One model for all of them. Tables: `chats`, `chatMembers`, `chatMessages`, `reactions`, `agentTurns` (`backend/convex/schema.ts`).

## Kinds
- **Channel** — named (`#sales`), public or private. Public: any member can read, and posting joins you. Private: members only; members add others. Every workspace has `#general` (`isDefault`): everyone is in it, it can't be left or made private.
- **DM** — a fixed set of participants, found by `dmKey`. Person ↔ person, a group of people, or person ↔ agent (an **agent DM**). Each active agent shows in the sidebar as a DM even before the first message.
- **Thread** — replies under a message (`threadId` = parent). The parent keeps `replyCount` and `lastReplyAt`. Threads are one level deep.
- **Reaction** — one emoji from one person or agent on one message. Toggling again removes it.

## When agents reply
- **Agent DM** (one person + one agent): every message the person sends.
- **Everywhere else:** only when @mentioned. Mentioning an agent in a channel adds it to the channel's members.
- The reply goes **where it was mentioned**: the main timeline, or the thread.
- **Agents never trigger agents.** An agent's @mention of another agent is just text.
- **One turn per agent per place** (chat + thread). Extra mentions queue in `agentTurns`; a person's message always posts. A turn stuck `running` over 5 minutes is failed and the queue moves on.

## Whose access
- The agent acts as **the person who triggered it** (`agentTurns.actorId`): their role, plugin connections, and what chats they can see. Re-read each call, as before.
- **Personal memories only in DMs with exactly one person.** Anywhere with 2+ people, agents read and write team memories only, so one person's private facts never land in a shared chat.
- Chat tools (`chat.read`, `chat.search`) only see chats the actor can see.

## What an agent is fed each turn
1. **System prompt** — agent instructions + platform guide (+ skills index). Stable across turns, so prompt caching hits.
2. **Where you are** — chat kind and name, who's in it, who triggered you, memory mode. Built per turn.
3. **History of the place** — a thread: parent + all replies. A main timeline: recent messages, each thread folded to one line ("3 replies"). Other people's (and agents') messages are `user` messages prefixed `[Name]`; the agent's own are `assistant`. Older messages are folded into the place's `summary` (compaction, same thresholds as before).
4. **Chat tools** — `chat.react` (react to the trigger message), `chat.read` (older history or another place), `chat.search` (search chats the actor can see). Granted like other built-ins (`chat.*`).

Not a skill: chat is the platform, so every agent has it.

## Backend API (`backend/convex/chats.ts`, `messages.ts`)
Queries return display-ready data (names resolved) so the app never joins tables.

**`chats.ts`**
- `list()` → `{ channels: ChatItem[], dms: ChatItem[], agents: AgentItem[] }`. Only chats you're in (plus all public channels you've joined). `agents` are active agents, each with `dmId` (their agent DM with you, or null).
  - `ChatItem`: `{ _id, kind, name, topic, private, isDefault, title, members: Participant[], unread: boolean, mentioned: boolean, lastMessageAt }`. `title` is `name` for channels, other participants' names for DMs.
  - `Participant`: `{ type: "user" | "agent", id, name }`.
- `browse()` → public channels you're not in: `{ _id, name, topic, memberCount }[]`.
- `get({ chatId })` → `ChatItem` plus `canManage: boolean`, or null if you can't see it.
- `createChannel({ name, topic?, private })` → chatId. Name normalized to lowercase-dashed; refused if taken.
- `updateChannel({ chatId, name?, topic? })`.
- `join({ chatId })`, `leave({ chatId })` — public channels; can't leave `#general`.
- `addMembers({ chatId, userIds, agentIds })` — channels only.
- `openDm({ userIds, agentIds })` → chatId. Finds or creates. You're always included.
- `markRead({ chatId })` — sets your `lastReadAt` to now.
- `place({ chatId, threadId? })` → `{ summary, summarizedUpTo, compacting, costUsd }` for the summary divider.

**`messages.ts`**
- `list({ chatId, threadId? })` → newest 200 of the main timeline (or the thread, parent first), oldest first. Each `Message`:
  `{ _id, _creationTime, chatId, threadId, author: Participant, text, parts, status, error, stats, editedAt, deleted, mine: boolean, replyCount, lastReplyAt, replyAuthors: Participant[] (up to 3), reactions: { emoji, count, mine, names: string[] }[] }`.
- `send({ chatId, threadId?, text, mentions: { userIds, agentIds } })` → messageId. The app sends mention ids picked from autocomplete; the server validates them. Schedules agent turns.
- `edit({ messageId, text })`, `remove({ messageId })` — your own messages.
- `react({ messageId, emoji })` — toggles your reaction.

## Permissions
`channels.create` (owner, member), `channels.manage` (owner: rename, archive, add members to any channel; members can manage channels they created).

## Migration
`migrations.conversationsToChats` copies each legacy conversation into an agent DM. Run once per deployment: `npx convex run migrations:conversationsToChats` (dev) and with `--prod` after a release deploys. Then the legacy tables can be dropped.
