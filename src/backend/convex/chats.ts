import { canManageChannel } from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import {
	type Namer,
	type Participant,
	addToChat,
	agentOfDm,
	availableName,
	chatMembersOf,
	findOrCreateDm,
	latestMentionSince,
	markChatRead,
	membership,
	namer,
	requireActiveAgents,
	requireChat,
	requireManagedChannel,
	requireWorkspaceUsers,
	visibleChat,
} from "./chatOps";
import { type Member, checkPermission, getMember, preferencesOf, requireMember, toActor } from "./lib";
import { trashInfo } from "./trashOps";
import { sessionAt } from "./turns";

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
	members: Participant[];
	unread: boolean;
	/** An unread message mentions you. */
	mentioned: boolean;
	lastMessageAt: number;
};

export type AgentItem = {
	_id: Id<"agents">;
	name: string;
	description: string;
	/** Their agent DM with you, once it exists. */
	dmId: Id<"chats"> | null;
	unread: boolean;
	mentioned: boolean;
	lastMessageAt: number | null;
};

async function toChatItem(ctx: QueryCtx, chat: Doc<"chats">, member: Member, names: Namer): Promise<ChatItem> {
	const rows = await chatMembersOf(ctx, chat._id);
	const members = await Promise.all(rows.map(names.of));
	const mine = rows.find((r) => r.userId === member.userId);
	const unread = !!mine && chat.lastMessageAt > (mine.lastReadAt ?? 0);
	const others = members.filter((m) => m.id !== member.userId).map((m) => m.name);
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
		mentioned: unread && !!(await latestMentionSince(ctx, chat._id, member.userId, mine?.lastReadAt ?? 0)),
		lastMessageAt: chat.lastMessageAt,
	};
}

/** The chats you're in, and each active agent with its DM with you. */
export const list = query({
	args: {},
	handler: async (
		ctx,
	): Promise<{ me: Id<"users">; channels: ChatItem[]; dms: ChatItem[]; agents: AgentItem[] } | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const names = namer(ctx);
		const rows = await ctx.db
			.query("chatMembers")
			.withIndex("by_user", (q) => q.eq("userId", member.userId))
			.collect();
		const items: ChatItem[] = [];
		for (const row of rows) {
			const chat = await ctx.db.get(row.chatId);
			if (chat && !chat.archived && chat.workspaceId === member.workspaceId) items.push(await toChatItem(ctx, chat, member, names));
		}
		const agents = await ctx.db
			.query("agents")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.filter((q) => q.eq(q.field("archived"), false))
			.collect();
		return {
			me: member.userId,
			channels: items.filter((c) => c.kind === "channel").sort((a, b) => a.title.localeCompare(b.title)),
			dms: items.filter((c) => c.kind === "dm").sort((a, b) => b.lastMessageAt - a.lastMessageAt),
			agents: agents.map((a) => {
				const dm = items.find((c) => c.agentId === a._id);
				return {
					_id: a._id,
					name: a.name,
					description: a.description,
					dmId: dm?._id ?? null,
					unread: dm?.unread ?? false,
					mentioned: dm?.mentioned ?? false,
					lastMessageAt: dm?.lastMessageAt ?? null,
				};
			}),
		};
	},
});

/** A chat's alert: its newest unread message meant for you. */
export type Alert = {
	/** Where the chat is, so a click can open that workspace first. */
	workspaceId: Id<"workspaces">;
	chatId: Id<"chats">;
	messageId: Id<"chatMessages">;
	title: string;
	text: string;
};

/**
 * What should reach you outside the app, by your notification setting: unread DMs
 * (agents' replies once finished) and unread @mentions, main timelines only. `latest` is
 * each such chat's newest one, for desktop notifications; its length is the dock badge.
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
		const alerts: Alert[] = [];
		for (const row of await ctx.db
			.query("chatMembers")
			.withIndex("by_user", (q) => q.eq("userId", member.userId))
			.collect()) {
			const since = row.lastReadAt ?? 0;
			const chat = await ctx.db.get(row.chatId);
			if (!chat || chat.archived || chat.workspaceId !== member.workspaceId || chat.lastMessageAt <= since) continue;
			const fromOthers = (m: Doc<"chatMessages"> | null) => (m && !m.deleted && m.authorUserId !== member.userId ? m : null);
			// Mentions come from their index, so any number of newer messages can't hide one.
			const mention = await latestMentionSince(ctx, chat._id, member.userId, since);
			let message = fromOthers(mention && (await ctx.db.get(mention.messageId)));
			if (chat.kind === "dm" && notify === "all") {
				// Your own posts mark the chat read, so what's unread here is others'. Agent replies
				// still streaming are skipped until they finish.
				const recent = await ctx.db
					.query("chatMessages")
					.withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id).eq("threadId", undefined).gt("_creationTime", since))
					.order("desc")
					.take(20);
				const newest = recent.map(fromOthers).find((m) => m?.status === "done");
				if (newest && (!message || newest._creationTime > message._creationTime)) message = newest;
			}
			if (!message) continue;
			const author = (await names.of(message)).name;
			alerts.push({
				workspaceId: chat.workspaceId,
				chatId: chat._id,
				messageId: message._id,
				title: chat.kind === "channel" ? `${author} in #${chat.name}` : author,
				text: message.text.slice(0, 200),
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
			if (await membership(ctx, c._id, member.userId)) continue;
			const memberCount = (await chatMembersOf(ctx, c._id)).length;
			result.push({ _id: c._id, name: c.name ?? "", topic: c.topic ?? null, memberCount });
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
		return {
			...(await toChatItem(ctx, chat, member, namer(ctx))),
			canManage: chat.kind === "channel" && canManageChannel(toActor(member), chat),
			trash: chat.archived ? await trashInfo(ctx, member, chat._id) : null,
		};
	},
});

const createChannelArgs = v.object({ name: v.string(), topic: v.optional(v.string()), private: v.boolean() });

export const createChannel = mutation({
	args: createChannelArgs.fields,
	handler: async (ctx, args) => createChannelAs(ctx, await requireMember(ctx), args),
});

export async function createChannelAs(ctx: MutationCtx, member: Member, args: Infer<typeof createChannelArgs>): Promise<Id<"chats">> {
	checkPermission(member, "channels.create");
	const name = await availableName(ctx, member, args.name);
	const chatId = await ctx.db.insert("chats", {
		workspaceId: member.workspaceId,
		kind: "channel",
		name,
		...(args.topic?.trim() && { topic: args.topic.trim() }),
		private: args.private,
		archived: false,
		createdBy: member.userId,
		lastMessageAt: Date.now(),
	});
	await addToChat(ctx, (await ctx.db.get(chatId))!, { userId: member.userId });
	return chatId;
}

const updateChannelArgs = v.object({ chatId: v.id("chats"), name: v.optional(v.string()), topic: v.optional(v.string()) });

export const updateChannel = mutation({
	args: updateChannelArgs.fields,
	handler: async (ctx, args) => updateChannelAs(ctx, await requireMember(ctx), args),
});

export async function updateChannelAs(ctx: MutationCtx, member: Member, { chatId, name, topic }: Infer<typeof updateChannelArgs>) {
	const chat = await requireManagedChannel(ctx, member, chatId);
	if (chat.archived) throw new ConvexError("This channel is in Trash.");
	await ctx.db.patch(chat._id, {
		...(name !== undefined && { name: await availableName(ctx, member, name, chat._id) }),
		...(topic !== undefined && { topic: topic.trim() || undefined }),
	});
}

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
	if (chat.isDefault) throw new ConvexError(`Everyone stays in #${chat.name}.`);
	const row = await membership(ctx, chatId, member.userId);
	if (row) await ctx.db.delete(row._id);
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
	if (!(await membership(ctx, chatId, member.userId)) && !canManageChannel(toActor(member), chat)) {
		throw new ConvexError("Join the channel first.");
	}
	await requireWorkspaceUsers(ctx, member.workspaceId, userIds);
	await requireActiveAgents(ctx, member.workspaceId, agentIds);
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
	return findOrCreateDm(ctx, member.workspaceId, member.userId, userIds, agentIds);
}

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
		const chat = (await visibleChat(ctx, chatId))?.chat;
		if (!chat) return null;
		const parent = threadId && (await ctx.db.get(threadId));
		if (threadId && parent?.chatId !== chatId) return null;
		const costUsd = (parent ? parent.costUsd : chat.costUsd) ?? 0;
		const agentId = agentOfDm(chat);
		const session = agentId && (await sessionAt(ctx, { agentId, chatId, threadId }));
		return {
			summary: session?.summary ?? null,
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
	if (chat.isDefault && userId) throw new ConvexError(`Everyone stays in #${chat.name}.`);
	const row = userId ? await membership(ctx, chatId, userId) : await ctx.db.query("chatMembers")
		.withIndex("by_agent", q => q.eq("agentId", agentId).eq("chatId", chatId)).first();
	if (row) await ctx.db.delete(row._id);
}

export async function markReadAs(ctx: MutationCtx, member: Member, chatId: Id<"chats">) {
	await requireChat(ctx, member, chatId);
	await markChatRead(ctx, chatId, member.userId);
}
