import {
	APPROVAL_TTL_MS,
	actionLabel,
	alwaysAllowText,
	askText,
	approvalHash,
	approvalStatus,
	builtinTools,
	canDecideApproval,
	findConnector,
	toolGroup,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import { canSee, findOrCreateDm, insertMessage, namer } from "./chatOps";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { erased, getMember, memberOf, nameOf, requireMember, toActor } from "./lib";
import { decideFor, setRule } from "./permissions";
import { automationName, automationScope } from "./automationOps";
import { titleOf } from "./connectorTools";
import { risk } from "./schema";
import { enqueueTurn, runningTurn } from "./turns";

// Approvals: a tool call an agent held until the person it acts for says yes (core
// approvals.ts). Automation cards go to the actor's DM; deciding queues a turn in the original
// place (so the one-turn-per-place queue holds); that turn runs the call if approved,
// with the exact stored input, then tells the agent what happened.

/**
 * Written by the runner when the model makes a call that needs approval. `input` is canonical JSON.
 */
export const request = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), tool: v.string(), input: v.string(), risk },
	handler: async (ctx, { turnId, callId, tool, input, risk }) => {
		const { turn } = await runningTurn(ctx, turnId);
		const { automation, trigger } = await automationScope(ctx, turn);
		// Automation cards belong only in the acting person's DM, even for channel/thread runs.
		// Keep chatId/threadId as the execution place: implicit targets must not change on approval.
		const dmId = trigger?.automation && await findOrCreateDm(ctx, turn.workspaceId, turn.actorId, [turn.actorId], [turn.agentId]);
		const separate = !!dmId && dmId !== turn.chatId;
		const replyId = separate ? await insertMessage(ctx, (await ctx.db.get(dmId!))!, {
			authorAgentId: turn.agentId, text: "", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done",
		}) : turn.replyId;
		const approvalId = await ctx.db.insert("approvals", {
			workspaceId: turn.workspaceId,
			agentId: turn.agentId,
			actorId: turn.actorId,
			chatId: turn.chatId,
			threadId: turn.threadId,
			turnId,
			replyId,
			callId,
			tool,
			input,
			hash: await approvalHash(tool, JSON.parse(input)),
			status: "pending",
			expiresAt: Date.now() + APPROVAL_TTL_MS,
			risk,
			automationInstallId: automation?._id,
		});
		if (separate) await ctx.db.patch(replyId, { parts: [{ type: "approval", id: callId, approvalId, tool }] });
		return { approvalId, separate };
	},
});

/**
 * Whether the card may offer "Always allow", read live (an owner may have locked it
 * since), and the automation a grant would be scoped to. Old rows without a risk: no.
 */
async function alwaysFor(ctx: QueryCtx, row: Doc<"approvals">) {
	const member = await memberOf(ctx, row.actorId, row.workspaceId);
	if (!row.risk || !member) return null;
	// A removed automation cannot leave behind a wider Always grant.
	const automation = row.automationInstallId ? await ctx.db.get(row.automationInstallId) : null;
	if (row.automationInstallId && !automation) return null;
	// Acting-as-you calls ask only in others' automations, and an Always for them is scoped to it.
	const { decision } = await decideFor(ctx, member, { action: row.tool, risk: row.risk, foreign: !!automation });
	if (decision.type !== "ask" || !decision.canAlways) return null;
	return { member, automation };
}

/** A reply's held calls, if the person can see its chat. Results show only to the person the agent acted for. */
export const forReply = query({
	args: { replyId: v.id("chatMessages") },
	handler: async (ctx, { replyId }) => {
		const member = await getMember(ctx);
		const reply = await ctx.db.get(replyId);
		const chat = reply && (await ctx.db.get(reply.chatId));
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member))) return [];
		const rows = await ctx.db
			.query("approvals")
			.withIndex("by_reply", (q) => q.eq("replyId", replyId))
			.collect();
		const names = namer(ctx);
		return Promise.all(
			rows.map(async (row) => {
				const mine = canDecideApproval(toActor(member), row);
				const group = toolGroup(row.tool);
				const connector = findConnector(group) ?? null;
				const always = mine && approvalStatus(row) === "pending" ? await alwaysFor(ctx, row) : null;
				const title = await titleOf(ctx, row.workspaceId, row.tool);
				const input: unknown = JSON.parse(row.input);
				const automation = row.automationInstallId && (await ctx.db.get(row.automationInstallId));

				return {
					_id: row._id,
					callId: row.callId,
					tool: row.tool,
					/** The service's name ("Night Owl"), or null for built-ins. */
					service: findConnector(group)?.name ?? null,
					/** Its name for people: "Send SMS". */
					action: actionLabel(row.tool, title),
					/** The ask: "I'd like to send an email to dana@acme.com from your Gmail.", or "Monday summary wants to post in #general as you." */
					ask: askText(row.tool, connector, input, {
						title,
						said: builtinTools.find((t) => t.id === row.tool)?.label?.(input),
						automation: automation ? automationName(automation) : undefined,
					}),
					/** Set when "Always allow" would cover only this automation's runs. */
					alwaysAutomation: always?.automation ? automationName(always.automation) : null,
					/** Null when "Always allow" isn't offered (locked, or not yours to decide). */
					alwaysText: always
						? alwaysAllowText(row.tool, connector, { automation: always.automation ? automationName(always.automation) : undefined, title })
						: null,
					/** Set when "Always allow" saved a rule. */
					always: row.always ?? false,
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
	/**
	 * `always`: also save a rule so it stops asking.
	 */
	args: { approvalId: v.id("approvals"), hash: v.string(), approve: v.boolean(), always: v.boolean() },
	handler: async (ctx, { approvalId, hash, approve, always }) => {
		const member = await requireMember(ctx);
		const row = await ctx.db.get(approvalId);
		const chat = row && row.workspaceId === member.workspaceId ? await ctx.db.get(row.chatId) : null;
		if (!row || !chat || chat.archived || !(await canSee(ctx, chat, member))) throw new ConvexError("Approval not found.");
		if (!canDecideApproval(toActor(member), row)) {
			throw new ConvexError(`Only ${await nameOf(ctx, row.actorId)} can decide this. The agent is acting for them.`);
		}
		const status = approvalStatus(row);
		if (status === "expired") throw new ConvexError("This request expired. Ask the agent again.");
		if (status !== "pending") throw new ConvexError("This was already decided.");
		if (hash !== row.hash) throw new ConvexError("This action isn't the one you were shown. Nothing ran.");
		const agent = await ctx.db.get(row.agentId);
		if (!agent || agent.archived) throw new ConvexError("This agent is archived.");

		if (approve && always) {
			const allowed = await alwaysFor(ctx, row);
			if (!allowed) throw new ConvexError("Always allow isn't available here: this action always asks, or its automation was deleted. Nothing ran.");
			await setRule(ctx, allowed.member, { action: row.tool, setting: "always", automationInstallId: allowed.automation?._id, risk: row.risk });
		}
		await ctx.db.patch(approvalId, { status: approve ? "approved" : "denied", decidedAt: Date.now(), ...(approve && always && { always: true }) });
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
		const member = await memberOf(ctx, row.actorId, row.workspaceId);
		const chat = await ctx.db.get(row.chatId);
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member))) return null;
		const input: unknown = JSON.parse(row.input);
		if ((await approvalHash(row.tool, input)) !== row.hash) {
			await ctx.db.patch(approvalId, { status: "failed", error: "The stored action no longer matches what was approved." });
			return null;
		}
		// Rules are read fresh: a block or Never set since the approval wins.
		// Stored rows without risk were never backfilled; treat them conservatively.
		const { decision } = member ? await decideFor(ctx, member, { action: row.tool, risk: row.risk ?? "outside" }) : { decision: null };
		if (decision?.type === "deny") {
			const who = decision.by === "owner" ? "A workspace owner blocked this" : `${await nameOf(ctx, row.actorId)} set this to Never`;
			await ctx.db.patch(approvalId, { status: "failed", error: `${who} after it was approved, so it didn't run.` });
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
		// Only the actor sees the result: once their account is erased, it's not kept.
		if (error === undefined) await ctx.db.patch(approvalId, { status: "done", ...(!(await erased(ctx, row.actorId)) && { result }) });
		else await ctx.db.patch(approvalId, { status: "failed", error });
	},
});

