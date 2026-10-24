import { APPROVAL_TTL_MS, approvalHash, approvalStatus, canDecideApproval, findConnector, toolGroup } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { canSee, namer } from "./chatOps";
import { getMember, nameOf, requireMember, toActor } from "./lib";
import { enqueueTurn } from "./turns";

// Approvals: a tool call an agent held until the person it acts for says yes (core
// approvals.ts). The card sits in the agent's reply. Deciding queues a turn in the same
// place (so the one-turn-per-place queue holds); that turn runs the call if approved,
// with the exact stored input, then tells the agent what happened.

/** Written by the runner when the model makes a call that needs approval. `input` is canonical JSON. */
export const request = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), tool: v.string(), input: v.string() },
	handler: async (ctx, { turnId, callId, tool, input }) => {
		const turn = await ctx.db.get(turnId);
		if (!turn || turn.status !== "running" || !turn.replyId) throw new Error("This reply was stopped.");
		return ctx.db.insert("approvals", {
			workspaceId: turn.workspaceId,
			agentId: turn.agentId,
			actorId: turn.actorId,
			chatId: turn.chatId,
			threadId: turn.threadId,
			turnId,
			replyId: turn.replyId,
			callId,
			tool,
			input,
			hash: await approvalHash(tool, JSON.parse(input)),
			status: "pending",
			expiresAt: Date.now() + APPROVAL_TTL_MS,
		});
	},
});

/** A reply's held calls, if the person can see its chat. Results show only to the person the agent acted for. */
export const forReply = query({
	args: { replyId: v.id("chatMessages") },
	handler: async (ctx, { replyId }) => {
		const member = await getMember(ctx);
		const reply = await ctx.db.get(replyId);
		const chat = reply && (await ctx.db.get(reply.chatId));
		if (!member || !chat || !(await canSee(ctx, chat, member))) return [];
		const rows = await ctx.db
			.query("approvals")
			.withIndex("by_reply", (q) => q.eq("replyId", replyId))
			.collect();
		const names = namer(ctx);
		return Promise.all(
			rows.map(async (row) => {
				const mine = canDecideApproval(toActor(member), row);
				const group = toolGroup(row.tool);
				return {
					_id: row._id,
					callId: row.callId,
					tool: row.tool,
					/** The service's name ("Night Owl"), or null for built-ins. */
					service: findConnector(group)?.name ?? null,
					action: row.tool.slice(group.length + 1),
					/** The exact input that will run, as canonical JSON. */
					input: row.input,
					hash: row.hash,
					status: approvalStatus(row),
					approver: (await names.user(row.actorId)).name,
					canDecide: mine,
					expiresAt: row.expiresAt,
					decidedAt: row.decidedAt ?? null,
					result: mine ? (row.result ?? null) : null,
					error: row.error ?? null,
				};
			}),
		);
	},
});

/**
 * Approve or deny. `hash` is the one the approver was shown: if it doesn't match the
 * stored call exactly, nothing is decided. Only the person the agent acted for can
 * decide, while they can still see the chat, before it expires.
 */
export const decide = mutation({
	args: { approvalId: v.id("approvals"), hash: v.string(), approve: v.boolean() },
	handler: async (ctx, { approvalId, hash, approve }) => {
		const member = await requireMember(ctx);
		const row = await ctx.db.get(approvalId);
		const chat = row && row.workspaceId === member.workspaceId ? await ctx.db.get(row.chatId) : null;
		if (!row || !chat || !(await canSee(ctx, chat, member))) throw new ConvexError("Approval not found.");
		if (!canDecideApproval(toActor(member), row)) {
			throw new ConvexError(`Only ${await nameOf(ctx, row.actorId)} can decide this. The agent is acting for them.`);
		}
		const status = approvalStatus(row);
		if (status === "expired") throw new ConvexError("This request expired. Ask the agent again.");
		if (status !== "pending") throw new ConvexError("This was already decided.");
		if (hash !== row.hash) throw new ConvexError("This action isn't the one you were shown. Nothing ran.");
		const agent = await ctx.db.get(row.agentId);
		if (!agent || agent.archived) throw new ConvexError("This agent is archived.");

		await ctx.db.patch(approvalId, { status: approve ? "approved" : "denied", decidedAt: Date.now() });
		const asked = await ctx.db.get(row.turnId);
		await enqueueTurn(ctx, chat, {
			agentId: row.agentId,
			chatId: row.chatId,
			threadId: row.threadId,
			// The message that started it all, so chat.react still reacts to the person's message.
			triggerId: asked?.triggerId ?? row.replyId,
			actorId: row.actorId,
			approvalId,
		});
	},
});

/**
 * Called by the turn that follows an approval, right before running it. Moves it from
 * approved to running (once), and re-checks the lock: the stored call must still hash
 * to what was approved. Returns the exact call to run, or null.
 */
export const claim = internalMutation({
	args: { approvalId: v.id("approvals"), turnId: v.id("agentTurns") },
	handler: async (ctx, { approvalId, turnId }): Promise<{ tool: string; input: unknown } | null> => {
		const [row, turn] = await Promise.all([ctx.db.get(approvalId), ctx.db.get(turnId)]);
		if (!row || row.status !== "approved" || turn?.status !== "running" || turn.approvalId !== approvalId) return null;
		const input: unknown = JSON.parse(row.input);
		if ((await approvalHash(row.tool, input)) !== row.hash) {
			await ctx.db.patch(approvalId, { status: "failed", error: "The stored action no longer matches what was approved." });
			return null;
		}
		await ctx.db.patch(approvalId, { status: "running" });
		return { tool: row.tool, input };
	},
});

/** Records how an approved call went. */
export const finish = internalMutation({
	args: { approvalId: v.id("approvals"), result: v.optional(v.string()), error: v.optional(v.string()) },
	handler: async (ctx, { approvalId, result, error }) => {
		const row = await ctx.db.get(approvalId);
		if (row?.status !== "running") return;
		await ctx.db.patch(approvalId, error === undefined ? { status: "done", result } : { status: "failed", error });
	},
});

