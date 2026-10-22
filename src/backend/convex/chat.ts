import { defaultAgents } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { getMember, installedSkills, requireMember } from "./lib";

/** A reply stuck this long (e.g. the action crashed) no longer blocks new messages. */
const STALE_REPLY_MS = 5 * 60_000;

async function findConversation(ctx: QueryCtx, userId: Id<"users">, agentId: string) {
	return ctx.db
		.query("conversations")
		.withIndex("by_user_agent", (q) => q.eq("userId", userId).eq("agentId", agentId))
		.first();
}

const messagesOf = (ctx: QueryCtx, conversationId: Id<"conversations">) =>
	ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId));

export const messages = query({
	args: { agentId: v.string() },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const conversation = await findConversation(ctx, member.userId, agentId);
		if (!conversation) return [];
		return (await messagesOf(ctx, conversation._id).order("desc").take(200)).reverse();
	},
});

export const send = mutation({
	args: { agentId: v.string(), text: v.string() },
	handler: async (ctx, { agentId, text }) => {
		const member = await requireMember(ctx);
		if (!defaultAgents.some((a) => a.id === agentId)) throw new ConvexError("Unknown agent.");
		if (!text.trim()) return;

		let conversation = await findConversation(ctx, member.userId, agentId);
		if (!conversation) {
			const id = await ctx.db.insert("conversations", {
				workspaceId: member.workspaceId,
				userId: member.userId,
				agentId,
				busy: false,
			});
			conversation = (await ctx.db.get(id))!;
		}

		// One reply at a time per conversation.
		if (conversation.busy) {
			const last = await messagesOf(ctx, conversation._id).order("desc").first();
			const stale = last && Date.now() - last._creationTime > STALE_REPLY_MS;
			if (!stale) throw new ConvexError("Still replying — wait a moment.");
			if (last?.status === "streaming") await ctx.db.patch(last._id, { status: "error", error: "Reply timed out." });
		}

		await ctx.db.insert("messages", { conversationId: conversation._id, role: "user", text: text.trim(), tools: [], status: "done" });
		const replyId = await ctx.db.insert("messages", {
			conversationId: conversation._id,
			role: "assistant",
			text: "",
			tools: [],
			status: "streaming",
		});
		await ctx.db.patch(conversation._id, { busy: true });
		await ctx.scheduler.runAfter(0, internal.agent.respond, { conversationId: conversation._id, replyId });
	},
});

// ---- Internal: used by the agent runner ----

/** Everything the agent needs for one turn: who it's helping, the summary, and recent messages. */
export const turnContext = internalQuery({
	args: { conversationId: v.id("conversations"), replyId: v.id("messages") },
	handler: async (ctx, { conversationId, replyId }) => {
		const conversation = await ctx.db.get(conversationId);
		if (!conversation) throw new Error("Conversation not found.");
		const row = await ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", conversation.userId))
			.first();
		if (!row || row.workspaceId !== conversation.workspaceId) throw new Error("Person is no longer a member.");
		const user = await ctx.db.get(conversation.userId);
		const recent = await unsummarized(ctx, conversation);
		return {
			member: { userId: row.userId, workspaceId: row.workspaceId, role: row.role },
			email: user?.email ?? "",
			agentId: conversation.agentId,
			skills: await installedSkills(ctx, conversation.workspaceId),
			summary: conversation.summary ?? null,
			history: recent.filter((m) => m._id !== replyId && m.status === "done").map(({ role, text }) => ({ role, text })),
		};
	},
});

async function unsummarized(ctx: QueryCtx, conversation: Doc<"conversations">) {
	return ctx.db
		.query("messages")
		.withIndex("by_conversation", (q) =>
			q.eq("conversationId", conversation._id).gt("_creationTime", conversation.summarizedUpTo ?? 0),
		)
		.collect();
}

export const updateReply = internalMutation({
	args: {
		replyId: v.id("messages"),
		text: v.string(),
		tools: v.array(
			v.object({
				id: v.string(),
				name: v.string(),
				status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
			}),
		),
	},
	handler: async (ctx, { replyId, text, tools }) => {
		await ctx.db.patch(replyId, { text, tools });
	},
});

export const finishReply = internalMutation({
	args: {
		conversationId: v.id("conversations"),
		replyId: v.id("messages"),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { conversationId, replyId, error }) => {
		await ctx.db.patch(replyId, error ? { status: "error", error } : { status: "done" });
		await ctx.db.patch(conversationId, { busy: false });
	},
});

/** Messages to fold into the summary, oldest first, leaving the newest `keep` untouched. */
export const compactionInput = internalQuery({
	args: { conversationId: v.id("conversations"), keep: v.number(), trigger: v.number() },
	handler: async (ctx, { conversationId, keep, trigger }) => {
		const conversation = await ctx.db.get(conversationId);
		if (!conversation) return null;
		const recent = (await unsummarized(ctx, conversation)).filter((m) => m.status === "done");
		if (recent.length <= trigger) return null;
		const old = recent.slice(0, recent.length - keep);
		return {
			summary: conversation.summary ?? null,
			messages: old.map(({ role, text }) => ({ role, text })),
			upTo: old.at(-1)!._creationTime,
		};
	},
});

export const saveSummary = internalMutation({
	args: { conversationId: v.id("conversations"), summary: v.string(), upTo: v.number() },
	handler: async (ctx, { conversationId, summary, upTo }) => {
		await ctx.db.patch(conversationId, { summary, summarizedUpTo: upTo });
	},
});
