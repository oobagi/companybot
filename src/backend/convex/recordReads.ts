import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { currencyOf, fieldsOf, typeTrashed } from "./recordOps";
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
export function fieldsByType(ctx: QueryCtx) {
	const cache = new Map<Id<"recordTypes">, Promise<Doc<"recordFields">[]>>();
	return (typeId: Id<"recordTypes">) => {
		let fields = cache.get(typeId);
		if (!fields) cache.set(typeId, (fields = fieldsOf(ctx, typeId)));
		return fields;
	};
}

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
		.paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, PAGE_MAX) });
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
