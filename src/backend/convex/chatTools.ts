import type { ChatLine, ChatResult } from "@companybot/core";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { type Namer, canSee, chatByRef, chatLabel, namer, reactionsOf, textForModel, toggleReaction } from "./chatOps";
import { runningTurn } from "./turns";

// ---- Chat tools (core's ChatStore), acting as the turn's person ----

export const reactFor = internalMutation({
	args: { turnId: v.id("agentTurns"), emoji: v.string() },
	handler: async (ctx, { turnId, emoji }): Promise<{ reacted: boolean } | { error: string }> => {
		const { turn } = await runningTurn(ctx, turnId);
		const trigger = await ctx.db.get(turn.triggerId);
		if (!trigger || trigger.deleted) return { error: "That message was deleted." };
		const clean = emoji.trim();
		if (!clean) return { error: "Pick an emoji." };
		return { reacted: await toggleReaction(ctx, trigger, clean, { agentId: turn.agentId }) };
	},
});

async function toLine(ctx: QueryCtx, m: Doc<"chatMessages">, names: Namer, label: string): Promise<ChatLine> {
	const author = (await names.of(m)).name;
	const reactions = new Map<string, string[]>();
	for (const r of await reactionsOf(ctx, m._id)) {
		reactions.set(r.emoji, [...(reactions.get(r.emoji) ?? []), (await names.of(r)).name]);
	}
	return {
		id: m._id,
		chat: label,
		...(m.threadId && { threadOf: m.threadId }),
		author,
		time: new Date(m._creationTime).toISOString(),
		text: textForModel(m, author),
		...(!m.threadId && m.replyCount && { replies: m.replyCount }),
		...(reactions.size > 0 && { reactions: [...reactions].map(([emoji, by]) => ({ emoji, by })) }),
	};
}

export const readFor = internalQuery({
	args: {
		turnId: v.id("agentTurns"),
		chat: v.optional(v.string()),
		threadOf: v.optional(v.string()),
		before: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member, chat: here } = await runningTurn(ctx, args.turnId);
		let chat: Doc<"chats"> | null = here;
		let threadId: Id<"chatMessages"> | undefined = args.chat ? undefined : turn.threadId;
		if (args.threadOf) {
			const id = ctx.db.normalizeId("chatMessages", args.threadOf);
			const message = id && (await ctx.db.get(id));
			chat = message ? await ctx.db.get(message.chatId) : null;
			if (!message || !chat || !(await canSee(ctx, chat, member))) return { error: `No message "${args.threadOf}" you can see.` };
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
				.withIndex("by_chat_thread", (q) => q.eq("chatId", chat._id).eq("threadId", threadId).lt("_creationTime", before))
				.order("desc")
				// Replies still being written (this one included) aren't history yet.
				.filter((q) => q.and(q.neq(q.field("deleted"), true), q.neq(q.field("status"), "streaming")))
				.take(limit)
		).reverse();
		const parent = threadId && (await ctx.db.get(threadId));
		const names = namer(ctx);
		const label = await chatLabel(ctx, chat, names, turn.agentId);
		const all = parent && !parent.deleted && parent._creationTime < before ? [parent, ...docs] : docs;
		return { messages: await Promise.all(all.map((m) => toLine(ctx, m, names, label))) };
	},
});

export const searchFor = internalQuery({
	args: { turnId: v.id("agentTurns"), query: v.string(), chat: v.optional(v.string()) },
	handler: async (ctx, args): Promise<ChatResult> => {
		const { turn, member } = await runningTurn(ctx, args.turnId);
		let chatId: Id<"chats"> | undefined;
		if (args.chat) {
			const chat = await chatByRef(ctx, member, args.chat);
			if (!chat) return { error: `No channel "${args.chat}" you can see.` };
			chatId = chat._id;
		}
		const found = await ctx.db
			.query("chatMessages")
			.withSearchIndex("search_text", (q) => {
				const s = q.search("text", args.query).eq("workspaceId", member.workspaceId);
				return chatId ? s.eq("chatId", chatId) : s;
			})
			.take(60);
		const names = namer(ctx);
		/** Each chat's label, or null if the person can't see it. */
		const labels = new Map<Id<"chats">, string | null>();
		const lines: ChatLine[] = [];
		for (const m of found) {
			if (m.deleted || lines.length >= 20) continue;
			if (!labels.has(m.chatId)) {
				const chat = await ctx.db.get(m.chatId);
				const ok = chat && !chat.archived && (await canSee(ctx, chat, member));
				labels.set(m.chatId, ok ? await chatLabel(ctx, chat, names, turn.agentId) : null);
			}
			const label = labels.get(m.chatId);
			if (label) lines.push(await toLine(ctx, m, names, label));
		}
		return { messages: lines };
	},
});
