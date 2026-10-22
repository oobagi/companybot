import { describeWidget } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { requireActiveAgent } from "./agents";
import { getMember, installedSkills, memberOf, nameOf } from "./lib";
import { messagePart } from "./schema";

/** A reply stuck this long (e.g. the action crashed) no longer blocks new messages. */
const STALE_REPLY_MS = 5 * 60_000;

async function findConversation(ctx: QueryCtx, userId: Id<"users">, agentId: Id<"agents">) {
	return ctx.db
		.query("conversations")
		.withIndex("by_user_agent", (q) => q.eq("userId", userId).eq("agentId", agentId))
		.first();
}

const messagesOf = (ctx: QueryCtx, conversationId: Id<"conversations">) =>
	ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId));

export const messages = query({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const conversation = await findConversation(ctx, member.userId, agentId);
		if (!conversation) return [];
		return (await messagesOf(ctx, conversation._id).order("desc").take(200)).reverse();
	},
});

export const send = mutation({
	args: { agentId: v.id("agents"), text: v.string() },
	handler: async (ctx, { agentId, text }) => {
		const { member } = await requireActiveAgent(ctx, agentId);
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

		await ctx.db.insert("messages", {
			conversationId: conversation._id,
			role: "user",
			text: text.trim(),
			parts: [{ type: "text", text: text.trim() }],
			status: "done",
		});
		const replyId = await ctx.db.insert("messages", {
			conversationId: conversation._id,
			role: "assistant",
			text: "",
			parts: [],
			status: "streaming",
		});
		await ctx.db.patch(conversation._id, { busy: true });
		await ctx.scheduler.runAfter(0, internal.agent.respond, { conversationId: conversation._id, replyId });
	},
});

// ---- Internal: used by the agent runner ----

/**
 * Everything the agent needs for one turn: its current setup, who it's helping, the
 * summary, and recent messages. Read at the start of each turn, so agent edits apply
 * from the next reply.
 */
export const turnContext = internalQuery({
	args: { conversationId: v.id("conversations"), replyId: v.id("messages") },
	handler: async (ctx, { conversationId, replyId }) => {
		const conversation = await ctx.db.get(conversationId);
		if (!conversation) throw new Error("Conversation not found.");
		const member = await memberOf(ctx, conversation.userId);
		if (member?.workspaceId !== conversation.workspaceId) throw new Error("This person is no longer in the workspace.");
		const agent = await ctx.db.get(conversation.agentId);
		if (!agent || agent.archived) throw new Error("This agent is archived.");
		const user = await ctx.db.get(conversation.userId);
		const recent = await unsummarized(ctx, conversation);
		return {
			member,
			name: await nameOf(ctx, conversation.userId),
			email: user?.email ?? "",
			agent: {
				id: agent._id,
				name: agent.name,
				instructions: agent.instructions,
				model: agent.model,
				tools: agent.tools,
			},
			skills: await installedSkills(ctx, conversation.workspaceId),
			summary: conversation.summary ?? null,
			history: recent.filter((m) => m._id !== replyId && m.status === "done").map(forModel),
		};
	},
});

/** What the agent sees of a past message: its text, plus a note for each widget it showed. */
function forModel(m: Doc<"messages">) {
	const widgets = m.parts.flatMap((p) => (p.type === "widget" ? [describeWidget(p.widget)] : []));
	return { role: m.role, text: [m.text, ...widgets].filter(Boolean).join("\n") };
}

async function unsummarized(ctx: QueryCtx, conversation: Doc<"conversations">) {
	return ctx.db
		.query("messages")
		.withIndex("by_conversation", (q) =>
			q.eq("conversationId", conversation._id).gt("_creationTime", conversation.summarizedUpTo ?? 0),
		)
		.collect();
}

export const updateReply = internalMutation({
	args: { replyId: v.id("messages"), text: v.string(), parts: v.array(messagePart) },
	handler: async (ctx, { replyId, text, parts }) => {
		await ctx.db.patch(replyId, { text, parts });
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
			messages: old.map(forModel),
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
