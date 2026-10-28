import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { type Member, capped, memo, nameOf } from "./lib";
import { currencyOf, fieldsOf, idsIn, resolveRefs, typeTrashed } from "./recordOps";
import { type Condition, type Group, type Sort, findRecords } from "./recordQuery";

// Reads the app (records.ts) and agents (recordTools.ts) share, so their lists, search and
// "what links here" can't drift. Callers check access first; these only read.

/**
 * Most records a page returns. A record is at most RECORD_MAX_BYTES of values, so a full page
 * plus its names stays well inside a query's 16 MiB read limit.
 */
export const PAGE_MAX = 50;

/** A record with its type's fields, ready for `toRows`. */
export type RecordItem = { record: Doc<"records">; fields: Doc<"recordFields">[] };

/** Each type's fields, read once per call however many records share it. */
export const fieldsByType = (ctx: QueryCtx) => memo((typeId: Id<"recordTypes">) => fieldsOf(ctx, typeId));

/** One page of a type's records matching every condition, in the workspace's currency (recordQuery.findRecords). */
export async function listRecords(
	ctx: QueryCtx,
	workspaceId: Id<"workspaces">,
	type: { typeId: Id<"recordTypes">; fields: Doc<"recordFields">[] },
	opts: { archived: boolean; conditions: Condition[]; group?: Group; sort?: Sort; paginationOpts: PaginationOptions },
) {
	return findRecords(ctx, { workspaceId, ...type, ...opts, currency: await currencyOf(ctx, workspaceId), pageMax: PAGE_MAX });
}

/** Live records whose title or text matches, best first, leaving out databases in Trash. Optionally one type. */
export async function searchRecords(
	ctx: QueryCtx,
	workspaceId: Id<"workspaces">,
	text: string,
	{ typeId, limit }: { typeId?: Id<"recordTypes">; limit: number },
): Promise<RecordItem[]> {
	const records = await ctx.db
		.query("records")
		.withSearchIndex("search", (q) => {
			const s = q.search("searchText", text).eq("workspaceId", workspaceId).eq("archived", false);
			return typeId ? s.eq("typeId", typeId) : s;
		})
		.take(limit);
	const fields = fieldsByType(ctx);
	const trashed = typeTrashed(ctx);
	const items = [];
	for (const record of records) if (!(await trashed(record.typeId))) items.push({ record, fields: await fields(record.typeId) });
	return items;
}

/**
 * Records that link to `recordId` ("deals for this client"), optionally through one field,
 * a page at a time. Only live records have index rows, so ones in Trash never show; nor do
 * records of a database in Trash, or links through a field in Trash.
 */
export async function linkingRecords(
	ctx: QueryCtx,
	recordId: Id<"records">,
	{ fieldId, paginationOpts }: { fieldId?: Id<"recordFields">; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RecordItem & { fieldId: Id<"recordFields"> }>> {
	const rows = await ctx.db
		.query("recordValues")
		.withIndex("by_ref", (q) => (fieldId ? q.eq("ref", recordId).eq("fieldId", fieldId) : q.eq("ref", recordId)))
		.paginate(capped(paginationOpts, PAGE_MAX));
	const fields = fieldsByType(ctx);
	const trashed = typeTrashed(ctx);
	const page = [];
	for (const row of rows.page) {
		const record = await ctx.db.get(row.recordId);
		if (!record || (await trashed(record.typeId))) continue;
		const recordFields = await fields(record.typeId);
		if (recordFields.some((f) => f._id === row.fieldId && !f.archived)) page.push({ record, fields: recordFields, fieldId: row.fieldId });
	}
	return { ...rows, page };
}

/** History entries hold old and new values, so their pages are smaller than lists. */
const HISTORY_PAGE_MAX = 20;

/** History entries, display-ready, with names resolved once for the page. */
export async function toEntries(ctx: QueryCtx, workspaceId: Id<"workspaces">, items: { entry: Doc<"recordHistory">; fields: Doc<"recordFields">[] }[]) {
	const idsOf = items.map(({ entry, fields }) =>
		entry.recordId ? entry.changes.flatMap((c) => [...idsIn(fields, { [c.key]: c.old }), ...idsIn(fields, { [c.key]: c.new })]) : [],
	);
	const { refs } = await resolveRefs(ctx, workspaceId, idsOf.flat());
	return Promise.all(
		items.map(async ({ entry: e, fields }, i) => {
			const field = e.fieldId && fields.find((f) => f._id === e.fieldId);
			return {
				_id: e._id,
				time: e._creationTime,
				action: e.action,
				subject: e.subject ?? null,
				recordId: e.recordId ?? null,
				/** Field changes: the field's current label. */
				field: field ? field.label : null,
				changes: e.changes.map((c) => ({ ...c, label: fields.find((f) => f.key === c.key)?.label ?? c.key })),
				refs: Object.fromEntries(idsOf[i]!.filter((id) => refs[id]).map((id) => [id, refs[id]!])),
				user: await nameOf(ctx, e.userId),
				agent: e.agentId ? ((await ctx.db.get(e.agentId))?.name ?? null) : null,
				undoes: e.undoes ?? null,
				undone: !!e.undoneBy,
			};
		}),
	);
}

/** A record's history, newest first. */
export async function historyAs(ctx: QueryCtx, member: Member, record: Doc<"records">, paginationOpts: PaginationOptions) {
	const result = await ctx.db
		.query("recordHistory")
		.withIndex("by_record", (q) => q.eq("recordId", record._id))
		.order("desc")
		.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
	const fields = await fieldsOf(ctx, record.typeId);
	return { ...result, page: await toEntries(ctx, member.workspaceId, result.page.map((entry) => ({ entry, fields }))) };
}

/** Every record and field change in the workspace, newest first, with each one's record and database. */
export async function activityAs(ctx: QueryCtx, member: Member, paginationOpts: PaginationOptions) {
	const result = await ctx.db
		.query("recordHistory")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.order("desc")
		.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
	const fields = fieldsByType(ctx);
	const entries = await toEntries(ctx, member.workspaceId, await Promise.all(result.page.map(async (entry) => ({ entry, fields: await fields(entry.typeId) }))));
	const page = [];
	for (const [i, e] of result.page.entries()) {
		const record = e.recordId && (await ctx.db.get(e.recordId));
		page.push({ ...entries[i]!, record: record ? record.title : null, type: (await ctx.db.get(e.typeId))?.name ?? "" });
	}
	return { ...result, page };
}
