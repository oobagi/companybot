import { indexEntries, normalizeValue, sameText } from "@companybot/core";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { canSee } from "./chatOps";
import { getMember, nameOf, requireMember } from "./lib";
import {
	createRecord,
	fieldsOf,
	idsIn,
	resolveRefs,
	setArchived,
	toField,
	toRows,
	undoChange,
	updateRecord,
} from "./recordOps";

// Records: the app's API. Every workspace member can read every record; changing them
// takes `records.edit`. Lists page through indexes only, so they stay fast at any size.
// See wiki/data.md.

/**
 * Most rows a page returns. A record is at most RECORD_MAX_BYTES of values, so a full page
 * plus its names stays well inside a query's 16 MiB read limit. History entries hold old
 * and new values, so their pages are smaller.
 */
const PAGE_MAX = 50;
const HISTORY_PAGE_MAX = 20;

type Row = Awaited<ReturnType<typeof toRows>>[number];

const capped = (opts: { numItems: number; cursor: string | null }, max: number) => ({ ...opts, numItems: Math.min(opts.numItems, max) });

const empty = <T>(): PaginationResult<T> => ({ page: [], isDone: true, continueCursor: "" });

const bound = v.optional(v.union(v.string(), v.number(), v.boolean()));

/**
 * One type's records, a page at a time. Newest first by default; `sort` by "createdAt",
 * "updatedAt" or any field. `where` matches one field exactly (`eq`) or by range
 * (`gte` / `lte`, for numbers and dates), in that field's order. Filtering and sorting
 * use the same field, and only records with a value for it are listed. Fields holding
 * several values match exactly only, so each record shows up once. Links to an archived
 * record match nothing.
 */
export const list = query({
	args: {
		typeId: v.id("recordTypes"),
		archived: v.optional(v.boolean()),
		sort: v.optional(v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) })),
		where: v.optional(v.object({ field: v.string(), eq: bound, gte: bound, lte: bound })),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, { typeId, archived = false, sort, where, paginationOpts }): Promise<PaginationResult<Row>> => {
		const member = await getMember(ctx);
		const type = member && (await ctx.db.get(typeId));
		if (!member || type?.workspaceId !== member.workspaceId) return empty();
		const fields = await fieldsOf(ctx, typeId);
		const opts = capped(paginationOpts, PAGE_MAX);
		const order = sort?.order ?? "desc";

		const key = where?.field ?? (sort && !["createdAt", "updatedAt"].includes(sort.field) ? sort.field : undefined);
		if (!key) {
			const result = await ctx.db
				.query("records")
				.withIndex(sort?.field === "updatedAt" ? "by_type_updated" : "by_type", (q) => q.eq("typeId", typeId).eq("archived", archived))
				.order(order)
				.paginate(opts);
			return { ...result, page: await toRows(ctx, member.workspaceId, result.page.map((record) => ({ record, fields }))) };
		}

		if (archived) throw new ConvexError("Archived records can't be filtered or sorted by a field.");
		if (where && sort && sort.field !== where.field) throw new ConvexError("Filter and sort by the same field.");
		const field = fields.find((f) => f.key === key && !f.archived);
		if (!field) throw new ConvexError(`There's no field “${key}”.`);
		if (field.multiple && (sort || where?.gte !== undefined || where?.lte !== undefined))
			throw new ConvexError(`“${field.label}” holds several values, so it can only be matched exactly.`);
		const at = (raw: unknown) => (raw === undefined ? undefined : indexValue(field, raw));
		const eq = at(where?.eq);
		const gte = at(where?.gte);
		const lte = at(where?.lte);

		let rows: PaginationResult<Doc<"recordValues">>;
		if (field.kind === "link") {
			if (sort || eq === undefined) throw new ConvexError(`“${field.label}” can only be matched exactly.`);
			if ((await ctx.db.get(eq as Id<"records">))?.archived) return empty();
			rows = await ctx.db
				.query("recordValues")
				.withIndex("by_ref", (q) => q.eq("ref", eq as Id<"records">).eq("fieldId", field._id))
				.order(order)
				.paginate(opts);
		} else if (["number", "currency", "checkbox"].includes(field.kind)) {
			rows = await ctx.db
				.query("recordValues")
				.withIndex("by_field_num", (q) => {
					const f = q.eq("fieldId", field._id);
					if (eq !== undefined) return f.eq("num", eq as number);
					const lo = gte === undefined ? f : f.gte("num", gte as number);
					return lte === undefined ? lo : lo.lte("num", lte as number);
				})
				.order(order)
				.paginate(opts);
		} else {
			// Values are always set on rows for this field, so the lower bound skips none.
			rows = await ctx.db
				.query("recordValues")
				.withIndex("by_field_str", (q) => {
					const f = q.eq("fieldId", field._id);
					if (eq !== undefined) return f.eq("str", eq as string);
					const lo = gte === undefined ? f : f.gte("str", gte as string);
					return lte === undefined ? lo : lo.lte("str", lte as string);
				})
				.order(order)
				.paginate(opts);
		}
		// Long text matches by a hash of its key, so check the value itself.
		const wanted = where?.eq === undefined ? undefined : normalizeValue(toField(field), where.eq, "filter");
		const records = [];
		for (const row of rows.page) {
			const record = await ctx.db.get(row.recordId);
			if (!record) continue;
			if (wanted && "value" in wanted && wanted.value !== null && !sameText(toField(field), record.values[field.key], wanted.value)) continue;
			records.push({ record, fields });
		}
		return { ...rows, page: await toRows(ctx, member.workspaceId, records) };
	},
});

/** What a filter value looks like in the index, so `where` uses the same rules as saving. */
function indexValue(field: Doc<"recordFields">, raw: unknown) {
	const result = normalizeValue({ ...toField(field), multiple: false }, raw, "filter");
	if ("error" in result) throw new ConvexError(result.error);
	const [entry] = indexEntries(toField(field), result.value);
	if (!entry) throw new ConvexError(`Pick a value for “${field.label}”.`);
	return "str" in entry ? entry.str : "num" in entry ? entry.num : entry.ref;
}

/** One record with its type and fields, or null if it isn't in your workspace. */
export const get = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return null;
		const type = (await ctx.db.get(record.typeId))!;
		const fields = await fieldsOf(ctx, record.typeId);
		const [row] = await toRows(ctx, member.workspaceId, [{ record, fields }]);
		return {
			...row!,
			type: { _id: type._id, key: type.key, name: type.name, plural: type.plural },
			fields: fields.filter((f) => !f.archived).map((f) => ({ _id: f._id, ...toField(f) })),
		};
	},
});

/** Live records that link to this one ("deals for this client"), optionally through one field. None if it's archived. */
export const linked = query({
	args: { recordId: v.id("records"), fieldId: v.optional(v.id("recordFields")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, fieldId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId || record.archived) return empty<Row & { fieldId: Id<"recordFields"> }>();
		const rows = await ctx.db
			.query("recordValues")
			.withIndex("by_ref", (q) => (fieldId ? q.eq("ref", recordId).eq("fieldId", fieldId) : q.eq("ref", recordId)))
			.paginate(capped(paginationOpts, PAGE_MAX));
		const fields = new Map<Id<"recordTypes">, Doc<"recordFields">[]>();
		const items: { record: Doc<"records">; fields: Doc<"recordFields">[]; fieldId: Id<"recordFields"> }[] = [];
		for (const row of rows.page) {
			const record = await ctx.db.get(row.recordId);
			if (!record) continue;
			if (!fields.has(record.typeId)) fields.set(record.typeId, await fieldsOf(ctx, record.typeId));
			items.push({ record, fields: fields.get(record.typeId)!, fieldId: row.fieldId });
		}
		const rowsOut = await toRows(ctx, member.workspaceId, items);
		return { ...rows, page: rowsOut.map((row, i) => ({ ...row, fieldId: items[i]!.fieldId })) };
	},
});

/** Live records whose title or text matches, best first. Optionally one type. */
export const search = query({
	args: { query: v.string(), typeId: v.optional(v.id("recordTypes")) },
	handler: async (ctx, { query: text, typeId }) => {
		const member = await getMember(ctx);
		if (!member || !text.trim()) return [];
		const records = await ctx.db
			.query("records")
			.withSearchIndex("search", (q) => {
				const s = q.search("searchText", text).eq("workspaceId", member.workspaceId).eq("archived", false);
				return typeId ? s.eq("typeId", typeId) : s;
			})
			.take(20);
		return records.map((r) => ({ _id: r._id, typeId: r.typeId, title: r.title }));
	},
});

/** A record's history, newest first. */
export const history = query({
	args: { recordId: v.id("records"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return empty<Entry>();
		const result = await ctx.db
			.query("recordHistory")
			.withIndex("by_record", (q) => q.eq("recordId", recordId))
			.order("desc")
			.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
		const fields = await fieldsOf(ctx, record.typeId);
		return { ...result, page: await toEntries(ctx, member.workspaceId, result.page.map((entry) => ({ entry, fields }))) };
	},
});

/** Every record and field change in the workspace, newest first. For Settings → Activity. */
export const activity = query({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, { paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return empty<Entry & { record: string | null; type: string }>();
		const result = await ctx.db
			.query("recordHistory")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.order("desc")
			.paginate(capped(paginationOpts, HISTORY_PAGE_MAX));
		const fields = new Map<Id<"recordTypes">, Doc<"recordFields">[]>();
		for (const e of result.page) if (!fields.has(e.typeId)) fields.set(e.typeId, await fieldsOf(ctx, e.typeId));
		const entries = await toEntries(ctx, member.workspaceId, result.page.map((entry) => ({ entry, fields: fields.get(entry.typeId)! })));
		const page = [];
		for (const [i, e] of result.page.entries()) {
			const record = e.recordId && (await ctx.db.get(e.recordId));
			page.push({ ...entries[i]!, record: record ? record.title : null, type: (await ctx.db.get(e.typeId))?.name ?? "" });
		}
		return { ...result, page };
	},
});

type Entry = Awaited<ReturnType<typeof toEntries>>[number];

/** History entries, display-ready, with names resolved once for the page. */
async function toEntries(ctx: QueryCtx, workspaceId: Id<"workspaces">, items: { entry: Doc<"recordHistory">; fields: Doc<"recordFields">[] }[]) {
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

/** Names for ids a page couldn't resolve within its read budget (`unresolved`). Up to 200 at a time. */
export const refs = query({
	args: { ids: v.array(v.string()) },
	handler: async (ctx, { ids }) => {
		const member = await getMember(ctx);
		if (!member) return {};
		if (ids.length > 200) throw new ConvexError("Ask for up to 200 at a time.");
		return (await resolveRefs(ctx, member.workspaceId, ids)).refs;
	},
});

/** Chat messages that reference this record and that you can see, newest first. */
export const discussion = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return [];
		const mentions = await ctx.db
			.query("recordMentions")
			.withIndex("by_record", (q) => q.eq("recordId", recordId))
			.order("desc")
			.take(50);
		const out = [];
		for (const m of mentions) {
			const message = await ctx.db.get(m.messageId);
			const chat = await ctx.db.get(m.chatId);
			if (!message || message.deleted || !chat || !(await canSee(ctx, chat, member))) continue;
			const author = message.authorUserId
				? await nameOf(ctx, message.authorUserId)
				: ((message.authorAgentId && (await ctx.db.get(message.authorAgentId))?.name) ?? "");
			out.push({ messageId: message._id, chatId: chat._id, threadId: message.threadId ?? null, text: message.text, author, time: message._creationTime });
		}
		return out;
	},
});

// Field keys → values. Each value is checked against its field (core's normalizeValue); null clears.
const values = v.record(v.string(), v.any());

export const create = mutation({
	args: { typeId: v.id("recordTypes"), values },
	handler: async (ctx, { typeId, values }) => createRecord(ctx, { member: await requireMember(ctx) }, typeId, values),
});

/** Changes only the fields given. */
export const update = mutation({
	args: { recordId: v.id("records"), values },
	handler: async (ctx, { recordId, values }) => updateRecord(ctx, { member: await requireMember(ctx) }, recordId, values),
});

export const archive = mutation({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		await setArchived(ctx, { member: await requireMember(ctx) }, recordId, true);
	},
});

export const restore = mutation({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		await setArchived(ctx, { member: await requireMember(ctx) }, recordId, false);
	},
});

/** Reverses one history entry. Refused if what it changed has changed again since. */
export const undo = mutation({
	args: { historyId: v.id("recordHistory") },
	handler: async (ctx, { historyId }) => {
		await undoChange(ctx, { member: await requireMember(ctx) }, historyId);
	},
});

