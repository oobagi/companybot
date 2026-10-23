import { isGranted } from "@companybot/core";
import { internalMutation } from "./_generated/server";
import { saveVersion } from "./agents";
import { addToChat, dmKeyOf, ensureGeneral } from "./chatOps";

// One-off data migrations. Each is idempotent: safe to run again.
// Run: npx convex run migrations:<name> (dev), then with --prod after a release deploys.

/**
 * Moves the 1:1 person↔agent chat into the chat model: every workspace gets #general
 * with all its members, each legacy conversation is copied into an agent DM, and
 * agents without chat tools get `chat.*`. Legacy rows are marked, not deleted.
 */
export const conversationsToChats = internalMutation({
	args: {},
	handler: async (ctx) => {
		const counts = { workspaces: 0, conversations: 0, messages: 0, agents: 0 };

		for (const workspace of await ctx.db.query("workspaces").collect()) {
			const members = await ctx.db
				.query("members")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
				.collect();
			const owner = members.find((m) => m.role === "owner") ?? members[0];
			if (!owner) continue;
			const general = await ensureGeneral(ctx, workspace._id, owner.userId);
			for (const m of members) await addToChat(ctx, general, { userId: m.userId });
			counts.workspaces++;
		}

		for (const conversation of await ctx.db.query("conversations").collect()) {
			if (conversation.migratedTo) continue;
			const { workspaceId, userId, agentId } = conversation;
			const dmKey = dmKeyOf([userId], [agentId]);
			let chat = await ctx.db
				.query("chats")
				.withIndex("by_dm_key", (q) => q.eq("workspaceId", workspaceId).eq("dmKey", dmKey))
				.first();
			if (!chat) {
				const id = await ctx.db.insert("chats", {
					workspaceId,
					kind: "dm",
					private: true,
					dmKey,
					archived: false,
					createdBy: userId,
					lastMessageAt: conversation._creationTime,
				});
				chat = (await ctx.db.get(id))!;
			}
			await addToChat(ctx, chat, { userId });
			await addToChat(ctx, chat, { agentId });

			// Inserted in order, so they keep their order (with new creation times).
			const messages = await ctx.db
				.query("messages")
				.withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
				.collect();
			for (const m of messages) {
				const streaming = m.status === "streaming";
				await ctx.db.insert("chatMessages", {
					chatId: chat._id,
					workspaceId,
					...(m.role === "user" ? { authorUserId: userId } : { authorAgentId: agentId }),
					text: m.text,
					parts: m.parts,
					mentions: { userIds: [], agentIds: [] },
					status: streaming ? "error" : m.status,
					...((m.error || streaming) && { error: m.error ?? "Reply timed out." }),
					...(m.stats && { stats: m.stats }),
				});
				counts.messages++;
			}
			const now = Date.now();
			await ctx.db.patch(chat._id, { lastMessageAt: now, costUsd: (chat.costUsd ?? 0) + (conversation.costUsd ?? 0) });
			const row = await ctx.db
				.query("chatMembers")
				.withIndex("by_user", (q) => q.eq("userId", userId).eq("chatId", chat._id))
				.first();
			if (row) await ctx.db.patch(row._id, { lastReadAt: now });

			// The old summary seeds the agent's session here; old turns weren't stored as prompts, so there's nothing to replay.
			if (conversation.summary || conversation.costUsd) {
				const session = await ctx.db
					.query("agentSessions")
					.withIndex("by_place", (q) => q.eq("agentId", agentId).eq("chatId", chat._id).eq("threadId", undefined))
					.first();
				const fields = { summary: conversation.summary, costUsd: (session?.costUsd ?? 0) + (conversation.costUsd ?? 0) };
				if (session) await ctx.db.patch(session._id, fields);
				else await ctx.db.insert("agentSessions", { workspaceId, agentId, chatId: chat._id, ...fields });
			}
			await ctx.db.patch(conversation._id, { migratedTo: chat._id });
			counts.conversations++;
		}

		for (const agent of await ctx.db.query("agents").collect()) {
			if (["chat.react", "chat.read", "chat.search"].some((id) => isGranted(agent.tools, id))) continue;
			const { name, description, instructions, model, tools } = agent;
			const config = { name, description, instructions, model, tools: [...tools, "chat.*"].sort() };
			await saveVersion(ctx, agent, config, agent.updatedBy);
			counts.agents++;
		}
		return counts;
	},
});
