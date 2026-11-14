import { MESSAGE_PAGE } from "@companybot/core/chat";
import { showRecordTags } from "@companybot/core/record-mentions";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticUpdate } from "convex/browser";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useCallback, useMemo } from "react";
import { api } from "../../api";
import { usePaginatedQuery, useQuery, useQueryOnce } from "../../convex";

export type ChatList = NonNullable<FunctionReturnType<typeof api.chats.list>>;
type ChatItem = ChatList["channels"][number];
export type ChatDetails = NonNullable<FunctionReturnType<typeof api.chats.get>>;
/** `sending`: only on your message shown while it sends (`showSending`), before the server has it. */
export type Message = FunctionReturnType<typeof api.messages.page>["page"][number] & { sending?: { files: number } };
export type Participant = Message["author"];
export type Mentions = { userIds: Id<"users">[]; agentIds: Id<"agents">[]; skillIds: string[]; recordIds: Id<"records">[] };

/** A channel the composer can name with #. `joined`: you're in it (public ones you aren't are offered too). */
export type ChannelRef = { id: Id<"chats">; name: string; topic: string | null; private: boolean; joined: boolean };
/** A skill the composer can invoke with /. */
export type SkillRef = { id: string; name: string; description: string };
/** A record the composer can tag with @, from a search across the databases you can see. */
export type RecordRef = { id: Id<"records">; name: string; typeKey: string; typeName: string };
/** A record tagged in a message, as it reads there (`@Summit Homes`, `@Private record`). */
export type RecordTag = Message["records"][number];

/**
 * What messages show as chips, each clickable: @names (profile card), #channels (opens it), /skills (opens it),
 * and a message's own tagged records (opens the record).
 */
export type TokenNames = { people: Participant[]; channels: { name: string; id: Id<"chats"> }[]; skills: SkillRef[]; records?: RecordTag[] };

/** Pages put together in the order shown: a thread's parent first, then by when each was shown. */
export const inOrder = (messages: Message[], threadId?: Id<"chatMessages">) =>
	[...messages].sort((a, b) => Number(b._id === threadId) - Number(a._id === threadId) || a.shownAt - b.shownAt);

/**
 * A chat's or thread's messages, newest page first: `more` loads the page before the oldest shown, until
 * there's none (then it's unset). Undefined until the first page arrives.
 */
export function useMessages(chatId: Id<"chats">, threadId?: Id<"chatMessages">) {
	const { results, status, loadMore } = usePaginatedQuery(api.messages.page, { chatId, ...(threadId && { threadId }) }, { initialNumItems: MESSAGE_PAGE });
	const messages = useMemo(() => (status === "LoadingFirstPage" ? undefined : inOrder(results, threadId)), [results, status, threadId]);
	const more = useMemo(() => (status === "CanLoadMore" ? () => loadMore(MESSAGE_PAGE) : undefined), [status, loadMore]);
	return { messages, more, all: status === "Exhausted" };
}

/**
 * Your message shows at once, dimmed, at the end of the chat or thread until the server's list has
 * it (Discord does the same). A send that fails takes it out again; the composer gets the text back.
 */
export const showSending = (): OptimisticUpdate<FunctionArgs<typeof api.messages.send>> => {
	const now = Date.now();
	const id = crypto.randomUUID();
	return (store, { workspaceId, chatId, threadId, text, attachments = [] }) => {
		// Its newest page: every one asked for with no cursor (a split page is asked for again, with its end).
		const newest = store
			.getAllQueries(api.messages.page)
			.filter(({ args, value }) => value && args.workspaceId === workspaceId && args.chatId === chatId && args.threadId === threadId && args.paginationOpts.cursor === null);
		const me = store.getQuery(api.workspace.team, { workspaceId })?.members.find((m) => m.isYou);
		if (!newest.length || !me) return;
		// Tagged records read as their names until the server has it (and says what each is).
		const tagged: string[] = [];
		const shown = showRecordTags(text.trim(), (_, label) => {
			const name = `@${label ?? ""}`;
			if (!tagged.includes(name)) tagged.push(name);
			return name;
		});
		const message: Message = {
			_id: `sending:${id}` as Id<"chatMessages">,
			_creationTime: now,
			shownAt: now,
			chatId,
			threadId: threadId ?? null,
			author: { type: "user", id: me.userId, name: me.name || me.email, image: me.image },
			text: shown,
			parts: [],
			status: "done",
			error: null,
			stoppedBy: null,
			stats: null,
			editedAt: null,
			deleted: false,
			mine: true,
			replyCount: 0,
			lastReplyAt: null,
			replyAuthors: [],
			reactions: [],
			automation: null,
			attachments: [],
			linkPreviews: [],
			pause: null,
			ask: null,
			// Not clickable until the server says which records they are.
			records: tagged.map((name) => ({ text: name, id: null, typeKey: null, state: "live" as const })),
			sending: { files: attachments.length },
		};
		for (const { args, value } of newest) store.setQuery(api.messages.page, args, { ...value!, page: [...value!.page, message] });
	};
};

/** People, agents, channels and skills you can mention or add. `people` leaves you out. */
export function useDirectory() {
	const team = useQuery(api.workspace.team);
	const chats = useQuery(api.chats.list);
	const browse = useQuery(api.chats.browse);
	const skillRows = useQuery(api.skills.list);
	const mentionable = useQueryOnce(api.records.mentionable);
	const people: (Participant & { isYou: boolean })[] =
		team?.members.map((m) => ({ type: "user" as const, id: m.userId, name: m.name || m.email, image: m.image, isYou: m.isYou })) ?? [];
	const agents: Participant[] = chats?.agents.map((a) => ({ type: "agent" as const, id: a._id, name: a.name, image: a.image })) ?? [];
	const channels: ChannelRef[] = [
		...(chats?.channels ?? []).map((c) => ({ id: c._id, name: c.name ?? "", topic: c.topic, private: c.private, joined: true })),
		...(browse ?? []).map((c) => ({ id: c._id, name: c.name, topic: c.topic, private: false, joined: false })),
	].sort((a, b) => a.name.localeCompare(b.name));
	const skills: SkillRef[] = (skillRows ?? []).filter((s) => !s.trash).map((s) => ({ id: s.id, name: s.name, description: s.description }));
	return {
		people: people.filter((p) => !p.isYou),
		agents,
		channels,
		skills,
		records: useCallback(
			async (query: string): Promise<RecordRef[]> => (await mentionable({ query })).map((r) => ({ id: r._id, name: r.title, typeKey: r.typeKey, typeName: r.typeName })),
			[mentionable],
		),
		tokens: {
			people: [...people, ...agents].filter((p) => p.name),
			channels: channels.map((c) => ({ name: c.name, id: c.id })),
			skills,
		} satisfies TokenNames,
	};
}

export const chatTitle = (chat: Pick<ChatItem, "kind" | "name" | "title">) =>
	chat.kind === "channel" ? `#${chat.name}` : chat.title;

/** Count each chat once; agent sidebar rows copy their DM activity. */
export function chatBadge(chats: { channels: { kind: string; mentioned: boolean; unread: boolean }[]; dms: { kind: string; mentioned: boolean; unread: boolean }[] }) {
	const waiting = [...chats.channels, ...chats.dms];
	return { mentions: waiting.filter((c) => c.mentioned || (c.kind === "dm" && c.unread)).length, unread: waiting.some((c) => c.unread) };
}
