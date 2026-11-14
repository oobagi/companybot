import { refreshAudience } from "./chatDiscovery";
import { type ReplyMode, THREAD_HOURS_DEFAULT, TOPIC_MAX, can, replyModeOf, replyModes } from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { activityOf, addToChat, insertChat, agentOfDm, availableName, dropSeat, chatMembersOf, findOrCreateDm, label, latestMentionSince, markChatRead, membership, namer, requireActiveAgents, requireChat, requireManagedChannel, requireWorkspaceUsers, shownAt, sideChatTitle, titleFrom, type Namer, type Participant, visibleChat } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, preferencesOf, requireMember, toActor } from "./lib";
import { type AccessList, accessInfo, chatAccess, reach, requireKeepsEdit, savedAccess } from "./placeAccess";
import { recordTags } from "./recordTags";
import { canReadReply, canReadSources } from "./replyPrivacy";
import { changeAccessSources, writeSources } from "./replySources";
import { accessArg } from "./schema";
import { trashInfo } from "./trashOps";
import { STALE_TURN_MS, sessionAt } from "./turns";

// Channels and DMs. Queries return display-ready data so the app never joins tables.
// See wiki/chat.md.

export type ChatItem = {
	_id: Id<"chats">;
	kind: "channel" | "dm";
	name: string | null;
	topic: string | null;
	private: boolean;
	isDefault: boolean;
	/** The channel's name, or the other participants' names for a DM. */
	title: string;
	/** Agent DMs only (one person + one agent): the agent. */
	agentId: Id<"agents"> | null;
	/** Everyone in it. Empty for channels in `list`, so one person reading a channel doesn't re-run everyone's list. */
	members: Participant[];
	unread: boolean;
	/** A message since you last read the chat mentions you, in its main timeline or a thread. */
	mentioned: boolean;
	lastMessageAt: number;
	/** Channels: you can rename it, delete it, manage its members and choose who can access it (`channels.edit`, and Post in it). */
	canManage: boolean;
	/** You can post here; false in a channel you can only view. */
	canPost: boolean;
	/** Restricted channels: who can see it ("Office and Owners"), or who can post (`edit`) in one everyone sees. The sidebar's lock. */
	lock: { who: string; edit: boolean } | null;
	/** When agents answer without an @mention: always "mentions" outside channels (core router.ts). */
	replyMode: ReplyMode;
	/** Side chats: the agent DM they sit under. Else null. */
	parentId: Id<"chats"> | null;
	/** Side chats: what it's about ("New chat" until its first message). Else null. */
	label: string | null;
};

export type AgentItem = {
	_id: Id<"agents">;
	name: string;
	description: string;
	/** Its picture's URL, or null for its initials. */
	image: string | null;
	/** Their agent DM with you, once it exists. */
	dmId: Id<"chats"> | null;
	unread: boolean;
	mentioned: boolean;
	lastMessageAt: number | null;
};

/** `mine`: your row in it. `rows`: everyone's, or none for a channel in `list`. */
async function toChatItem(
	ctx: QueryCtx,
	chat: Doc<"chats">,
	member: Member,
	names: Namer,
	mine: Doc<"chatMembers"> | undefined,
	rows: Doc<"chatMembers">[],
): Promise<ChatItem> {
	const members = await Promise.all(rows.map(names.of));
	const { lastMessageAt } = await activityOf(ctx, chat);
	const unread = !!mine && lastMessageAt > (mine.lastReadAt ?? 0);
	const others = members.filter((m) => m.id !== member.userId).map((m) => m.name);
	const access = accessInfo(member, chatAccess(chat));
	return {
		_id: chat._id,
		kind: chat.kind,
		name: chat.name ?? null,
		topic: chat.topic ?? null,
		private: chat.private,
		isDefault: chat.isDefault ?? false,
		title: chat.kind === "channel" ? (chat.name ?? "") : others.join(", ") || (await names.user(member.userId)).name,
		agentId: agentOfDm(chat),
		members,
		unread,
		// Not gated on `unread`: a thread reply doesn't move the chat's lastMessageAt.
		mentioned: !!mine && !!(await latestMentionSince(ctx, chat._id, member.userId, mine.lastReadAt ?? 0)),
		lastMessageAt,
		canManage: chat.kind === "channel" && can(member, "channels.edit") && access.level === "edit",
		canPost: access.level === "edit",
		lock: access.lock,
		replyMode: replyModeOf(chat),
		parentId: chat.parentId ?? null,
		label: chat.parentId ? sideChatTitle(chat) : null,
	};
}

/** Your seats in this workspace's chats. */
const seatsOf = (ctx: QueryCtx, member: Member) =>
	ctx.db.query("chatMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).collect();

/** The chats you're in, and each active agent with its DM with you. */
export const list = query({
	args: {},
	handler: async (
		ctx,
	): Promise<{ me: Id<"users">; channels: ChatItem[]; dms: ChatItem[]; agents: AgentItem[] } | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const names = namer(ctx, { images: true });
		const rows = await seatsOf(ctx, member);
		const items: ChatItem[] = [];
		const createdAt = new Map<Id<"chats">, number>();
		for (const row of rows) {
			const chat = await ctx.db.get(row.chatId);
			if (!chat || chat.archived || chat.workspaceId !== member.workspaceId || !reach(member, chatAccess(chat))) continue;
			createdAt.set(chat._id, chat._creationTime);
			const item = await toChatItem(ctx, chat, member, names, row, chat.kind === "dm" ? await chatMembersOf(ctx, chat._id) : []);
			// Closed (closeDm): back once something new arrives there.
			if (row.closedAt !== undefined && item.lastMessageAt <= row.closedAt && !item.mentioned) continue;
			items.push(item);
		}
		// DMs most recent first; side chats in the order they were made, so a new tab lands at the end.
		const dms = items.filter((c) => c.kind === "dm" && !c.parentId).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
		const sides = items.filter((c) => c.parentId).sort((a, b) => createdAt.get(a._id)! - createdAt.get(b._id)!);
		const agents = await ctx.db
			.query("agents")
			.withIndex("by_workspace_active", (q) => q.eq("workspaceId", member.workspaceId).eq("archived", false))
			.collect();
		return {
			me: member.userId,
			channels: items.filter((c) => c.kind === "channel").sort((a, b) => a.title.localeCompare(b.title)),
			dms: [...dms, ...sides],
			agents: await Promise.all(agents.map(async (a) => {
				const dm = items.find((c) => c.agentId === a._id && !c.parentId);
				return {
					_id: a._id,
					name: a.name,
					description: a.description,
					image: await names.imageUrl(a.image),
					dmId: dm?._id ?? null,
					unread: dm?.unread ?? false,
					mentioned: dm?.mentioned ?? false,
					lastMessageAt: dm?.lastMessageAt ?? null,
				};
			})),
		};
	},
});

/** A thread with replies lately, for the sidebar. `title` is its parent message's first line. */
export type ActiveThread = { chatId: Id<"chats">; messageId: Id<"chatMessages">; title: string; lastReplyAt: number };
/** A bound on one channel's rows, so a runaway channel can't crowd out the rest or make the query read everything. */
export const ACTIVE_THREADS_PER_CHANNEL = 10;
/** The most the sidebar shows, newest reply first. */
export const ACTIVE_THREADS_MAX = 50;

/**
 * Threads replied to lately (the workspace's `threadHours`, default 3 days, 0 forever), in channels you're in,
 * newest reply first. `now` comes from the app, rounded to 5 minutes (`useClock`): a query re-runs
 * when its arguments change, not as time passes, so this is what makes a quiet thread drop off on time.
 */
export const activeThreads = query({
	args: { now: v.number() },
	handler: async (ctx, { now }): Promise<ActiveThread[]> => {
		const member = await getMember(ctx);
		if (!member) return [];
		const workspace = (await ctx.db.get(member.workspaceId))!;
		const hours = workspace.threadHours ?? THREAD_HOURS_DEFAULT;
		// 0 is forever: every thread with a reply (a parent without one has no lastReplyAt).
		const since = hours ? now - hours * 60 * 60 * 1000 : 0;
		const parents: Doc<"chatMessages">[] = [];
		for (const row of await seatsOf(ctx, member)) {
			const chat = await ctx.db.get(row.chatId);
			if (chat?.kind !== "channel" || chat.archived || chat.workspaceId !== member.workspaceId || !reach(member, chatAccess(chat))) continue;
			parents.push(...(await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_lastReply", (q) => q.eq("chatId", chat._id).gt("lastReplyAt", since))
				.order("desc")
				.take(ACTIVE_THREADS_PER_CHANNEL)));
		}
		const newest = parents.sort((a, b) => b.lastReplyAt! - a.lastReplyAt!).slice(0, ACTIVE_THREADS_MAX);
		const tags = recordTags(ctx, member);
		return Promise.all(newest.map(async (m) => ({ chatId: m.chatId, messageId: m._id, title: await canReadReply(ctx, member, m) ? threadTitle((await tags.forPeople(m.text)).text, m.deleted) : "🔒 Private reply", lastReplyAt: m.lastReplyAt! })));
	},
});

const threadTitle = (text: string, deleted?: boolean) => (deleted ? "Deleted message" : titleFrom(text) || "Thread");

/** A chat's alert: its newest unread message meant for you. */
export type Alert = {
	/** Where the chat is, so a click can open that workspace first. */
	workspaceId: Id<"workspaces">;
	chatId: Id<"chats">;
	messageId: Id<"chatMessages">;
	/** Set when the message is a thread reply, so a click opens the thread. */
	threadId?: Id<"chatMessages">;
	title: string;
	text: string;
};

/**
 * What should reach you outside the app, by your notification setting: unread DMs
 * (agents' replies once finished, main timelines) and unread @mentions (main timelines and
 * threads). Each such chat's newest one, for desktop notifications; the length is the dock badge.
 */
export const alerts = query({
	args: {},
	handler: async (ctx): Promise<Alert[] | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const prefs = await preferencesOf(ctx, member.userId);
		const notify = prefs?.notify ?? "all";
		if (notify === "off") return [];
		const names = namer(ctx);
		const tags = recordTags(ctx, member);
		const alerts: Alert[] = [];
		for (const row of await seatsOf(ctx, member)) {
			const since = row.lastReadAt ?? 0;
			const chat = await ctx.db.get(row.chatId);
			// Off a channel's access list, it says nothing: no alert, no badge.
			if (!chat || chat.archived || chat.workspaceId !== member.workspaceId || !reach(member, chatAccess(chat))) continue;
			const fromOthers = (m: Doc<"chatMessages"> | null) => (m && !m.deleted && !m.quiet && m.authorUserId !== member.userId ? m : null);
			// Mentions come from their index, so any number of newer messages can't hide one,
			// and a thread reply (which doesn't move lastMessageAt) is found all the same.
			const mention = await latestMentionSince(ctx, chat._id, member.userId, since);
			let message = fromOthers(mention && (await ctx.db.get(mention.messageId)));
			// Only a DM reads its activity, so a channel's messages re-run this only when they mention you.
			if (chat.kind === "dm" && notify === "all" && (await activityOf(ctx, chat)).lastMessageAt > since) {
				// Your own posts mark the chat read, so what's unread here is others'. Agent replies
				// still streaming are skipped until they finish. A reply begun before you last read can be
				// shown after it (chatOps `shownAt`): replies run at most STALE_TURN_MS.
				const recent = await ctx.db
					.query("chatMessages")
					.withIndex("by_chat_thread_quiet", (q) => q.eq("chatId", chat._id).eq("threadId", undefined).eq("quiet", undefined).gt("_creationTime", since - STALE_TURN_MS))
					.order("desc")
					.take(20);
				const newest = recent
					.map(fromOthers)
					.filter((m) => m?.status === "done" && shownAt(m) > since)
					.reduce<Doc<"chatMessages"> | null>((a, m) => (a && shownAt(a) >= shownAt(m!) ? a : m), null);
				if (newest && (!message || shownAt(newest) > shownAt(message))) message = newest;
			}
			if (!message) continue;
			const author = label(await names.of(message));
			alerts.push({
				workspaceId: chat.workspaceId,
				chatId: chat._id,
				messageId: message._id,
				...(message.threadId && { threadId: message.threadId }),
				title: chat.kind === "channel" ? `${author} in #${chat.name}` : author,
				text: await canReadReply(ctx, member, message) ? (await tags.forPeople(message.text)).text.slice(0, 200) : "🔒 Private reply",
			});
		}
		return alerts;
	},
});

/** Public channels you're not in. */
export const browse = query({
	args: {},
	handler: async (ctx): Promise<{ _id: Id<"chats">; name: string; topic: string | null; memberCount: number }[]> => {
		const member = await getMember(ctx);
		if (!member) return [];
		const channels = await ctx.db
			.query("chats")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("kind", "channel"))
			.filter((q) => q.and(q.eq(q.field("private"), false), q.eq(q.field("archived"), false)))
			.collect();
		const result = [];
		for (const c of channels) {
			if (!reach(member, chatAccess(c)) || (await membership(ctx, c._id, member.userId))) continue;
			result.push({ _id: c._id, name: c.name ?? "", topic: c.topic ?? null, memberCount: c.memberCount ?? 0 });
		}
		return result.sort((a, b) => a.name.localeCompare(b.name));
	},
});

export const get = query({
	args: { chatId: v.id("chats") },
	handler: async (ctx, { chatId }) => {
		const visible = await visibleChat(ctx, chatId);
		if (!visible) return null;
		const { member, chat } = visible;
		const rows = await chatMembersOf(ctx, chat._id);
		return {
			...(await toChatItem(ctx, chat, member, namer(ctx, { images: true }), rows.find((r) => r.userId === member.userId), rows)),
			trash: chat.archived ? await trashInfo(ctx, member, chat._id) : null,
			/** Channels: its Who can access list, as the details panel shows it. */
			access: chat.kind === "channel" ? accessInfo(member, chatAccess(chat)).access : null,
		};
	},
});

/** A topic as stored: trimmed, at most `TOPIC_MAX` characters. Longer is refused, so nobody's words are cut silently. */
function checkedTopic(topic: string) {
	const trimmed = topic.trim();
	if (trimmed.length > TOPIC_MAX) throw new ConvexError(`Keep the topic under ${TOPIC_MAX} characters.`);
	return trimmed;
}

const createChannelArgs = v.object({ name: v.string(), topic: v.optional(v.string()), private: v.boolean() });

export const createChannel = mutation({
	args: createChannelArgs.fields,
	handler: async (ctx, args) => createChannelAs(ctx, await requireMember(ctx), args),
});

export async function createChannelAs(ctx: MutationCtx, member: Member, args: Infer<typeof createChannelArgs>): Promise<Id<"chats">> {
	checkPermission(member, "channels.edit");
	const usedPlaces = await writeSources(ctx, member, args.private ? { users: [member.userId] } : undefined);
	const name = await availableName(ctx, member, args.name);
	const chatId = await insertChat(ctx, {
		usedPlaces,
		workspaceId: member.workspaceId,
		kind: "channel",
		replyMode: "mentions",
		name,
		...(args.topic?.trim() && { topic: checkedTopic(args.topic) }),
		private: args.private,
		searchPublic: !args.private,
		archived: false,
		createdBy: member.userId,
		memberCount: 0,
	});
	await addToChat(ctx, (await ctx.db.get(chatId))!, { userId: member.userId });
	return chatId;
}

const updateChannelArgs = v.object({
	chatId: v.id("chats"),
	name: v.optional(v.string()),
	topic: v.optional(v.string()),
	/** When agents answer without an @mention. */
	replyMode: v.optional(v.union(...replyModes.map((m) => v.literal(m)))),
});

export const updateChannel = mutation({
	args: updateChannelArgs.fields,
	handler: async (ctx, args) => updateChannelAs(ctx, await requireMember(ctx), args),
});

export async function updateChannelAs(ctx: MutationCtx, member: Member, { chatId, name, topic, replyMode }: Infer<typeof updateChannelArgs>) {
	const chat = await requireManagedChannel(ctx, member, chatId);
	if (chat.archived) throw new ConvexError("This channel is in Archive.");
	if (name !== undefined || topic !== undefined) await writeSources(ctx, member, chatId);
	await ctx.db.patch(chat._id, {
		...(name !== undefined && { name: await availableName(ctx, member, name, chat._id) }),
		...(topic !== undefined && { topic: checkedTopic(topic) || undefined }),
		// Unset is "mentions", like every channel from before the setting.
		...(replyMode !== undefined && { replyMode: replyMode === "relevant" ? undefined : replyMode }),
	});
}

/**
 * Who can access a channel: Everyone or roles, each at View or Post. People with `channels.edit` who
 * can post there choose it. #general stays open to everyone (at least to view): everyone is in it.
 */
export const setAccess = mutation({
	args: { chatId: v.id("chats"), access: accessArg },
	handler: async (ctx, { chatId, access }) => {
		const member = await requireMember(ctx);
		const chat = await requireManagedChannel(ctx, member, chatId);
		if (chat.archived) throw new ConvexError("This channel is in Archive.");
		const list: AccessList = await savedAccess(ctx, member, access);
		if (chat.isDefault && !list.some((e) => e.role === "everyone")) throw new ConvexError(`Everyone is in #${chat.name}, so everyone keeps at least View.`);
		requireKeepsEdit(member, "channel", list);
		// Everyone at Post is the default: store nothing, as for a channel nobody restricted.
		const open = list.length === 1 && list[0]!.role === "everyone" && list[0]!.level === "edit";
		const users = chat.private ? (await chatMembersOf(ctx, chat._id)).flatMap((m) => m.userId ? [m.userId] : []) : undefined;
		await changeAccessSources(ctx, member, chat, { access: list, users });
		await ctx.db.patch(chat._id, { access: open ? undefined : list });
		await refreshAudience(ctx, { ...chat, access: open ? undefined : list });
	},
});

const joinChannelArgs = v.object({ chatId: v.id("chats") });

export const join = mutation({
	args: joinChannelArgs.fields,
	handler: async (ctx, args) => joinChannel(ctx, await requireMember(ctx), args),
});

export async function joinChannel(ctx: MutationCtx, member: Member, { chatId }: Infer<typeof joinChannelArgs>) {
	const chat = await requireChat(ctx, member, chatId);
	if (chat.kind !== "channel" || chat.archived) throw new ConvexError("You can't join this chat.");
	await addToChat(ctx, chat, { userId: member.userId });
}

const leaveChannelArgs = v.object({ chatId: v.id("chats") });

export const leave = mutation({
	args: leaveChannelArgs.fields,
	handler: async (ctx, args) => leaveChannel(ctx, await requireMember(ctx), args),
});

export async function leaveChannel(ctx: MutationCtx, member: Member, { chatId }: Infer<typeof leaveChannelArgs>) {
	const chat = await requireChat(ctx, member, chatId);
	if (chat.kind !== "channel") throw new ConvexError("You can't leave a DM.");
	if (chat.isDefault) throw new ConvexError(`You can't leave #${chat.name}: it's the channel everyone is in.`);
	const row = await membership(ctx, chatId, member.userId);
	if (row) await dropSeat(ctx, row);
}

/** Channels only. Members of a channel can add people; managers can add to any channel they see. */
const addChannelMembersArgs = v.object({ chatId: v.id("chats"), userIds: v.array(v.id("users")), agentIds: v.array(v.id("agents")) });

export const addMembers = mutation({
	args: addChannelMembersArgs.fields,
	handler: async (ctx, args) => addChannelMembers(ctx, await requireMember(ctx), args),
});

export async function addChannelMembers(ctx: MutationCtx, member: Member, { chatId, userIds, agentIds }: Infer<typeof addChannelMembersArgs>) {
	const chat = await requireChat(ctx, member, chatId);
	if (chat.kind !== "channel" || chat.archived) throw new ConvexError("You can only add people to channels.");
	if (!(await membership(ctx, chatId, member.userId)) && !can(member, "channels.edit")) {
		throw new ConvexError("Join the channel first.");
	}
	await requireWorkspaceUsers(ctx, member.workspaceId, userIds);
	await requireActiveAgents(ctx, member.workspaceId, agentIds);
	if (chat.private) {
		const users = [...new Set([...(await chatMembersOf(ctx, chatId)).flatMap((m) => m.userId ? [m.userId] : []), ...userIds])];
		await writeSources(ctx, member, { place: chatId, users, access: chatAccess(chat) }, chat);
	}
	for (const userId of userIds) await addToChat(ctx, chat, { userId });
	for (const agentId of agentIds) await addToChat(ctx, chat, { agentId });
}

/** Finds or creates the DM with exactly these people and agents (and you). */
const openDirectMessageArgs = v.object({ userIds: v.array(v.id("users")), agentIds: v.array(v.id("agents")) });

export const openDm = mutation({
	args: openDirectMessageArgs.fields,
	handler: async (ctx, args) => openDirectMessage(ctx, await requireMember(ctx), args),
});

export async function openDirectMessage(ctx: MutationCtx, member: Member, args: Infer<typeof openDirectMessageArgs>): Promise<Id<"chats">> {
	const userIds = [...new Set([member.userId, ...args.userIds])];
	const agentIds = [...new Set(args.agentIds)];
	await requireWorkspaceUsers(ctx, member.workspaceId, userIds);
	await requireActiveAgents(ctx, member.workspaceId, agentIds);
	const chatId = await findOrCreateDm(ctx, member.workspaceId, member.userId, userIds, agentIds);
	// Opening a DM you closed puts it back in your sidebar.
	const row = await membership(ctx, chatId, member.userId);
	if (row?.closedAt !== undefined) await ctx.db.patch(row._id, { closedAt: undefined });
	return chatId;
}

/**
 * Closes a DM or group DM in your sidebar only, as Slack does: the messages stay, and it's back
 * when someone writes there or you open it again. Not a DM with an agent: that's how you reach it.
 */
export const closeDm = mutation({
	args: { chatId: v.id("chats") },
	handler: async (ctx, { chatId }) => {
		const member = await requireMember(ctx);
		const chat = await requireChat(ctx, member, chatId);
		if (chat.kind !== "dm" || chat.parentId) throw new ConvexError("Only DMs close. Leave a channel instead.");
		if (agentOfDm(chat)) throw new ConvexError("A DM with an agent stays in your sidebar: it's how you reach the agent.");
		const row = await membership(ctx, chatId, member.userId);
		if (row) await ctx.db.patch(row._id, { closedAt: Date.now() });
	},
});

/**
 * A new, separate conversation with the agent of one of your agent DMs: same two members, its
 * own session and memory context, listed under the DM. Named by its first message until renamed.
 */
export const createSideChat = mutation({
	args: { parentId: v.id("chats") },
	handler: async (ctx, { parentId }): Promise<Id<"chats">> => {
		const member = await requireMember(ctx);
		const parent = await requireChat(ctx, member, parentId);
		const agentId = agentOfDm(parent);
		if (!agentId || parent.parentId) throw new ConvexError("Side chats go under a DM with an agent.");
		if (parent.archived) throw new ConvexError("This chat is in Archive.");
		await requireActiveAgents(ctx, member.workspaceId, [agentId]);
		const chatId = await insertChat(ctx, {
			workspaceId: member.workspaceId,
			kind: "dm",
			searchPublic: false,
			private: true,
			dmKey: parent.dmKey,
			parentId,
			archived: false,
			createdBy: member.userId,
			memberCount: 0,
		});
		const chat = (await ctx.db.get(chatId))!;
		await addToChat(ctx, chat, { userId: member.userId });
		await addToChat(ctx, chat, { agentId });
		return chatId;
	},
});

/** Side chats only. */
export const renameChat = mutation({
	args: { chatId: v.id("chats"), title: v.string() },
	handler: async (ctx, { chatId, title }) => {
		const member = await requireMember(ctx);
		const chat = await requireChat(ctx, member, chatId);
		if (!chat.parentId) throw new ConvexError("Only side chats are renamed here.");
		title = title.trim().slice(0, 120);
		if (!title) throw new ConvexError("Give it a name.");
		await writeSources(ctx, member, chatId);
		await ctx.db.patch(chatId, { title });
	},
});

export const markRead = mutation({
	args: { chatId: v.id("chats") },
	handler: async (ctx, { chatId }) => markReadAs(ctx, await requireMember(ctx), chatId),
});

/**
 * For the summary divider and running cost. Summaries belong to agent sessions, so
 * only an agent DM (one agent) has one to show.
 */
export const place = query({
	args: { chatId: v.id("chats"), threadId: v.optional(v.id("chatMessages")) },
	handler: async (
		ctx,
		{ chatId, threadId },
	): Promise<{ summary: string | null; summarizedUpTo: number | null; compacting: boolean; costUsd: number } | null> => {
		const visible = await visibleChat(ctx, chatId);
		if (!visible) return null;
		const { chat, member } = visible;
		const parent = threadId && (await ctx.db.get(threadId));
		if (threadId && parent?.chatId !== chatId) return null;
		const costUsd = (parent ? parent.costUsd : (await activityOf(ctx, chat)).costUsd) ?? 0;
		const agentId = agentOfDm(chat);
		const session = agentId && (await sessionAt(ctx, { agentId, chatId, threadId }));
		return {
			summary: session?.summaryPrivacy === 1 && await canReadSources(ctx, member, session.summaryPlaces) ? session.summary ?? null : null,
			summarizedUpTo: session?.summarizedUpTo ?? null,
			compacting: session?.compacting ?? false,
			costUsd,
		};
	},
});

const removeChannelMemberArgs = v.object({ chatId: v.id("chats"), userId: v.optional(v.id("users")), agentId: v.optional(v.id("agents")) });

export const removeMember = mutation({
	args: removeChannelMemberArgs.fields,
	handler: async (ctx, args) => removeChannelMember(ctx, await requireMember(ctx), args),
});

export async function removeChannelMember(ctx: MutationCtx, member: Member, { chatId, userId, agentId }: Infer<typeof removeChannelMemberArgs>) {
	const chat = await requireManagedChannel(ctx, member, chatId);
	if (chat.archived) throw new ConvexError("This chat is archived.");
	if (!!userId === !!agentId) throw new ConvexError("Choose one person or agent.");
	if (chat.isDefault && userId) throw new ConvexError(`People can't be removed from #${chat.name}: it's the channel everyone is in.`);
	const row = userId ? await membership(ctx, chatId, userId) : await ctx.db.query("chatMembers")
		.withIndex("by_agent", q => q.eq("agentId", agentId).eq("chatId", chatId)).first();
	if (row) await dropSeat(ctx, row);
}

export async function markReadAs(ctx: MutationCtx, member: Member, chatId: Id<"chats">) {
	await requireChat(ctx, member, chatId);
	await markChatRead(ctx, chatId, member.userId);
}
