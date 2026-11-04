import { emojiOf } from "@companybot/core";
import { previewUrl } from "@companybot/core/link-preview";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import { fireEvent } from "./automationRuns";
import { resetChains } from "./chains";
import {
	type Namer,
	type Participant,
	addToChat,
	addUserMentions,
	agentOfDm,
	chatMembersOf,
	titleFrom,
	insertMessage,
	markChatRead,
	namer,
	reactionsOf,
	replyAuthorsOf,
	requireChat,
	requirePost,
	requireReactionAudience,
	shownAt,
	toggleReaction,
	visibleChat,
} from "./chatOps";
import { claimFiles, deleteAttachments } from "./files";
import { type Who, type Member, canSeeSkill, memberOf, nameOf, requireMember } from "./lib";
import { type LinkPreview, previewMessage, previewRow, previewsOf } from "./linkPreviews";
import { completeSteps } from "./onboarding";
import { noteMentions, workspaceRecords } from "./recordOps";
import { canReadReplyDetails, genericToolParts, canReadReply, maskedReply, replyPrivacy, type ReplyPrivacy } from "./replyPrivacy";
import { readArtifact, writeSources } from "./replySources";
import { routeLater } from "./router";
import type { messagePart, replyStats } from "./schema";
import type { fileInfo } from "./schema";
import { installOf } from "./skills";
import { enqueueTurn, queueFollowUps, streamOf } from "./turns";
import { stopTyping } from "./typing";

// Messages in a chat's main timeline or a thread. See wiki/chat.md.

export type Message = {
	privacy?: ReplyPrivacy | null;
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
	/** An agent reply someone stopped partway (turns.stop): who. */
	stoppedBy: string | null;
	stats: Infer<typeof replyStats> | null;
	editedAt: number | null;
	deleted: boolean;
	mine: boolean;
	replyCount: number;
	lastReplyAt: number | null;
	/** Up to 3 people or agents who replied in the thread, most recent first. */
	replyAuthors: Participant[];
	/** Grouped by emoji, in the order first used. `people`: who reacted, oldest first. */
	reactions: {
		emoji: string;
		count: number;
		mine: boolean;
		people: Participant[];
		/** COMPAT(0.1.0-alpha.10): alpha.9 apps read `names` (their chips' title); delete it. */
		names: string[];
	}[];
	/** Set when an automation posted this for its author. */
	automation: { id: string; name: string } | null;
	/** Attached files, with URLs to show or download them (null if the file is gone). */
	attachments: (Infer<typeof fileInfo> & { url: string | null })[];
	/** Cards for its first links (linkPreviews.ts), without ones its sender hid. */
	linkPreviews: LinkPreview[];
	/**
	 * Set on a paused line (chains.ts): agents stopped at a limit. `for`: the person they work for,
	 * the only one who can Continue or Stop (`canDecide`). `by`: who did.
	 */
	pause: { status: "paused" | "continued" | "stopped"; for: string; by: string | null; canDecide: boolean } | null;
	/** An agent's ask of another (chat.ask_agent): who asked whom. Kept out of the timeline; its thread shows read-only. */
	ask: { from: string; to: string } | null;
};

const LIST_LIMIT = 200;

/**
 * The newest 200 of the main timeline, or of a thread (parent first), in the order they were shown
 * (chatOps `shownAt`): a reply sits below every message it took in.
 */
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
				// Replies not shown yet (turns.ts `show`), and asks.
				.filter((q) => q.neq(q.field("quiet"), true))
				.take(LIST_LIMIT)
		).sort((a, b) => shownAt(a) - shownAt(b));
		const names = namer(ctx, { images: true });
		return Promise.all((parent ? [parent, ...docs] : docs).map((m) => toMessage(ctx, m, visible.member, names)));
	},
});

/** A streaming reply's content so far, or null once it ended (then it's on the message). */
export const stream = query({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "streaming") return null;
		const visible = await visibleChat(ctx, message.chatId);
		if (!visible) return null;
		const privacy = await replyPrivacy(ctx, visible.member, message);
		if (privacy?.hidden) return { text: `🔒 ${privacy.label}`, parts: [], privacy };
		const stream = await streamOf(ctx, messageId);
		return { text: stream?.text ?? "", parts: stream?.parts ?? [], ...(privacy && { privacy }) };
	},
});

async function toMessage(ctx: QueryCtx, m: Doc<"chatMessages">, member: Member, names: Namer): Promise<Message> {
	const privacy = await replyPrivacy(ctx, member, m);
	if (privacy?.hidden) m = maskedReply(m, privacy.label);
	const reactions: Message["reactions"] = [];
	for (const r of privacy?.hidden ? [] : await reactionsOf(ctx, m._id)) {
		let group = reactions.find((g) => g.emoji === r.emoji);
		if (!group) reactions.push((group = { emoji: r.emoji, count: 0, mine: false, people: [], names: [] }));
		group.count++;
		group.mine ||= r.userId === member.userId;
		const who = await names.of(r);
		group.people.push(who);
		group.names.push(who.name);
	}
	const replyAuthors: Participant[] = m.threadId || privacy?.hidden ? [] : await Promise.all((await replyAuthorsOf(ctx, m)).map(names.of));
	return {
		privacy,
		_id: m._id,
		_creationTime: m._creationTime,
		chatId: m.chatId,
		threadId: m.threadId ?? null,
		author: await names.of(m),
		text: m.text,
		parts: m.sharedBy && !(await canReadReplyDetails(ctx, member, m)) ? genericToolParts(m.parts) : m.parts,
		status: m.status,
		error: m.error ?? null,
		stoppedBy: m.stoppedBy ? await nameOf(ctx, m.stoppedBy) : null,
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
		linkPreviews: await previewsOf(ctx, m),
		pause: await pauseOf(ctx, m, member, names),
		// Only an ask is quiet and still listed: as its thread's parent.
		ask: m.quiet && m.authorAgentId ? { from: (await names.agent(m.authorAgentId)).name, to: (await names.agent(m.mentions.agentIds[0]!)).name } : null,
	};
}

async function pauseOf(ctx: QueryCtx, m: Doc<"chatMessages">, member: Member, names: Namer): Promise<Message["pause"]> {
	if (!m.pause) return null;
	const chain = await ctx.db.get(m.pause.chainId);
	const actorId = chain?.actorId;
	return {
		status: m.pause.status,
		for: actorId ? (await names.user(actorId)).name : "",
		by: m.pause.by ? (await names.user(m.pause.by)).name : null,
		canDecide: m.pause.status === "paused" && actorId === member.userId,
	};
}

/**
 * Posts a message (joining a public channel if needed) and queues agent turns:
 * every message in an agent DM, otherwise each @mentioned agent. In a "When relevant"
 * channel, one that mentions no agent goes to the router (router.ts). A top-level channel
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
	if (chat.archived) throw new ConvexError("This chat is in Archive.");
	requirePost(member, chat);
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

	const recordIds = await workspaceRecords(ctx, member, mentions.recordIds ?? []);
	// Only skills installed here (and not in Archive), so a message can't point agents at a made-up one.
	const skillIds: string[] = [];
	for (const id of new Set(mentions.skillIds ?? [])) {
		const install = await installOf(ctx, member.workspaceId, id);
		if (install && canSeeSkill(member.userId, install) && await readArtifact(ctx, member, install, install.audience === "personal" ? install.ownerId : undefined)) skillIds.push(id);
	}

	// An agent writes as its person (`actingFor`), except to that person alone: there it's just the agent talking.
	const actingFor = who.agentId && !(await onlyPerson(ctx, chat, member.userId)) ? member.userId : undefined;
	const dmAgent = agentOfDm(chat);
	if (dmAgent && (await ctx.db.get(dmAgent))?.archived) throw new ConvexError("This agent is in Archive.");
	// A side chat takes its name from the person's first message.
	if (chat.parentId && !chat.title && !threadId && !who.agentId) await ctx.db.patch(chat._id, { title: titleFrom(text) });
	// Last: a refused message keeps its uploads, to attach again.
	const attachments = await claimFiles(ctx, member, files);

	const usedPlaces = await writeSources(ctx, member, { filtered: true });
	const messageId = await insertMessage(ctx, chat, {
		...(usedPlaces.length && { usedPlaces, repliedTo: member.userId }),
		threadId,
		...(who.agentId ? { authorAgentId: who.agentId, ...(actingFor && { actingFor }) } : { authorUserId: member.userId }),
		text,
		parts: text ? [{ type: "text", text }] : [],
		...(attachments.length > 0 && { attachments }),
		mentions: { userIds, agentIds, ...(recordIds.length > 0 && { recordIds }), ...(skillIds.length > 0 && { skillIds }) },
		status: "done",
	});
	const sent = (await ctx.db.get(messageId))!;
	await addUserMentions(ctx, sent);
	await previewMessage(ctx, sent);
	await noteMentions(ctx, { _id: messageId, chatId }, recordIds);
	if (!who.agentId) await stopTyping(ctx, chatId, threadId, member.userId);
	// A person writing where agents are handing work around gives those chains a fresh budget.
	if (!who.agentId) await resetChains(ctx, chatId, threadId);
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
		await enqueueTurn(ctx, chat, { agentId, chatId, threadId, triggerId: messageId, actorId: member.userId, person: true });
	}
	// Any message you send here reaches an agent already replying to you here, @mention or not.
	await queueFollowUps(ctx, chat, sent, responders);
	// The router still weighs it for the other agents (router.apply skips the ones it already reached).
	if (agentIds.length === 0) await routeLater(ctx, chat, sent);
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
/** A DM whose only person is `userId` (with agents, or nobody else). */
async function onlyPerson(ctx: QueryCtx, chat: Doc<"chats">, userId: Id<"users">) {
	return chat.kind === "dm" && (await chatMembersOf(ctx, chat._id)).every((m) => !m.userId || m.userId === userId);
}

/** Your own message, not deleted: an agent's own too, if it wrote it as you or to you alone. */
async function requireOwn(ctx: QueryCtx, who: Who, messageId: Id<"chatMessages">) {
	const { member } = who;
	const message = await ctx.db.get(messageId);
	if (!message || message.workspaceId !== member.workspaceId || message.deleted) throw new ConvexError("Message not found.");
	const chat = await requireChat(ctx, member, message.chatId);
	const agents = who.agentId !== undefined && message.authorAgentId === who.agentId;
	const allowed =
		message.authorUserId === member.userId ||
		(agents && (message.actingFor === member.userId || (!message.actingFor && (await onlyPerson(ctx, chat, member.userId)))));
	if (!allowed) throw new ConvexError("You can only change your own messages.");
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

/** Takes down the card for one of your message's links (an agent's too, if it wrote it for you). The link stays in the text. */
export const hidePreview = mutation({
	args: { messageId: v.id("chatMessages"), url: v.string() },
	handler: async (ctx, { messageId, url }) => hideMessagePreview(ctx, { member: await requireMember(ctx) }, messageId, url),
});

/** Toggles your reaction. Agents react only through their turn's decision (turns.finishReply). */
export const react = mutation({
	args: { messageId: v.id("chatMessages"), emoji: v.string() },
	handler: async (ctx, { messageId, emoji }) => {
		const member = await requireMember(ctx);
		const message = await ctx.db.get(messageId);
		if (!message || message.deleted) throw new ConvexError("Message not found.");
		await requireReactionAudience(ctx, member, message);
		const one = emojiOf(emoji.trim());
		if (!one) throw new ConvexError("Pick one emoji.");
		return toggleReaction(ctx, message, one, member.userId);
	},
});

export async function editMessage(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">, text: string) {
	const message = await requireOwn(ctx, who, messageId);
	// Deleting your own message stays open in a channel that turned read-only; changing it doesn't.
	requirePost(who.member, (await ctx.db.get(message.chatId))!);
	text = text.trim();
	if (!text && !message.attachments?.length) throw new ConvexError("Write something first, or delete the message.");
	const sources = await writeSources(ctx, who.member, { filtered: true }, message);
	await ctx.db.patch(message._id, { text, parts: text ? [{ type: "text", text }] : [], editedAt: Date.now(), sharedBy: undefined, usedPlaces: sources.length ? sources : undefined, ...(sources.length && { repliedTo: who.member.userId }) });
	await previewMessage(ctx, { ...message, text }, { byAgent: !!who.agentId });
}

export async function hideMessagePreview(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">, url: string) {
	const message = await requireOwn(ctx, who, messageId);
	const key = previewUrl(url);
	const row = key && (await previewRow(ctx, message.workspaceId, key));
	const cards = message.linkPreviews ?? [];
	if (!row || !cards.some((p) => p.previewId === row._id)) throw new ConvexError("That message has no preview for that link.");
	await ctx.db.patch(message._id, { linkPreviews: cards.map((p) => (p.previewId === row._id ? { ...p, hidden: true } : p)) });
}

export async function removeMessage(ctx: MutationCtx, who: Who, messageId: Id<"chatMessages">) {
	const message = await requireOwn(ctx, who, messageId);
	await deleteAttachments(ctx, message);
	await ctx.db.patch(message._id, { text: "", parts: [], attachments: undefined, linkPreviews: undefined, deleted: true });
	await clearMessageLinks(ctx, messageId);
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

/** Sharing is an explicit disclosure of this turn, never a change to the source's access list. */
export const share = mutation({
	args: { messageId: v.id("chatMessages") },
	handler: async (ctx, { messageId }) => {
		const member = await requireMember(ctx);
		const message = await ctx.db.get(messageId);
		if (!message || message.deleted) throw new ConvexError("Reply not found.");
		requirePost(member, await requireChat(ctx, member, message.chatId));
		if (!(await canReadReply(ctx, member, message))) throw new ConvexError("You can't see this reply.");
		if (!message.usedPlaces?.length || message.sharedBy) return;
		if (message.status === "streaming") throw new ConvexError("Wait until the reply finishes before sharing it.");
		await ctx.db.patch(messageId, { sharedBy: member.userId });
	},
});
