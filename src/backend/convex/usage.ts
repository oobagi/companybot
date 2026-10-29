import { type UsageKind, can, isUsageMonth, usageKinds, usageMonth } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { namer } from "./chatOps";
import { query } from "./functions";
import { type Member, getMember, liveWorkspace } from "./lib";

// What AI has cost, by month. Every paid call goes through `recordUsage`; the Usage screen and the
// agents' `workspace_settings` usage action read the aggregate rows (schema `usage`). See wiki/architecture.md#usage.

/** More rows than a month can have: people × agents × kinds × models, a few hundred at most. */
const MAX_ROWS = 2000;

export type UsageEntry = {
	workspaceId: Id<"workspaces">;
	/** The person it ran for: who wrote the message, who an automation ran for. */
	userId?: Id<"users">;
	agentId?: Id<"agents">;
	kind: UsageKind;
	model?: string;
	/** USD, as AI Gateway billed it. Nothing is recorded for zero. */
	costUsd: number;
};

/**
 * Adds a paid call's cost to this month's row for its person, agent, kind and model. Call it from
 * the mutation that saves the call's result. It refuses a workspace that's being deleted, so a call
 * finishing after its cascade passed the table leaves nothing behind. Returns whether it was recorded.
 */
export async function recordUsage(ctx: MutationCtx, { workspaceId, userId, agentId, kind, model, costUsd }: UsageEntry) {
	if (!(costUsd > 0) || !(await liveWorkspace(ctx, workspaceId))) return false;
	const month = usageMonth(Date.now());
	const row = await ctx.db
		.query("usage")
		.withIndex("by_bucket", (q) => q.eq("workspaceId", workspaceId).eq("month", month).eq("userId", userId).eq("agentId", agentId).eq("kind", kind).eq("model", model))
		.first();
	if (row) await ctx.db.patch(row._id, { costUsd: row.costUsd + costUsd });
	else await ctx.db.insert("usage", { workspaceId, month, userId, agentId, kind, model, costUsd });
	return true;
}

/** recordUsage for actions, which can't write themselves (dictation). */
export const record = internalMutation({
	args: { workspaceId: v.id("workspaces"), userId: v.optional(v.id("users")), agentId: v.optional(v.id("agents")), kind: v.union(...usageKinds.map((k) => v.literal(k))), model: v.optional(v.string()), costUsd: v.number() },
	handler: (ctx, entry) => recordUsage(ctx, entry),
});

type Line = { id: string | null; name: string; costUsd: number };

/** Sums rows by a key, biggest first. Costs are rounded to a millionth of a dollar. */
function group<R extends { costUsd: number }, K extends string | null>(rows: R[], key: (row: R) => K) {
	const sums = new Map<K, number>();
	for (const row of rows) sums.set(key(row), (sums.get(key(row)) ?? 0) + row.costUsd);
	return [...sums].map(([id, costUsd]) => ({ id, costUsd: round(costUsd) })).sort((a, b) => b.costUsd - a.costUsd);
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * A month's cost. People with `usage.view` get the whole workspace's, by agent, person, kind and
 * model; everyone else only their own share (`scope: "mine"`), by agent, kind and model.
 */
export async function usageReport(ctx: QueryCtx, member: Member, month = usageMonth(Date.now())) {
	if (!isUsageMonth(month)) throw new ConvexError("Month must look like 2026-10.");
	const all = can(member.role, "usage.view");
	const rows = await (all
		? ctx.db.query("usage").withIndex("by_bucket", (q) => q.eq("workspaceId", member.workspaceId).eq("month", month))
		: ctx.db.query("usage").withIndex("by_user", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId).eq("month", month))
	).take(MAX_ROWS);
	const names = namer(ctx);
	const byAgent: Line[] = await Promise.all(
		group(rows, (r) => r.agentId ?? null).map(async (l) => ({ ...l, name: l.id ? (await names.agent(l.id as Id<"agents">)).name : "Other" })),
	);
	const byPerson: Line[] = all
		? await Promise.all(group(rows, (r) => r.userId ?? null).map(async (l) => ({ ...l, name: l.id ? (await names.user(l.id as Id<"users">)).name : "Other" })))
		: [];
	return {
		month,
		scope: all ? ("workspace" as const) : ("mine" as const),
		total: round(rows.reduce((sum, r) => sum + r.costUsd, 0)),
		byAgent,
		byPerson,
		byKind: group(rows, (r) => r.kind).map((l) => ({ kind: l.id as UsageKind, costUsd: l.costUsd })),
		byModel: group(rows, (r) => r.model ?? null).flatMap((l) => (l.id ? [{ model: l.id, costUsd: l.costUsd }] : [])),
	};
}

/** The open workspace's cost for a month (default this one), as `usageReport` says. */
export const report = query({
	args: { month: v.optional(v.string()) },
	handler: async (ctx, { month }) => {
		const member = await getMember(ctx);
		return member ? usageReport(ctx, member, month) : null;
	},
});
