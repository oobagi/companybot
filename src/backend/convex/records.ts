import { type FieldValue, indexEntries, normalizeValue } from "@companybot/core";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { canSee } from "./chatOps";
import { getMember, nameOf, requireMember } from "./lib";
import {
	createRecord,
	fieldsOf,
	refsOf,
	setArchived,
	toField,
	toRow,
	undoChange,
	updateRecord,
} from "./recordOps";

// Records: the app's API. Every workspace member can read every record; changing them
// takes `records.edit`. Lists page through indexes only, so they stay fast at any size.
// See wiki/data.md.

/** Most rows a page returns. */
const PAGE_MAX = 100;

type Row = Awaited<ReturnType<typeof toRow>>;

const empty = <T>(): PaginationResult<T> => ({ page: [], isDone: true, continueCursor: "" });

const bound = v.optional(v.union(v.string(), v.number(), v.boolean()));

/**
 * One type's records, a page at a time. Newest first by default; `sort` by "createdAt",
 * "updatedAt" or any field. `where` matches one field exactly (`eq`) or by range
 * (`gte` / `lte`, for numbers and dates), in that field's order. Filtering and sorting
 * use the same field, and only records with a value for it are listed.
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
		const opts = { ...paginationOpts, numItems: Math.min(paginationOpts.numItems, PAGE_MAX) };
		const order = sort?.order ?? "desc";

		const key = where?.field ?? (sort && !["createdAt", "updatedAt"].includes(sort.field) ? sort.field : undefined);
		if (!key) {
			const result = await ctx.db
				.query("records")
				.withIndex(sort?.field === "updatedAt" ? "by_type_updated" : "by_type", (q) => q.eq("typeId", typeId).eq("archived", archived))
				.order(order)
				.paginate(opts);
			return { ...result, page: await Promise.all(result.page.map((r) => toRow(ctx, r, fields))) };
		}

		if (archived) throw new ConvexError("Archived records can't be filtered or sorted by a field.");
		if (where && sort && sort.field !== where.field) throw new ConvexError("Filter and sort by the same field.");
		const field = fields.find((f) => f.key === key && !f.archived);
		if (!field) throw new ConvexError(`There's no field “${key}”.`);
		if (sort && field.multiple) throw new ConvexError(`“${field.label}” holds several values, so it can't be sorted.`);
		const at = (raw: unknown) => (raw === undefined ? undefined : indexValue(field, raw));
		const eq = at(where?.eq);
		const gte = at(where?.gte);
		const lte = at(where?.lte);

		let rows: PaginationResult<Doc<"recordValues">>;
		if (field.kind === "link") {
			if (sort || eq === undefined) throw new ConvexError(`“${field.label}” can only be matched exactly.`);
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
		const seen = new Set<Id<"records">>();
		const page: Row[] = [];
		for (const row of rows.page) {
			if (seen.has(row.recordId)) continue;
			seen.add(row.recordId);
			const record = await ctx.db.get(row.recordId);
			if (record) page.push(await toRow(ctx, record, fields));
		}
		return { ...rows, page };
	},
});

/** What a filter value looks like in the index, so `where` uses the same rules as saving. */
function indexValue(field: Doc<"recordFields">, raw: unknown) {
	const result = normalizeValue({ ...toField(field), multiple: false }, raw);
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
		return {
			...(await toRow(ctx, record, fields)),
			type: { _id: type._id, key: type.key, name: type.name, plural: type.plural },
			fields: fields.filter((f) => !f.archived).map((f) => ({ _id: f._id, ...toField(f) })),
		};
	},
});

/** Live records that link to this one ("deals for this client"), optionally through one field. */
export const linked = query({
	args: { recordId: v.id("records"), fieldId: v.optional(v.id("recordFields")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, fieldId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return empty<Row & { fieldId: Id<"recordFields"> }>();
		const rows = await ctx.db
			.query("recordValues")
			.withIndex("by_ref", (q) => (fieldId ? q.eq("ref", recordId).eq("fieldId", fieldId) : q.eq("ref", recordId)))
			.paginate({ ...paginationOpts, numItems: Math.min(paginationOpts.numItems, PAGE_MAX) });
		const fields = new Map<Id<"recordTypes">, Doc<"recordFields">[]>();
		const page = [];
		for (const row of rows.page) {
			const source = await ctx.db.get(row.recordId);
			if (!source) continue;
			if (!fields.has(source.typeId)) fields.set(source.typeId, await fieldsOf(ctx, source.typeId));
			page.push({ ...(await toRow(ctx, source, fields.get(source.typeId)!)), fieldId: row.fieldId });
		}
		return { ...rows, page };
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
			.paginate(paginationOpts);
		const fields = await fieldsOf(ctx, record.typeId);
		return { ...result, page: await Promise.all(result.page.map((e) => toEntry(ctx, e, fields))) };
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
			.paginate(paginationOpts);
		const fields = new Map<Id<"recordTypes">, Doc<"recordFields">[]>();
		const page = [];
		for (const e of result.page) {
			if (!fields.has(e.typeId)) fields.set(e.typeId, await fieldsOf(ctx, e.typeId));
			const record = e.recordId && (await ctx.db.get(e.recordId));
			const type = await ctx.db.get(e.typeId);
			page.push({ ...(await toEntry(ctx, e, fields.get(e.typeId)!)), record: record ? record.title : null, type: type?.name ?? "" });
		}
		return { ...result, page };
	},
});

type Entry = Awaited<ReturnType<typeof toEntry>>;

async function toEntry(ctx: QueryCtx, e: Doc<"recordHistory">, fields: Doc<"recordFields">[]) {
	const field = e.fieldId && fields.find((f) => f._id === e.fieldId);
	return {
		_id: e._id,
		time: e._creationTime,
		action: e.action,
		recordId: e.recordId ?? null,
		/** Field changes: the field's current label. */
		field: field ? field.label : null,
		changes: e.changes.map((c) => ({ ...c, label: fields.find((f) => f.key === c.key)?.label ?? c.key })),
		refs: e.recordId ? await refsOf(ctx, fields, e.changes.flatMap((c) => [{ [c.key]: c.old }, { [c.key]: c.new }] as Partial<Record<string, FieldValue>>[])) : {},
		user: await nameOf(ctx, e.userId),
		agent: e.agentId ? ((await ctx.db.get(e.agentId))?.name ?? null) : null,
		undoes: e.undoes ?? null,
		undone: !!e.undoneBy,
	};
}

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

