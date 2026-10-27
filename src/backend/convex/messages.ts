import { fireEvent } from "./automationRuns";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import {
	type Namer,
	type Participant,
	addToChat,
	addUserMentions,
	agentOfDm,
	insertMessage,
	markChatRead,
	namer,
	reactionsOf,
	removeUserMentions,
	requireChat,
	toggleReaction,
	visibleChat,
} from "./chatOps";
import { type Who, type Member, memberOf, nameOf, requireMember } from "./lib";
import { noteMentions, workspaceRecords } from "./recordOps";
import type { messagePart, replyStats } from "./schema";
import { enqueueTurn } from "./turns";

// Messages in a chat's main timeline or a thread. See wiki/chat.md.

export type Message = {
	_id: Id<"chatMessages">;
	_creationTime: number;
	chatId: Id<"chats">;
	threadId: Id<"chatMessages"> | null;
	author: Participant;
	text: string;
	/**
	 * Without approval cards, which apps from before approvals can't show (they get a line of text instead).
	 * COMPAT(0.1.0-alpha.6): once installs are past it, send approval cards in `parts` too and switch the app to `parts`; delete `fullParts` one release later.
	 */
	parts: Infer<typeof messagePart>[];
	/** Every part, approval cards included. Apps that know approvals read this. */
	fullParts: Infer<typeof messagePart>[];
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
	/** Set when an automation posted this for its author. */
	automation: { id: string; name: string } | null;
};

const LIST_LIMIT = 200;

/** The newest 200 of the main timeline, or of a thread (parent first), oldest first. */
export const list = query({
	args: { chatId: v.id("chats"), threadId: v.optional(v.id("chatMessages")) },
	handler: async (ctx, { chatId, threadId }): Promise<Message[]> => {
		const visible = await visibleChat(ctx, chatId);
		if (!visible) return [];
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
		return Promise.all((parent ? [parent, ...docs] : docs).map((m) => toMessage(ctx, m, visible.member, names)));
	},
});

async function toMessage(ctx: QueryCtx, m: Doc<"chatMessages">, member: Member, names: Namer): Promise<Message> {
	const reactions: Message["reactions"] = [];
	for (const r of await reactionsOf(ctx, m._id)) {
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
		parts: m.parts.map((p) =>
			p.type === "approval" ? { type: "text" as const, text: `_Waiting for approval to run ${p.tool}. Update Companybot to approve or deny it._` } : p,
		),
		fullParts: m.parts,
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
		automation: m.automation ?? null,
	};
}

/**
 * Posts a message (joining a public channel if needed) and queues agent turns:
 * every message in an agent DM, otherwise each @mentioned agent. A top-level channel
 * message also starts automations watching that channel.
 */
const sendMessageArgs = v.object({
		chatId: v.id("chats"),
		threadId: v.optional(v.id("chatMessages")),
		text: v.string(),
		/** `recordIds`: records the message references, so they can show where they were discussed. */
		mentions: v.object({
			userIds: v.array(v.id("users")),
			agentIds: v.array(v.id("agents")),
			recordIds: v.optional(v.array(v.id("records"))),
		}),
	});

export const send = mutation({
	args: sendMessageArgs.fields,
	handler: async (ctx, args) => sendMessage(ctx, { member: await requireMember(ctx) }, args),
});

export async function sendMessage(ctx: MutationCtx, who: Who, { chatId, threadId, text, mentions }: Infer<typeof sendMessageArgs>): Promise<Id<"chatMessages">> {
	const { member } = who;
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
		if (await memberOf(ctx, id, member.workspaceId)) userIds.push(id);
	}
	const agentIds: Id<"agents">[] = [];
	for (const id of new Set(mentions.agentIds)) {
		const agent = await ctx.db.get(id);
		if (agent?.workspaceId === member.workspaceId && !agent.archived) agentIds.push(id);
	}

	const recordIds = await workspaceRecords(ctx, member.workspaceId, mentions.recordIds ?? []);

	const dmAgent = agentOfDm(chat);
	if (dmAgent && (await ctx.db.get(dmAgent))?.archived) throw new ConvexError("This agent is archived.");

	const messageId = await insertMessage(ctx, chat, {
		threadId,
		...(who.agentId ? { authorAgentId: who.agentId, actingFor: member.userId } : { authorUserId: member.userId }),
		text,
		parts: [{ type: "text", text }],
		mentions: { userIds, agentIds, ...(recordIds.length > 0 && { recordIds }) },
		status: "done",
	});
	await addUserMentions(ctx, (await ctx.db.get(messageId))!);
	await noteMentions(ctx, { _id: messageId, chatId }, recordIds);
	if (!who.agentId && !threadId) await markChatRead(ctx, chatId, member.userId);

	if (who.agentId) return messageId;

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
	// People's top-level channel messages can start automations. Agents' and automations'
	// posts don't go through here, so automations can't set each other off.
	if (chat.kind === "channel" && !threadId) {
		await fireEvent(ctx, chat.workspaceId, "message.posted", {
			channelId: chatId,
			messageId,
			data: { channel: `#${chat.name}`, author: await nameOf(ctx, member.userId), text },
		});
	}
	return messageId;
}
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
		for (const r of await reactionsOf(ctx, messageId)) await ctx.db.delete(r._id);
		await removeUserMentions(ctx, messageId);
		// Records no longer list it where they were discussed.
		for await (const m of ctx.db.query("recordMentions").withIndex("by_message", (q) => q.eq("messageId", messageId))) await ctx.db.delete(m._id);
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
