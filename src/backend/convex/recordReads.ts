import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { outsiderWords } from "@companybot/core";
import { type Member, capped, memo, nameOf } from "./lib";
import { currencyOf, fieldsOf, idsIn, resolveRefs, requireType, typeTrashed, typeVisible, typesOf } from "./recordOps";
import { type Condition, type Group, type Owner, type Sort, findRecords } from "./recordQuery";

// Reads the app (records.ts) and agents (recordTools.ts) share, so their lists, search and
// "what links here" can't drift. Callers check the database they name; reads that span databases
// (search, what links here, Activity) drop the ones the person can't see.

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
	opts: { archived: boolean; conditions: Condition[]; group?: Group; sort?: Sort; owner?: Owner; paginationOpts: PaginationOptions },
) {
	return findRecords(ctx, { workspaceId, ...type, ...opts, currency: await currencyOf(ctx, workspaceId), pageMax: PAGE_MAX });
}

/**
 * What one search call may read: hits it walks past (in databases the person can't see) count too.
 * Under the search index's 1,024-candidate cap, and leaving the query room to resolve its rows' links
 * (recordOps REFS_BYTES).
 */
const SEARCH_ROWS = 500;
const SEARCH_BYTES = 2 * 1024 * 1024;

/**
 * Live records whose title or text matches, best first, in live databases the person can see. Optionally
 * one type. One page of the search index, filtered to those databases there, so it reads past hidden hits
 * until it has `limit` results, runs out, or reaches SEARCH_ROWS or SEARCH_BYTES; `cursor` is the index's
 * own, continuing right after what it read. Null when there's nothing more.
 */
export async function searchRecords(
	ctx: QueryCtx,
	member: Member,
	text: string,
	{ typeId, limit, cursor }: { typeId?: Id<"recordTypes">; limit: number; cursor?: string | null },
): Promise<{ items: RecordItem[]; cursor: string | null }> {
	const fields = fieldsByType(ctx);
	const visible = typeVisible(ctx, { ...member, replyId: undefined });
	const typeIds: Id<"recordTypes">[] = [];
	for (const t of await typesOf(ctx, member.workspaceId)) if (!t.archived && (!typeId || t._id === typeId) && (await visible(t._id))) typeIds.push(t._id);
	if (typeIds.length === 0) return { items: [], cursor: null };
	const result = await ctx.db
		.query("records")
		.withSearchIndex("search", (q) => {
			const s = q.search("searchText", text).eq("workspaceId", member.workspaceId).eq("archived", false);
			return typeId ? s.eq("typeId", typeId) : s;
		})
		.filter((q) => q.or(...typeIds.map((id) => q.eq(q.field("typeId"), id))))
		.paginate({ numItems: limit, cursor: cursor ?? null, maximumRowsRead: SEARCH_ROWS, maximumBytesRead: SEARCH_BYTES });
	const items = [];
	for (const record of result.page) {
		await requireType(ctx, member, record.typeId);
		items.push({ record, fields: await fields(record.typeId) });
	}
	return { items, cursor: result.isDone ? null : result.continueCursor };
}

/**
 * Records that link to `recordId` ("deals for this client"), optionally through one field,
 * a page at a time. Only live records have index rows, so ones in Archive never show; nor do
 * records of a database in Archive, or links through a field in Archive.
 */
export async function linkingRecords(
	ctx: QueryCtx,
	member: Member,
	recordId: Id<"records">,
	{ fieldId, paginationOpts }: { fieldId?: Id<"recordFields">; paginationOpts: PaginationOptions },
): Promise<PaginationResult<RecordItem & { fieldId: Id<"recordFields"> }>> {
	const rows = await ctx.db
		.query("recordValues")
		.withIndex("by_ref", (q) => (fieldId ? q.eq("ref", recordId).eq("fieldId", fieldId) : q.eq("ref", recordId)))
		.paginate(capped(paginationOpts, PAGE_MAX));
	const fields = fieldsByType(ctx);
	const trashed = typeTrashed(ctx);
	const visible = typeVisible(ctx, { ...member, replyId: undefined });
	const page = [];
	for (const row of rows.page) {
		const record = await ctx.db.get(row.recordId);
		if (!record || (await trashed(record.typeId)) || !(await visible(record.typeId))) continue;
		const recordFields = await fields(record.typeId);
		if (recordFields.some((f) => f._id === row.fieldId && !f.archived)) {
			await requireType(ctx, member, record.typeId);
			page.push({ record, fields: recordFields, fieldId: row.fieldId });
		}
	}
	return { ...rows, page };
}

/** History entries hold old and new values, so their pages are smaller than lists. */
const HISTORY_PAGE_MAX = 20;

/**
 * Who made a change, for history and Activity: a member's name, or someone outside an agent acted for as
 * Public ("(555) 123-4567 by text"), shown with the agent as "Front desk, for (555) 123-4567 by text".
 */
export const changedBy = (ctx: QueryCtx, e: Pick<Doc<"recordHistory">, "userId" | "contact">) =>
	e.userId ? nameOf(ctx, e.userId) : Promise.resolve(e.contact ? outsiderWords(e.contact) : "Someone");

/** History entries, display-ready, with names resolved once for the page. */
export async function toEntries(ctx: QueryCtx, member: Member, items: { entry: Doc<"recordHistory">; fields: Doc<"recordFields">[] }[]) {
	const idsOf = items.map(({ entry, fields }) =>
		entry.recordId ? entry.changes.flatMap((c) => [...idsIn(fields, { [c.key]: c.old }), ...idsIn(fields, { [c.key]: c.new })]) : [],
	);
	const { refs } = await resolveRefs(ctx, member, idsOf.flat());
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
				user: await changedBy(ctx, e),
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
	return { ...result, page: await toEntries(ctx, member, result.page.map((entry) => ({ entry, fields }))) };
}

/**
 * Every record and field change in the workspace, newest first, with each one's record and database.
 * Changes in databases the person can't see are left out, so a page can come back short.
 */
export async function activityAs(ctx: QueryCtx, member: Member, paginationOpts: PaginationOptions) {
	const result = await ctx.db
		.query("recordHistory")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.order("desc")
		.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
	const fields = fieldsByType(ctx);
	const visible = typeVisible(ctx, { ...member, replyId: undefined });
	const shown = [];
	for (const entry of result.page) if (await visible(entry.typeId)) {
		await requireType(ctx, member, entry.typeId);
		shown.push(entry);
	}
	const entries = await toEntries(ctx, member, await Promise.all(shown.map(async (entry) => ({ entry, fields: await fields(entry.typeId) }))));
	const page = [];
	for (const [i, e] of shown.entries()) {
		const record = e.recordId && (await ctx.db.get(e.recordId));
		page.push({ ...entries[i]!, record: record ? record.title : null, type: (await ctx.db.get(e.typeId))?.name ?? "" });
	}
	return { ...result, page };
}
