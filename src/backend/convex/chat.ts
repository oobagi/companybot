import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireActiveAgent } from "./agents";
import { dmKeyOf, findOrCreateDm, insertMessage } from "./chatOps";
import { getMember } from "./lib";
import { enqueueTurn } from "./turns";

// Legacy API for apps from before team chat (v0.1.0-alpha.2 and older), which call these
// until they update. Both use the person's agent DM, so old and new apps show the same
// conversation. Delete once every install is on the team chat release (wiki/releases.md).

export const messages = query({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const dm = await ctx.db
			.query("chats")
			.withIndex("by_dm_key", (q) =>
				q.eq("workspaceId", member.workspaceId).eq("dmKey", dmKeyOf([member.userId], [agentId])),
			)
			.first();
		if (!dm) return [];
		const rows = await ctx.db
			.query("chatMessages")
			.withIndex("by_chat_thread", (q) => q.eq("chatId", dm._id).eq("threadId", undefined))
			.order("desc")
			.take(200);
		return rows.reverse().map((m) => ({
			_id: m._id,
			_creationTime: m._creationTime,
			role: m.authorAgentId ? ("assistant" as const) : ("user" as const),
			text: m.deleted ? "" : m.text,
			parts: m.deleted ? [] : m.parts,
			status: m.status,
			error: m.error,
		}));
	},
});

export const send = mutation({
	args: { agentId: v.id("agents"), text: v.string() },
	handler: async (ctx, { agentId, text }) => {
		const { member } = await requireActiveAgent(ctx, agentId);
		text = text.trim();
		if (!text) return;
		const chatId = await findOrCreateDm(ctx, member.workspaceId, member.userId, [member.userId], [agentId]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			authorUserId: member.userId,
			text,
			parts: [{ type: "text", text }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
		});
		await enqueueTurn(ctx, chat, { agentId, chatId, triggerId, actorId: member.userId });
	},
});
