import type { ChatLine, ChatResult } from "@companybot/core";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation } from "./_generated/server";
import { type Namer, canSee, label as authorLabel, chatByRef, chatLabel, namer, reactionGroups, recentVisibleChats, shownAt, textForModel } from "./chatOps";
import { filesForModel } from "./files";
import { asToolResult } from "./lib";
import { chatAccess } from "./placeAccess";
import { canReadReply, readReply } from "./replyPrivacy";
import { type RecordTags, recordTags } from "./recordTags";
import { notePlace } from "./replySources";
import { runningTurn } from "./turns";

// ---- Chat tools (core's ChatStore), acting as the turn's person ----

async function toLine(ctx: QueryCtx, m: Doc<"chatMessages">, names: Namer, label: string, tags: RecordTags): Promise<ChatLine> {
	const author = authorLabel(await names.of(m));
	const reactions = await reactionGroups(ctx, m._id, names);
	return {
		id: m._id,
		chat: label,
		...(m.threadId && { threadOf: m.threadId }),
		author,
		time: new Date(m._creationTime).toISOString(),
		text: textForModel({ ...m, text: await tags.forModel(m.text) }, author),
		...(!m.threadId && m.replyCount && { replies: m.replyCount }),
		...(reactions.length > 0 && { reactions }),
		...(m.attachments?.length && { files: filesForModel(m) }),
	};
}

export const readFor = internalMutation({
	args: {
		turnId: v.id("agentTurns"),
		chat: v.optional(v.string()),
		threadOf: v.optional(v.string()),
		before: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member, chat: here } = await runningTurn(ctx, args.turnId);
		return asToolResult(async (): Promise<ChatResult> => {
		let chat: Doc<"chats"> | null = here;
		let threadId: Id<"chatMessages"> | undefined = args.chat ? undefined : turn.threadId;
		if (args.threadOf) {
			const id = ctx.db.normalizeId("chatMessages", args.threadOf);
			const message = id && (await ctx.db.get(id));
			chat = message ? await ctx.db.get(message.chatId) : null;
			if (!message || !chat || !(await canSee(ctx, chat, member)) || !(await readReply(ctx, member, message))) return { error: `No message "${args.threadOf}" you can see.` };
			threadId = message.threadId ?? message._id;
		} else if (args.chat) {
			chat = await chatByRef(ctx, member, args.chat);
			if (!chat) return { error: `No channel "${args.chat}" you can see.` };
		}
		const before = args.before ? Date.parse(args.before) : Number.POSITIVE_INFINITY;
		if (Number.isNaN(before)) return { error: "`before` must be an ISO time." };
		const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
		const docs = (
			await ctx.db
				.query("chatMessages")
				.withIndex("by_chat_thread_quiet", (q) => q.eq("chatId", chat._id).eq("threadId", threadId).eq("quiet", undefined).lt("_creationTime", before))
				.order("desc")
				// Replies still being written (this one included) aren't history yet.
				.filter((q) => q.and(q.neq(q.field("deleted"), true), q.neq(q.field("status"), "streaming")))
				.take(limit)
		).sort((a, b) => shownAt(a) - shownAt(b));
		const parent = threadId && (await ctx.db.get(threadId));
		const names = namer(ctx);
		const label = await chatLabel(ctx, chat, names, turn.agentId);
		const all = parent && !parent.deleted && parent._creationTime < before ? [parent, ...docs] : docs;
		const visible = [];
		for (const m of all) if (await readReply(ctx, member, m)) visible.push(m);
		const tags = recordTags(ctx, member);
		return { messages: await Promise.all(visible.map((m) => toLine(ctx, m, names, label, tags))) };
		});
	},
});

export const searchFor = internalMutation({
	args: { turnId: v.id("agentTurns"), query: v.string(), chat: v.optional(v.string()) },
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member } = await runningTurn(ctx, args.turnId);
		return asToolResult(async (): Promise<ChatResult> => {
		let chatId: Id<"chats"> | undefined;
		if (args.chat) {
			const chat = await chatByRef(ctx, { ...member, replyId: undefined }, args.chat);
			if (!chat) return { error: `No channel "${args.chat}" you can see.` };
			chatId = chat._id;
		}
		const discovery = chatId ? { chats: [], truncated: false } : await recentVisibleChats(ctx, member, 50, true);
		// At most 600 message reads, sharing 500 private candidates across discovered chats.
		const privateHits = Math.min(100, Math.floor(500 / Math.max(1, discovery.chats.length)));
		const streams = chatId
			? [await ctx.db.query("chatMessages").withSearchIndex("search_text", (q) => q.search("text", args.query).eq("workspaceId", member.workspaceId).eq("chatId", chatId!)).take(100)]
			: await Promise.all([
				ctx.db.query("chatMessages").withSearchIndex("search_text", (q) => q.search("text", args.query).eq("workspaceId", member.workspaceId).eq("searchPublic", true)).take(100),
				...discovery.chats.map((chat) => ctx.db.query("chatMessages").withSearchIndex("search_text", (q) => q.search("text", args.query).eq("workspaceId", member.workspaceId).eq("chatId", chat._id)).take(privateHits)),
			]);
		const terms = args.query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
		// Search indexes rank within each stream; compare lexical relevance across streams,
		// using exact terms/phrases before prefixes, with only a small current-chat tie boost.
		const score = (m: Doc<"chatMessages">) => {
			const text = m.text.toLocaleLowerCase();
			const words: string[] = text.match(/[\p{L}\p{N}]+/gu) ?? [];
			const exact = terms.filter((term) => words.includes(term)).length;
			const prefix = terms.filter((term) => words.some((word) => word.startsWith(term))).length;
			return exact * 10 + prefix + (text.includes(terms.join(" ")) ? 5 : 0) + 1 / (words.length + 1) + (m.chatId === turn.chatId ? 0.01 : 0);
		};
		const found = streams.flat().sort((a, b) => score(b) - score(a));
		const names = namer(ctx);
		const tags = recordTags(ctx, member);
		/** Each chat's label, or null if the person can't see it. */
		const labels = new Map<Id<"chats">, string | null>();
		const lines: ChatLine[] = [];
		for (const m of found.slice(0, 100)) {
			if (lines.length >= 20) break;
			if (m.deleted || m.quiet) continue;
			if (!labels.has(m.chatId)) {
				const chat = await ctx.db.get(m.chatId);
				const ok = chat && !chat.archived && (await canSee(ctx, chat, { ...member, replyId: undefined }));
				labels.set(m.chatId, ok ? await chatLabel(ctx, chat, names, turn.agentId) : null);
			}
			const label = labels.get(m.chatId);
			if (!label || !(await canReadReply(ctx, member, m))) continue;
			const chat = (await ctx.db.get(m.chatId))!;
			await notePlace(ctx, member, chat._id, chatAccess(chat), chat.private);
			await readReply(ctx, member, m);
			lines.push(await toLine(ctx, m, names, label, tags));
		}
		return { messages: lines, ...(chatId && found.length >= 100 && { notice: "Searched the first 100 matching messages in this chat; search read limits may omit other matches." }), ...(!chatId && (discovery.truncated || found.length > 100 || streams.some((stream, i) => stream.length >= (i === 0 ? 100 : privateHits))) && { notice: `Searched public channels and your ${discovery.chats.length} most recent private chats. Search read limits may omit older matches; specify a chat to search its history.` }) };
		});
	},
});
