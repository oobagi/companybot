import { condition, recordGroup, recordSort } from "./recordValidators";
import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { canSee } from "./chatOps";
import { emptyPage, getMember, nameOf, requireMember } from "./lib";
import { trashInfo } from "./trashOps";
import { activityAs, historyAs, linkingRecords, listRecords, searchRecords } from "./recordReads";
import {
	createRecord,
	fieldsOf,
	inTrash,
	resolveRefs,
	toField,
	toRows,
	undoChange,
	updateRecord,
} from "./recordOps";

// Records: the app's API. Every workspace member can read every record; changing them
// takes `records.edit`. Lists page through indexes only, so they stay fast at any size.
// See wiki/data.md.

type Row = Awaited<ReturnType<typeof toRows>>[number];

/**
 * One type's records, a page at a time, matching every filter (AND). Each filter is one
 * of: `eq`, `in` (any of: choice, person and link fields), a range (`gt`/`gte`/`lt`/`lte`:
 * number, amount and date fields), or `empty`. Fields holding several values take `eq`,
 * `in` and `empty`. `sort` by "createdAt", "updatedAt" or a field (records without a value
 * for it aren't listed). Without a sort it's newest first, unless the only usable filters
 * are ranges, which list in that field's order. A page can come back short with
 * `isDone: false` when a rare combination takes more than one request's reading budget:
 * ask for the next page. See wiki/data.md.
 */
export const list = query({
	args: {
		typeId: v.id("recordTypes"),
		filters: v.optional(v.array(condition)),
		/** A board column: the view's filters stay within their limit. */
		group: v.optional(recordGroup),
		sort: v.optional(recordSort),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, { typeId, filters = [], group, sort, paginationOpts }): Promise<PaginationResult<Row>> => {
		const member = await getMember(ctx);
		const type = member && (await ctx.db.get(typeId));
		if (!member || type?.workspaceId !== member.workspaceId || type.archived) return emptyPage();
		const fields = await fieldsOf(ctx, typeId);
		const result = await listRecords(ctx, member.workspaceId, { typeId, fields }, { archived: false, conditions: filters, group, sort, paginationOpts });
		return { ...result, page: await toRows(ctx, member.workspaceId, result.page.map((record) => ({ record, fields }))) };
	},
});

/** One record with its type and fields, or null if it isn't in your workspace. `archived`: in Trash, on its own or with its database. */
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
			archived: await inTrash(ctx, record),
			trash: await trashInfo(ctx, member, record._id),
			type: { _id: type._id, key: type.key, name: type.name, plural: type.plural },
			fields: fields.filter((f) => !f.archived).map((f) => ({ _id: f._id, ...toField(f) })),
		};
	},
});

/** Live records that link to this one ("deals for this client"), optionally through one field. None if it's in Trash. */
export const linked = query({
	args: { recordId: v.id("records"), fieldId: v.optional(v.id("recordFields")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, fieldId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId || (await inTrash(ctx, record))) return emptyPage();
		const result = await linkingRecords(ctx, recordId, { fieldId, paginationOpts });
		const rows = await toRows(ctx, member.workspaceId, result.page);
		return { ...result, page: rows.map((row, i) => ({ ...row, fieldId: result.page[i]!.fieldId })) };
	},
});

/** Live records whose title or text matches, best first, as list rows. Optionally one type. */
export const search = query({
	args: { query: v.string(), typeId: v.optional(v.id("recordTypes")) },
	handler: async (ctx, { query: text, typeId }): Promise<Row[]> => {
		const member = await getMember(ctx);
		if (!member || !text.trim()) return [];
		return toRows(ctx, member.workspaceId, await searchRecords(ctx, member.workspaceId, text, { typeId, limit: 20 }));
	},
});

/** A record's history, newest first. */
export const history = query({
	args: { recordId: v.id("records"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return emptyPage();
		return historyAs(ctx, member, record, paginationOpts);
	},
});

/** Every record and field change in the workspace, newest first. For Settings → Activity. */
export const activity = query({
	args: { paginationOpts: paginationOptsValidator },
	handler: async (ctx, { paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return emptyPage();
		return activityAs(ctx, member, paginationOpts);
	},
});

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
	handler: async (ctx, { typeId, values }) => (await createRecord(ctx, { member: await requireMember(ctx) }, typeId, values)).id,
});

/** Changes only the fields given. */
export const update = mutation({
	args: { recordId: v.id("records"), values },
	handler: async (ctx, { recordId, values }) => {
		await updateRecord(ctx, { member: await requireMember(ctx) }, recordId, values);
	},
});

/** Reverses one history entry. Refused if what it changed has changed again since. */
export const undo = mutation({
	args: { historyId: v.id("recordHistory") },
	handler: async (ctx, { historyId }) => {
		await undoChange(ctx, { member: await requireMember(ctx) }, historyId);
	},
});
