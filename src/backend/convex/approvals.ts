import {
	APPROVAL_TTL_MS,
	actionLabel,
	alwaysAllowText,
	askText,
	approvalHash,
	approvalStatus,
	type Bound,
	builtinTools,
	callEnd,
	canDecideApproval,
	canonicalJson,
	clipJson,
	findConnector,
	toolGroup,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { logCall } from "./activity";
import { mutation, query } from "./functions";
import { automationName, automationScope } from "./automationOps";
import { canSee, findOrCreateDm, insertMessage, namer } from "./chatOps";
import { titleOf } from "./connectorTools";
import { erased, getMember, memberOf, nameOf, requireLiveAgent, requireMember, toActor } from "./lib";
import { decideFor, setRule } from "./permissions";
import { canReadReplyDetails, readReplyDetails } from "./replyPrivacy";
import { writeSources } from "./replySources";
import { risk } from "./schema";
import { enqueueTurn, runningTurn } from "./turns";

// Approvals: a tool call an agent held until the person it acts for says yes (core
// approvals.ts). Automation cards go to the actor's DM; deciding queues a turn in the original
// place (so the one-turn-per-place queue holds); that turn runs the call if approved,
// with the exact stored input, then tells the agent what happened.

/** A page's content revision: the editor's step count (prosemirror-sync), which every edit and restore moves on. */
const pageRevision = async (ctx: QueryCtx, page: Doc<"pages"> | null) =>
	page ? ((await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id: page._id })) ?? 0) : null;

/** The current revision of one thing a call depends on, or null when it's gone (or not this workspace's). */
async function revisionOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, { kind, id }: Bound): Promise<number | string | null> {
	const ours = <T extends { workspaceId: Id<"workspaces"> }>(doc: T | null) => (doc && doc.workspaceId === workspaceId ? doc : null);
	const norm = ctx.db.normalizeId.bind(ctx.db);
	switch (kind) {
		case "page": {
			const pageId = norm("pages", id);
			return pageRevision(ctx, pageId && ours(await ctx.db.get(pageId)));
		}
		case "pageVersion": {
			const versionId = norm("pageVersions", id);
			const version = versionId && (await ctx.db.get(versionId));
			return pageRevision(ctx, version ? ours(await ctx.db.get(version.pageId)) : null);
		}
		case "recordPage": {
			const recordId = norm("records", id);
			const page = recordId && (await ctx.db.query("pages").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("recordId", recordId)).first());
			// A record nobody has written in has no page yet: that's its first revision.
			return page ? pageRevision(ctx, page) : 0;
		}
		case "record": {
			const recordId = norm("records", id);
			return (recordId && ours(await ctx.db.get(recordId)))?.updatedAt ?? null;
		}
		case "memory": {
			const memoryId = norm("memories", id);
			return (memoryId && ours(await ctx.db.get(memoryId)))?.version ?? null;
		}
		case "message": {
			const messageId = norm("chatMessages", id);
			const message = messageId && ours(await ctx.db.get(messageId));
			return message ? (message.editedAt ?? 0) : null;
		}
		case "agent": {
			const agentId = norm("agents", id);
			return (agentId && ours(await ctx.db.get(agentId)))?.version ?? null;
		}
		case "skill": {
			const row = await ctx.db.query("skillInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("skillId", id)).first();
			return row ? (row.custom?.version ?? row.definition?.version ?? 0) : null;
		}
		case "automation": {
			const row = await ctx.db.query("automationInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", id)).first();
			return row ? (row.custom?.version ?? row.definition?.version ?? 0) : null;
		}
	}
}

/**
 * What a built-in call's effect depends on, at its current revisions (core `ToolDef.binds`), as canonical JSON;
 * undefined when it depends on nothing. Hashed with the input, so the card locks to what it showed.
 */
async function boundRevisions(ctx: QueryCtx, workspaceId: Id<"workspaces">, tool: string, input: unknown) {
	const binds = builtinTools.find((t) => t.id === tool)?.binds?.(input) ?? [];
	if (!binds.length) return undefined;
	return canonicalJson(await Promise.all(binds.map(async (b) => ({ ...b, revision: await revisionOf(ctx, workspaceId, b) }))));
}

/**
 * Written by the runner when the model makes a call that needs approval. `input` is canonical JSON.
 * It names what it changes by id (core tools), and binds the revisions of anything its effect depends on.
 */
export const request = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), tool: v.string(), input: v.string(), risk, why: v.optional(v.string()) },
	handler: async (ctx, { turnId, callId, tool, input, risk, why }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const bound = await boundRevisions(ctx, turn.workspaceId, tool, JSON.parse(input));
		const { automation, trigger } = await automationScope(ctx, turn);
		// Automation and wake cards belong only in the acting person's DM, even for channel/thread runs.
		// Keep chatId/threadId as the execution place: implicit targets must not change on approval.
		const dmId = (trigger?.automation || turn.wakeupId) && await findOrCreateDm(ctx, turn.workspaceId, turn.actorId, [turn.actorId], [turn.agentId]);
		// In the DM itself it goes in the reply, which is shown with it (turns.ts `show`).
		const separate = !!dmId && dmId !== turn.chatId;
		const replyId = separate ? await insertMessage(ctx, (await ctx.db.get(dmId!))!, {
			authorAgentId: turn.agentId, usedPlaces: await writeSources(ctx, member, { filtered: true, preserveOwn: true }), repliedTo: turn.actorId, text: "", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done",
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
			...(bound !== undefined && { bound }),
			hash: await approvalHash(tool, JSON.parse(input), bound),
			status: "pending",
			expiresAt: Date.now() + APPROVAL_TTL_MS,
			risk,
			automationInstallId: automation?._id,
		});
		if (separate) await ctx.db.patch(replyId, { parts: [{ type: "approval", id: callId, approvalId, tool, ...(why && { why }) }] });
		return { approvalId, separate };
	},
});

/**
 * Whether the card may offer "Always allow", read live (someone with actions.lock may have locked it
 * since), and the automation a grant would be scoped to. Old rows without a risk: no.
 */
async function alwaysFor(ctx: QueryCtx, row: Doc<"approvals">) {
	const member = await memberOf(ctx, row.actorId, row.workspaceId);
	if (!row.risk || !member) return null;
	// A removed automation cannot leave behind a wider Always grant, whether it went after the
	// call was held or before (its run keeps going, and `request` then has no install to record).
	const automation = row.automationInstallId ? await ctx.db.get(row.automationInstallId) : null;
	// A wake has no automation to scope a grant to, so its cards never offer Always.
	if ((await ctx.db.get(row.turnId))?.wakeupId) return null;
	if (row.automationInstallId && (!automation || automation.archived)) return null;
	const turn = !row.automationInstallId && (await ctx.db.get(row.turnId));
	if (turn && turn.triggerId && (await ctx.db.get(turn.triggerId))?.automation) return null;
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
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member)) || !(await canReadReplyDetails(ctx, member, reply!))) return [];
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
				// A skill proposal may be private even when its write is later refused.
				const privateInput = row.actorId !== member.userId && (row.tool === "skills.create" || row.tool === "skills.edit");
				const shownInput = privateInput ? "{}" : row.input;
				const input: unknown = JSON.parse(shownInput);
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
					/** The automation whose run made the call, so the card says where the agent's words came from. */
					automation: automation ? automationName(automation) : null,
					/** Set when "Always allow" would cover only this automation's runs. */
					alwaysAutomation: always?.automation ? automationName(always.automation) : null,
					/** Null when "Always allow" isn't offered (locked, or not yours to decide). */
					alwaysText: always
						? alwaysAllowText(row.tool, connector, { automation: always.automation ? automationName(always.automation) : undefined, title })
						: null,
					/** Set when "Always allow" saved a rule. */
					always: row.always ?? false,
					/** The exact input that will run, as canonical JSON. */
					input: shownInput,
					hash: row.hash,
					status: approvalStatus(row),
					approver: (await names.user(row.actorId)).name,
					canDecide: mine,
					expiresAt: row.expiresAt,
					decidedAt: row.decidedAt ?? null,
					result: mine ? (row.result ?? null) : null,
					error: privateInput ? null : row.error ?? null,
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
		const reply = await ctx.db.get(row.replyId);
		if (!reply || !(await canReadReplyDetails(ctx, member, reply))) throw new ConvexError("Approval not found.");
		if (!canDecideApproval(toActor(member), row)) {
			throw new ConvexError(`Only ${await nameOf(ctx, row.actorId)} can decide this. The agent is acting for them.`);
		}
		const status = approvalStatus(row);
		if (status === "expired") throw new ConvexError("This request expired. Ask the agent again.");
		if (status !== "pending") throw new ConvexError("This was already decided.");
		if (hash !== row.hash) throw new ConvexError("This action isn't the one you were shown. Nothing ran.");
		const agent = await requireLiveAgent(ctx, member, row.agentId);

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
			// The message that started it all, so the decision's reaction lands on the person's message.
			// An old welcome turn had none: then there's nothing to react to.
			triggerId: asked ? asked.triggerId : row.replyId,
			actorId: row.actorId,
			approvalId,
			// A wake's follow-up turn stays a wake, as trusted as the wake.
			...(asked?.wakeupId && { wakeupId: asked.wakeupId }),
			// Still in its chain of agents, or still answering another agent's ask (chains.ts).
			...(asked?.chain && { chain: asked.chain }),
			...(asked?.ask && { ask: asked.ask }),
		});
	},
});

/**
 * Called by the turn that follows an approval, right before running it. Moves it from
 * approved to running (once), and re-checks the lock: the stored call must still hash
 * to what was approved. Returns the exact call to run, or null.
 */
export const claim = internalMutation({
	/** `outside`: the call goes to a service outside the workspace, so cut off, its outcome is unknown (turns.ts `settleApproval`). */
	args: { approvalId: v.id("approvals"), turnId: v.id("agentTurns"), outside: v.optional(v.boolean()) },
	handler: async (ctx, { approvalId, turnId, outside }): Promise<{ tool: string; input: unknown } | null> => {
		const [row, turn] = await Promise.all([ctx.db.get(approvalId), ctx.db.get(turnId)]);
		if (!row || row.status !== "approved" || turn?.status !== "running" || turn.approvalId !== approvalId) return null;
		const member = await memberOf(ctx, row.actorId, row.workspaceId);
		const chat = await ctx.db.get(row.chatId);
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member))) return null;
		member.replyId = turn.replyId;
		const reply = await ctx.db.get(row.replyId);
		if (!(await canReadReplyDetails(ctx, member, reply))) return null;
		const input: unknown = JSON.parse(row.input);
		if ((await approvalHash(row.tool, input, row.bound)) !== row.hash) {
			await ctx.db.patch(approvalId, { status: "failed", error: "The stored action no longer matches what was approved." });
			return null;
		}
		// What it changes must still be as it was on the card: an edit since stops it rather than run on unseen content.
		if (row.bound !== undefined && (await boundRevisions(ctx, row.workspaceId, row.tool, input)) !== row.bound) {
			await ctx.db.patch(approvalId, { status: "failed", error: "What this changes was edited after it was approved, so it didn't run. Ask again if you still want it." });
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
		await readReplyDetails(ctx, member, reply);
		await ctx.db.patch(approvalId, { status: "running", ...(outside && { outside: true }) });
		return { tool: row.tool, input };
	},
});

/** What an approved call's line in Activity says about how it was allowed. */
const allowedOf = (row: Doc<"approvals">) => ({ how: row.always ? ("always" as const) : ("once" as const), by: row.actorId, at: row.decidedAt ?? Date.now() });

/** Marks a running approval done, failed or unknown, and logs its call, once: whichever of the effect or the runner gets there first. */
async function settle(ctx: MutationCtx, row: Doc<"approvals">, turnId: Id<"agentTurns">, end: { result?: string; error?: string; unknown?: boolean }) {
	const status = end.error === undefined ? "done" : end.unknown ? "unknown" : "failed";
	// Only the actor sees the result: once their account is erased, it's not kept.
	const result = status === "done" && !(await erased(ctx, row.actorId)) ? end.result : undefined;
	await ctx.db.patch(row._id, { status, ...(result !== undefined && { result }), ...(end.error !== undefined && { error: end.error }) });
	await logCall(ctx, { turnId, callId: `approval-${row._id}`, tool: row.tool, changes: true, input: clipJson(JSON.parse(row.input)), output: end.result, error: end.error, allowed: allowedOf(row) });
}

/**
 * An approved built-in call's effect and its receipt, in one transaction. `op` (the approval id, which the
 * runner passes to the store as the call's operation key) is settled in the same write as the effect,
 * so the card can never say it's running while it already happened, nor done while it didn't. A second
 * run with the same key writes nothing. Calls not run from an approval (`op` unset) just run.
 */
export async function withReceipt<T>(ctx: MutationCtx, op: Id<"approvals"> | undefined, turnId: Id<"agentTurns">, run: () => Promise<T>): Promise<T> {
	if (!op) return run();
	const row = await ctx.db.get(op);
	const turn = await ctx.db.get(turnId);
	if (row?.status !== "running" || turn?.approvalId !== op) throw new ConvexError("This approved call already ran, or was stopped. Nothing ran again.");
	const output = await run();
	const end = callEnd(output);
	await settle(ctx, row, turnId, "output" in end ? { result: clipJson(end.output) } : { error: end.error });
	return output;
}

/**
 * Records how an approved call went, and logs it, unless its effect already did (`withReceipt`).
 * `unknown`: an outside call that was cut off or failed in transit, so it may or may not have happened.
 */
export const finish = internalMutation({
	args: { approvalId: v.id("approvals"), turnId: v.id("agentTurns"), result: v.optional(v.string()), error: v.optional(v.string()), unknown: v.optional(v.boolean()) },
	handler: async (ctx, { approvalId, turnId, ...end }) => {
		const row = await ctx.db.get(approvalId);
		if (row?.status !== "running") return;
		await settle(ctx, row, turnId, end);
	},
});
