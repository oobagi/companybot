import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { type Root, type Scope, type Step, childrenOf, edgesOf, lifecycle, rootOf } from "./lifecycle";

// Deletes what belonged to something that went, as lifecycle.ts says, a little at a time:
// each run reads one page of one edge, deletes it (children first), saves where it got to
// and schedules the next run. So no transaction nears Convex's limits (16k writes, 16 MiB
// read) however big a workspace gets. Callers end access first: the cascade only cleans up.

/** Rows read per run, and their bytes, so a page of big rows stays well under 16 MiB. */
const PAGE_ROWS = 100;
const PAGE_BYTES = 2_000_000;
/** Children deleted per run, across the page (agent versions are the biggest, ~80 KB). */
const CHILD_ROWS = 100;
/** A cascade untouched this long stopped (a run failed); the cron starts it again. */
const STALLED_MS = 10 * 60_000;

/** Names what's going, so callers can tell it's still being deleted. */
const keyOf = (scope: Scope, root: Root) =>
	[scope, root.workspaceId, root.userId, root.connectorId, root.automationInstallId].filter(Boolean).join(":");

/** Starts deleting what belongs to `root`. Access must already have ended. */
export async function startCascade(ctx: MutationCtx, scope: Scope, root: Root) {
	const id = await ctx.db.insert("cascades", { scope, root, key: keyOf(scope, root), edge: "", cursor: null, updatedAt: Date.now() });
	await ctx.scheduler.runAfter(0, internal.cascade.step, { id });
}

/** Whether this is still being deleted. Rejoining or reinstalling waits, so old rows never come back. */
export const cascading = async (ctx: QueryCtx, scope: Scope, root: Root) =>
	!!(await ctx.db
		.query("cascades")
		.withIndex("by_key", (q) => q.eq("key", keyOf(scope, root)))
		.first());

// The registry names tables, indexes and fields as data, so these queries are untyped;
// tests/lifecycle.test.ts checks every name against the schema.
type Any = any;

/** The rows of `index` whose leading fields equal `eq`. */
const range = (ctx: QueryCtx, table: TableNames, index: string, eq: [string, unknown][]) =>
	ctx.db.query(table).withIndex(index as Any, (q: Any) => eq.reduce((r: Any, [field, value]) => r.eq(field, value), q));

/** An edge's index values, read from the root. */
const valuesOf = (edge: Step, root: Root): [string, unknown][] =>
	edge.eq.map((k) => (Array.isArray(k) ? [k[0], root[k[1]]] : [k, root[k]]));

const nameOf = (edge: Step) => `${edge.table}.${edge.index as string}`;

/** One page of one edge per run. */
export const step = internalMutation({
	args: { id: v.id("cascades") },
	handler: async (ctx, { id }) => {
		const job = await ctx.db.get(id);
		if (!job) return;
		const edges = edgesOf(job.scope);
		// Found by name, so a deploy that changes lifecycle.ts mid-cascade can't misplace it: an
		// edge it no longer knows starts it over, rereading ranges that are already empty.
		const found = edges.findIndex((e) => nameOf(e) === job.edge);
		const [at, cursor] = found < 0 ? [0, null] : [found, job.cursor];
		const edge = edges[at];
		if (!edge) return finish(ctx, job);
		const { page, isDone, continueCursor } = await range(ctx, edge.table, edge.index as string, valuesOf(edge, job.root)).paginate({
			cursor,
			numItems: PAGE_ROWS,
			maximumBytesRead: PAGE_BYTES,
		});
		let budget = CHILD_ROWS;
		let whole = true;
		for (const row of page) {
			if (edge.where && !(await edge.where(ctx, row, job.root))) continue;
			if (edge.scrub) {
				await ctx.db.patch(row._id, edge.scrub(row));
				continue;
			}
			const left = await deleteChildren(ctx, edge.table, row, budget);
			// Too many children for this run: the row stays, and the next run reads this page again.
			if (left === null) {
				whole = false;
				break;
			}
			budget = left;
			await deleteRow(ctx, edge.table, row);
		}
		const next = edges[at + 1];
		if (whole && isDone && !next) return finish(ctx, job);
		const resume = !whole ? { edge: nameOf(edge), cursor } : isDone ? { edge: nameOf(next!), cursor: null } : { edge: nameOf(edge), cursor: continueCursor };
		await ctx.db.patch(id, { ...resume, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.cascade.step, { id });
	},
});

/** Every edge is done: the root row goes last, then the cascade. */
async function finish(ctx: MutationCtx, job: Doc<"cascades">) {
	const root = rootOf(job.scope, job.root);
	if (root) await ctx.db.delete(root);
	await ctx.db.delete(job._id);
}

/** Deletes up to `budget` of the row's children. Returns what's left of it, or null if some remain. */
async function deleteChildren(ctx: MutationCtx, table: TableNames, row: Doc<TableNames>, budget: number) {
	for (const child of childrenOf(table)) {
		const rows = await range(ctx, child.table, child.index as string, [[child.field, row._id]]).take(budget + 1);
		for (const r of rows.slice(0, budget)) await deleteRow(ctx, child.table, r);
		if (rows.length > budget) return null;
		budget -= rows.length;
	}
	return budget;
}

async function deleteRow(ctx: MutationCtx, table: TableNames, row: Doc<TableNames>) {
	const files = lifecycle[table].files as ((row: Doc<TableNames>) => Id<"_storage">[]) | undefined;
	for (const file of files?.(row) ?? []) await ctx.storage.delete(file);
	await ctx.db.delete(row._id);
}

/** Runs every 15 minutes (crons.ts): restarts cascades whose last run failed. */
export const resume = internalMutation({
	args: {},
	handler: async (ctx) => {
		const stalled = await ctx.db
			.query("cascades")
			.withIndex("by_updated", (q) => q.lt("updatedAt", Date.now() - STALLED_MS))
			.take(100);
		for (const job of stalled) {
			await ctx.db.patch(job._id, { updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.cascade.step, { id: job._id });
		}
	},
});
