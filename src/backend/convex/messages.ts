import { fireEvent } from "./automationRuns";
import { completeSteps } from "./onboarding";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
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
	replyAuthorsOf,
	requireChat,
	toggleReaction,
	visibleChat,
} from "./chatOps";
import { type Who, type Member, memberOf, nameOf, requireMember } from "./lib";
import { noteMentions, workspaceRecords } from "./recordOps";
import { installOf } from "./skills";
import type { messagePart, replyStats } from "./schema";
import { internal } from "./_generated/api";
import { enqueueTurn, streamOf } from "./turns";
import { stopTyping } from "./typing";
import { claimFiles, deleteAttachments } from "./files";
import type { fileInfo } from "./schema";

// Messages in a chat's main timeline or a thread. See wiki/chat.md.

export type Message = {
	_id: Id<"chatMessages">;
	_creationTime: number;
	chatId: Id<"chats">;
	threadId: Id<"chatMessages"> | null;
	author: Participant;
	text: string;
	/** Every part, approval cards included. */
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
	/** Set when an automation posted this for its author. */
	automation: { id: string; name: string } | null;
	/** Attached files, with URLs to show or download them (null if the file is gone). */
	attachments: (Infer<typeof fileInfo> & { url: string | null })[];
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
		const names = namer(ctx, { images: true });
		return Promise.all((parent ? [parent, ...docs] : docs).map((m) => toMessage(ctx, m, visible.member, names)));
	},
});

/** A streaming reply's content so far, or null once it ended (then it's on the message). */
export const stream = query({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "streaming" || !(await visibleChat(ctx, message.chatId))) return null;
		const stream = await streamOf(ctx, messageId);
		return { text: stream?.text ?? "", parts: stream?.parts ?? [] };
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
	const replyAuthors: Participant[] = m.threadId ? [] : await Promise.all((await replyAuthorsOf(ctx, m)).map(names.of));
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
		automation: m.automation ?? null,
		attachments: await Promise.all((m.attachments ?? []).map(async ({ storageId, ...file }) => ({ ...file, url: await ctx.storage.getUrl(storageId) }))),
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
		/** `recordIds`: records the message references, so they can show where they were discussed. `skillIds`: skills named with `/`, for the agents to load. */
		mentions: v.object({
			userIds: v.array(v.id("users")),
			agentIds: v.array(v.id("agents")),
			recordIds: v.optional(v.array(v.id("records"))),
			skillIds: v.optional(v.array(v.string())),
		}),
		/** Your uploads (files.ts), in order. A message with files needs no text. */
		attachments: v.optional(v.array(v.id("_storage"))),
	});

export const send = mutation({
	args: sendMessageArgs.fields,
	handler: async (ctx, args) => sendMessage(ctx, { member: await requireMember(ctx) }, args),
});

export async function sendMessage(ctx: MutationCtx, who: Who, { chatId, threadId, text, mentions, attachments: files = [] }: Infer<typeof sendMessageArgs>): Promise<Id<"chatMessages">> {
	const { member } = who;
	const chat = await requireChat(ctx, member, chatId);
	if (chat.archived) throw new ConvexError("This channel is in Trash.");
	text = text.trim();
	if (!text && files.length === 0) throw new ConvexError("Write something first.");
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
	// Only skills installed here (and not in Trash), so a message can't point agents at a made-up one.
	const skillIds: string[] = [];
	for (const id of new Set(mentions.skillIds ?? [])) {
		if (await installOf(ctx, member.workspaceId, id)) skillIds.push(id);
	}

	const dmAgent = agentOfDm(chat);
	if (dmAgent && (await ctx.db.get(dmAgent))?.archived) throw new ConvexError("This agent is in Trash.");
	// Last: a refused message keeps its uploads, to attach again.
	const attachments = await claimFiles(ctx, member, files);

	const messageId = await insertMessage(ctx, chat, {
		threadId,
		...(who.agentId ? { authorAgentId: who.agentId, actingFor: member.userId } : { authorUserId: member.userId }),
		text,
		parts: text ? [{ type: "text", text }] : [],
		...(attachments.length > 0 && { attachments }),
		mentions: { userIds, agentIds, ...(recordIds.length > 0 && { recordIds }), ...(skillIds.length > 0 && { skillIds }) },
		status: "done",
	});
	await addUserMentions(ctx, (await ctx.db.get(messageId))!);
	await noteMentions(ctx, { _id: messageId, chatId }, recordIds);
	if (!who.agentId) await stopTyping(ctx, chatId, threadId, member.userId);
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
	// The tutorial: steps count only when they did what the step teaches (an agent answers a mention).
	await completeSteps(ctx, member, [threadId && "thread", dmAgent ? "dm" : responders.length > 0 && "mention"]);
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
async function requireOwn(ctx: QueryCtx, who: Who, messageId: Id<"chatMessages">) {
	const { member } = who;
	const message = await ctx.db.get(messageId);
	if (!message || message.workspaceId !== member.workspaceId || message.deleted) throw new ConvexError("Message not found.");
	await requireChat(ctx, member, message.chatId);
	if (message.authorUserId !== member.userId && !(who.agentId && message.authorAgentId === who.agentId && message.actingFor === member.userId)) throw new ConvexError("You can only change your own messages.");
	return message;
}

export const edit = mutation({
	args: { messageId: v.id("chatMessages"), text: v.string() },
	handler: async (ctx, { messageId, text }) => editMessage(ctx, { member: await requireMember(ctx) }, messageId, text),
});

/** Keeps the row (threads hang off it) but clears its content and reactions. */
export const remove = mutation({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => removeMessage(ctx, { member: await requireMember(ctx) }, messageId),
});

export const react = mutation({
	args: { messageId: v.id("chatMessages"), emoji: v.string() },
	handler: async (ctx, { messageId, emoji }) => reactMessage(ctx, { member: await requireMember(ctx) }, messageId, emoji),
});

export async function editMessage(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">, text: string) {
	const message = await requireOwn(ctx, who, messageId);
	text = text.trim();
	if (!text && !message.attachments?.length) throw new ConvexError("Write something first, or delete the message.");
	await ctx.db.patch(message._id, { text, parts: text ? [{ type: "text", text }] : [], editedAt: Date.now() });
}

export async function removeMessage(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">) {
	const message = await requireOwn(ctx, who, messageId);
	await deleteAttachments(ctx, message);
	await ctx.db.patch(message._id, { text: "", parts: [], attachments: undefined, deleted: true });
	await clearMessageLinks(ctx, messageId);
}

export async function reactMessage(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">, emoji: string) {
	const { member } = who;
	const message = await ctx.db.get(messageId);
	if (!message || message.deleted) throw new ConvexError("Message not found.");
	await requireChat(ctx, member, message.chatId);
	emoji = emoji.trim();
	if (!emoji || emoji.length > 16) throw new ConvexError("Pick one emoji.");
	return toggleReaction(ctx, message, emoji, who.agentId ? { agentId: who.agentId } : { userId: member.userId });
}

/** Deleted content disappears immediately; mentions and reactions drain in bounded batches. */
async function clearMessageLinks(ctx: MutationCtx, messageId: Id<"chatMessages">) {
	let more = false;
	for (const table of ["reactions", "userMentions", "recordMentions"] as const) {
		const rows = await ctx.db.query(table).withIndex("by_message", (q) => q.eq("messageId", messageId)).take(100);
		for (const row of rows) await ctx.db.delete(row._id);
		more ||= rows.length === 100;
	}
	if (more) await ctx.scheduler.runAfter(0, internal.messages.clearRemovedMessage, { messageId });
}

export const clearRemovedMessage = internalMutation({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		if ((await ctx.db.get(messageId))?.deleted) await clearMessageLinks(ctx, messageId);
	},
});
