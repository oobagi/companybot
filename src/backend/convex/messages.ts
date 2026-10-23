import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import {
	type Namer,
	type Participant,
	addToChat,
	agentOfDm,
	canSee,
	insertMessage,
	membership,
	namer,
	requireChat,
} from "./chatOps";
import { type Member, getMember, memberOf, requireMember } from "./lib";
import type { messagePart, replyStats } from "./schema";
import { enqueueTurn, toggleReaction } from "./turns";

// Messages in a chat's main timeline or a thread. See wiki/chat.md.

export type Message = {
	_id: Id<"chatMessages">;
	_creationTime: number;
	chatId: Id<"chats">;
	threadId: Id<"chatMessages"> | null;
	author: Participant;
	text: string;
	parts: Infer<typeof messagePart>[];
	status: "streaming" | "done" | "error";
	error: string | null;
	stats: Infer<typeof replyStats> | null;
	editedAt: number | null;
	deleted: boolean;
	mine: boolean;
	replyCount: number;
	lastReplyAt: number | null;
	/** Up to 3 people or agents who replied in the thread, most recent first. */
	replyAuthors: Participant[];
	reactions: { emoji: string; count: number; mine: boolean; names: string[] }[];
};

const LIST_LIMIT = 200;

/** The newest 200 of the main timeline, or of a thread (parent first), oldest first. */
export const list = query({
	args: { chatId: v.id("chats"), threadId: v.optional(v.id("chatMessages")) },
	handler: async (ctx, { chatId, threadId }): Promise<Message[]> => {
		const member = await getMember(ctx);
		const chat = member && (await ctx.db.get(chatId));
		if (!member || !chat || !(await canSee(ctx, chat, member))) return [];
		const parent = threadId && (await ctx.db.get(threadId));
		if (threadId && (!parent || parent.chatId !== chatId)) return [];
		const docs = (
			await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_thread", (q) => q.eq("chatId", chatId).eq("threadId", threadId))
				.order("desc")
				.take(LIST_LIMIT)
		).reverse();
		const names = namer(ctx);
		return Promise.all((parent ? [parent, ...docs] : docs).map((m) => toMessage(ctx, m, member, names)));
	},
});

async function toMessage(ctx: QueryCtx, m: Doc<"chatMessages">, member: Member, names: Namer): Promise<Message> {
	const reactions: Message["reactions"] = [];
	for (const r of await ctx.db
		.query("reactions")
		.withIndex("by_message", (q) => q.eq("messageId", m._id))
		.collect()) {
		let group = reactions.find((g) => g.emoji === r.emoji);
		if (!group) reactions.push((group = { emoji: r.emoji, count: 0, mine: false, names: [] }));
		group.count++;
		group.mine ||= r.userId === member.userId;
		group.names.push((await names.of(r)).name);
	}
	const replyAuthors: Participant[] = [];
	if (!m.threadId && m.replyCount) {
		const replies = await ctx.db
			.query("chatMessages")
			.withIndex("by_chat_thread", (q) => q.eq("chatId", m.chatId).eq("threadId", m._id))
			.order("desc")
			.take(30);
		for (const reply of replies) {
			const author = await names.of(reply);
			if (replyAuthors.length < 3 && !replyAuthors.some((a) => a.id === author.id)) replyAuthors.push(author);
		}
	}
	return {
		_id: m._id,
		_creationTime: m._creationTime,
		chatId: m.chatId,
		threadId: m.threadId ?? null,
		author: await names.of(m),
		text: m.text,
		parts: m.parts,
		status: m.status,
		error: m.error ?? null,
		stats: m.stats ?? null,
		editedAt: m.editedAt ?? null,
		deleted: m.deleted ?? false,
		mine: m.authorUserId === member.userId,
		replyCount: m.replyCount ?? 0,
		lastReplyAt: m.lastReplyAt ?? null,
		replyAuthors,
		reactions,
	};
}

/**
 * Posts a message (joining a public channel if needed) and queues agent turns:
 * every message in an agent DM, otherwise each @mentioned agent.
 */
export const send = mutation({
	args: {
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		text: v.string(),
		mentions: v.object({ userIds: v.array(v.id("users")), agentIds: v.array(v.id("agents")) }),
	},
	handler: async (ctx, { chatId, threadId, text, mentions }): Promise<Id<"chatMessages">> => {
		const member = await requireMember(ctx);
		const chat = await requireChat(ctx, member, chatId);
		if (chat.archived) throw new ConvexError("This chat is archived.");
		text = text.trim();
		if (!text) throw new ConvexError("Write something first.");
		if (threadId) {
			const parent = await ctx.db.get(threadId);
			if (!parent || parent.chatId !== chatId || parent.threadId) throw new ConvexError("That thread doesn't exist.");
		}
		await addToChat(ctx, chat, { userId: member.userId });

		// Mentions outside the workspace (or of archived agents) are dropped, not trusted.
		const userIds: Id<"users">[] = [];
		for (const id of new Set(mentions.userIds)) {
			if ((await memberOf(ctx, id))?.workspaceId === member.workspaceId) userIds.push(id);
		}
		const agentIds: Id<"agents">[] = [];
		for (const id of new Set(mentions.agentIds)) {
			const agent = await ctx.db.get(id);
			if (agent?.workspaceId === member.workspaceId && !agent.archived) agentIds.push(id);
		}

		const dmAgent = agentOfDm(chat);
		if (dmAgent && (await ctx.db.get(dmAgent))?.archived) throw new ConvexError("This agent is archived.");

		const messageId = await insertMessage(ctx, chat, {
			threadId,
			authorUserId: member.userId,
			text,
			parts: [{ type: "text", text }],
			mentions: { userIds, agentIds },
			status: "done",
		});
		if (!threadId) {
			const row = await membership(ctx, chatId, member.userId);
			if (row) await ctx.db.patch(row._id, { lastReadAt: Date.now() });
		}

		// Channels gain mentioned agents as members. DMs are a fixed set, so only their own agents answer.
		let responders: Id<"agents">[];
		if (dmAgent) responders = [dmAgent];
		else if (chat.kind === "channel") {
			for (const agentId of agentIds) await addToChat(ctx, chat, { agentId });
			responders = agentIds;
		} else {
			const inDm = new Set(chat.dmKey?.split(","));
			responders = agentIds.filter((id) => inDm.has(`a:${id}`));
		}
		for (const agentId of responders) {
			await enqueueTurn(ctx, chat, { agentId, chatId, threadId, triggerId: messageId, actorId: member.userId });
		}
		return messageId;
	},
});

/** Your own message, not deleted. */
async function requireOwn(ctx: QueryCtx, member: Member, messageId: Id<"chatMessages">) {
	const message = await ctx.db.get(messageId);
	if (!message || message.workspaceId !== member.workspaceId || message.deleted) throw new ConvexError("Message not found.");
	if (message.authorUserId !== member.userId) throw new ConvexError("You can only change your own messages.");
	return message;
}

export const edit = mutation({
	args: { messageId: v.id("chatMessages"), text: v.string() },
	handler: async (ctx, { messageId, text }) => {
		const message = await requireOwn(ctx, await requireMember(ctx), messageId);
		text = text.trim();
		if (!text) throw new ConvexError("Write something first, or delete the message.");
		await ctx.db.patch(message._id, { text, parts: [{ type: "text", text }], editedAt: Date.now() });
	},
});

/** Keeps the row (threads hang off it) but clears its content and reactions. */
export const remove = mutation({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const message = await requireOwn(ctx, await requireMember(ctx), messageId);
		await ctx.db.patch(message._id, { text: "", parts: [], deleted: true });
		for (const r of await ctx.db
			.query("reactions")
			.withIndex("by_message", (q) => q.eq("messageId", messageId))
			.collect()) {
			await ctx.db.delete(r._id);
		}
	},
});

export const react = mutation({
	args: { messageId: v.id("chatMessages"), emoji: v.string() },
	handler: async (ctx, { messageId, emoji }) => {
		const member = await requireMember(ctx);
		const message = await ctx.db.get(messageId);
		if (!message || message.deleted) throw new ConvexError("Message not found.");
		await requireChat(ctx, member, message.chatId);
		emoji = emoji.trim();
		if (!emoji || emoji.length > 16) throw new ConvexError("Pick one emoji.");
		await toggleReaction(ctx, message, emoji, { userId: member.userId });
	},
});
