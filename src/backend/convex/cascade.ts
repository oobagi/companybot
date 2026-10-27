import { getDocumentSize, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { type Get, type Root, type Scope, type Step, childrenOf, edgesOf } from "./lifecycle";

// Deletes what belonged to something that went, as lifecycle.ts says, a little at a time:
// each run reads one page of one edge, deletes it (children first), saves where it got to
// and schedules the next run. So no transaction nears Convex's limits (16 MiB read, 16,000
// writes, 4,096 index ranges) however big a workspace or its rows get. Callers end access
// first: the cascade only cleans up.

const MiB = 1 << 20;
/** What one run reads, at most: half of Convex's 16 MiB. Rows written were read first, so writes stay under it too. */
const READ_BYTES = 8 * MiB;
/** The biggest a document can be. Every read keeps room for one, so the budget is never overrun. */
const MAX_DOC = MiB;
/** The page: up to this many rows or about half the budget, leaving the rest for their children. */
const PAGE_ROWS = 100;
const PAGE_BYTES = READ_BYTES / 2 - MAX_DOC;
/** Rows deleted or patched per run (Convex allows 16,000). */
const WRITES = 2_000;
/** A cascade untouched this long stopped (a run failed); the cron starts it again. */
const STALLED_MS = 10 * 60_000;
/** Failed runs in a row before it's marked stuck and left for someone to look at (`retry`). */
const MAX_ATTEMPTS = 3;

/** Names what's going, so callers can tell it's still being deleted. */
const keyOf = (scope: Scope, root: Root) =>
	[scope, root.workspaceId, root.userId, root.connectorId, root.automationInstallId].filter(Boolean).join(":");

/** Starts deleting what belongs to `root`. Access must already have ended. */
export async function startCascade(ctx: MutationCtx, scope: Scope, root: Root) {
	const id = await ctx.db.insert("cascades", { scope, root, key: keyOf(scope, root), edge: "", cursor: null, updatedAt: Date.now() });
	await ctx.db.patch(id, { run: await ctx.scheduler.runAfter(0, internal.cascade.step, { id }) });
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

/** What's left of this run's reads and writes. */
type Budget = { bytes: number; writes: number };
/** Room for one more read (of a whole document, at most) and the write that follows. */
const room = (budget: Budget) => budget.bytes >= MAX_DOC && budget.writes > 0;
const spend = (budget: Budget, doc: object | null) => void (budget.bytes -= doc ? getDocumentSize(doc as Any) : 0);

/** One page of one edge per run (Convex allows one paginated query per function). */
export const step = internalMutation({
	args: { id: v.id("cascades") },
	handler: async (ctx, { id }) => {
		const job = await ctx.db.get(id);
		if (!job || job.stuck) return;
		const edges = edgesOf(job.scope);
		// Found by name, so a deploy that changes lifecycle.ts mid-cascade can't misplace it: an
		// edge it no longer knows starts it over, rereading ranges that are already empty.
		const found = edges.findIndex((e) => nameOf(e) === job.edge);
		const [at, cursor] = found < 0 ? [0, null] : [found, job.cursor];
		const edge = edges[at];
		if (!edge) return finish(ctx, job);
		const budget: Budget = { bytes: READ_BYTES, writes: WRITES };
		const { page, isDone, continueCursor } = await range(ctx, edge.table, edge.index as string, valuesOf(edge, job.root)).paginate({
			cursor,
			numItems: job.rows ?? PAGE_ROWS,
			maximumBytesRead: PAGE_BYTES,
		});
		for (const row of page) spend(budget, row);
		// Rows `where` reads to decide, once each: a member's mentions are mostly in a few chats.
		const seen = new Map<string, object | null>();
		const get: Get = async (id) => {
			if (!seen.has(id)) {
				const doc = await ctx.db.get(id);
				spend(budget, doc);
				seen.set(id, doc);
			}
			return seen.get(id) as Any;
		};
		// Rows handled before running out of room. The rows `where` skips (and scrubbed ones) stay in the
		// range, so the next run reads only this many: it fits, and the cursor moves past them.
		let handled = 0;
		let whole = true;
		for (const row of page) {
			// Out of room: this run saves what it did, and the next reads the page again (deleted rows are gone from it).
			if (!room(budget)) {
				whole = false;
				break;
			}
			if (edge.where && !(await edge.where(get, row, job.root))) {
				handled++;
				continue;
			}
			if (edge.scrub) {
				await ctx.db.patch(row._id, edge.scrub(row));
				budget.writes--;
				handled++;
				continue;
			}
			if (!(await deleteChildren(ctx, edge.table, row, budget))) {
				whole = false;
				break;
			}
			await edge.onDelete?.(ctx, row, job.root);
			await ctx.db.delete(row._id);
			budget.writes--;
			handled++;
		}
		const next = edges[at + 1];
		if (whole && isDone && !next) return finish(ctx, job);
		const resume = !whole ? { edge: nameOf(edge), cursor } : isDone ? { edge: nameOf(next!), cursor: null } : { edge: nameOf(edge), cursor: continueCursor };
		const rows = whole ? undefined : Math.max(handled, 1);
		const run = await ctx.scheduler.runAfter(0, internal.cascade.step, { id });
		await ctx.db.patch(id, { ...resume, rows, run, attempts: undefined, error: undefined, updatedAt: Date.now() });
	},
});

/** Every edge is done: a workspace goes last, then the cascade. The rest were gone before it started. */
async function finish(ctx: MutationCtx, job: Doc<"cascades">) {
	const { workspaceId } = job.root;
	if (job.scope === "workspace" && workspaceId && (await ctx.db.get(workspaceId))) await ctx.db.delete(workspaceId);
	await ctx.db.delete(job._id);
}

/** Deletes the row's children, one read at a time while there's room. Returns whether they're all gone. */
async function deleteChildren(ctx: MutationCtx, table: TableNames, row: Doc<TableNames>, budget: Budget) {
	for (const child of childrenOf(table)) {
		if (!room(budget)) return false;
		for await (const r of range(ctx, child.table, child.index as string, [[child.field, row._id]])) {
			spend(budget, r);
			await ctx.db.delete(r._id);
			budget.writes--;
			if (!room(budget)) return false;
		}
	}
	return budget.writes > 0;
}

/**
 * Runs every 15 minutes (crons.ts): restarts cascades whose last run failed. After
 * MAX_ATTEMPTS failures in a row one is marked stuck, with its error, and left alone:
 * see wiki/architecture.md#data-lifecycle for how to find and resume one.
 */
export const resume = internalMutation({
	args: {},
	handler: async (ctx) => {
		const stalled = await ctx.db
			.query("cascades")
			.withIndex("by_updated", (q) => q.eq("stuck", undefined).lt("updatedAt", Date.now() - STALLED_MS))
			.take(100);
		for (const job of stalled) {
			const run = job.run && (await ctx.db.system.get(job.run));
			// Still queued or running: slow, not failed.
			if (run?.state.kind === "pending" || run?.state.kind === "inProgress") continue;
			const attempts = (job.attempts ?? 0) + 1;
			const error = run?.state.kind === "failed" ? (run.state.error ?? "Failed.") : "Its last run stopped without an error.";
			if (attempts >= MAX_ATTEMPTS) {
				console.error(`Cascade ${job._id} (${job.key}) is stuck on ${job.edge || "its first edge"}: ${error}`);
				await ctx.db.patch(job._id, { attempts, error, stuck: true, updatedAt: Date.now() });
				continue;
			}
			await ctx.db.patch(job._id, { attempts, error, updatedAt: Date.now(), run: await ctx.scheduler.runAfter(0, internal.cascade.step, { id: job._id }) });
		}
	},
});

/** Starts a stuck cascade again, once its cause is fixed: `npx convex run cascade:retry '{"id":"..."}'`. Never delete one instead: its rows would stay. */
export const retry = internalMutation({
	args: { id: v.id("cascades") },
	handler: async (ctx, { id }) => {
		await ctx.db.patch(id, { stuck: undefined, attempts: undefined, error: undefined, updatedAt: Date.now() });
		await ctx.db.patch(id, { run: await ctx.scheduler.runAfter(0, internal.cascade.step, { id }) });
	},
});
