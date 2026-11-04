import { type PaginationResult, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { canSee } from "./chatOps";
import { emptyPage, getMember, nameOf, requireMember } from "./lib";
import { reach } from "./placeAccess";
import {
	createRecord,
	fieldsOf,
	inTrash,
	resolveRefs,
	typeVisible,
	fieldsShown,
	toRows,
	undoChange,
	updateRecord,
} from "./recordOps";
import { activityAs, historyAs, linkingRecords, listRecords, searchRecords } from "./recordReads";
import { condition, recordGroup, recordSort } from "./recordValidators";
import { canReadReply } from "./replyPrivacy";
import { trashInfo } from "./trashOps";

// Records: the app's API. Reading a database's records takes View in it (its Who can access
// list); changing them takes `records.edit` and Edit in it. Lists page through indexes only, so they stay fast at any size.
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
		if (!member || type?.workspaceId !== member.workspaceId || type.archived || !reach(member, type.access)) return emptyPage();
		const fields = await fieldsOf(ctx, typeId);
		const result = await listRecords(ctx, member.workspaceId, { typeId, fields }, { archived: false, conditions: filters, group, sort, paginationOpts });
		return { ...result, page: await toRows(ctx, member, result.page.map((record) => ({ record, fields }))) };
	},
});

/**
 * One record with its type and fields, or null if it isn't in your workspace or you can't see its
 * database. `archived`: in Archive, on its own or with its database. `canEdit`: Edit in its database.
 */
export const get = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId) return null;
		const type = (await ctx.db.get(record.typeId))!;
		const level = reach(member, type.access);
		if (!level) return null;
		const fields = await fieldsOf(ctx, record.typeId);
		const shown = fieldsShown(ctx, member);
		const [row] = await toRows(ctx, member, [{ record, fields }]);
		return {
			...row!,
			canEdit: level === "edit",
			archived: await inTrash(ctx, record),
			trash: await trashInfo(ctx, member, record._id),
			type: { _id: type._id, key: type.key, name: type.name, plural: type.plural },
			fields: await Promise.all(fields.filter((f) => !f.archived).map(async (f) => ({ _id: f._id, ...(await shown(f)) }))),
		};
	},
});

/**
 * The names of a few records you keep at hand (the rail's pins and recents), with where each
 * opens. Ones you can't see, archived or gone are left out, so the rail drops them.
 */
export const titles = query({
	args: { recordIds: v.array(v.string()) },
	handler: async (ctx, { recordIds }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const out: { _id: Id<"records">; title: string; typeKey: string }[] = [];
		for (const raw of recordIds.slice(0, 50)) {
			const id = ctx.db.normalizeId("records", raw);
			const record = id && (await ctx.db.get(id));
			if (!record || record.workspaceId !== member.workspaceId || (await inTrash(ctx, record))) continue;
			const type = await ctx.db.get(record.typeId);
			if (type) out.push({ _id: record._id, title: record.title, typeKey: type.key });
		}
		return out;
	},
});

/** Live records that link to this one ("deals for this client"), optionally through one field. None if it's in Archive. */
export const linked = query({
	args: { recordId: v.id("records"), fieldId: v.optional(v.id("recordFields")), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, fieldId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId || (await inTrash(ctx, record)) || !(await typeVisible(ctx, member)(record.typeId))) return emptyPage();
		const result = await linkingRecords(ctx, member, recordId, { fieldId, paginationOpts });
		const rows = await toRows(ctx, member, result.page);
		return { ...result, page: rows.map((row, i) => ({ ...row, fieldId: result.page[i]!.fieldId })) };
	},
});

/** Live records whose title or text matches, best first, as list rows. Optionally one type. */
export const search = query({
	args: { query: v.string(), typeId: v.optional(v.id("recordTypes")) },
	handler: async (ctx, { query: text, typeId }): Promise<Row[]> => {
		const member = await getMember(ctx);
		if (!member || !text.trim()) return [];
		return toRows(ctx, member, (await searchRecords(ctx, member, text, { typeId, limit: 20 })).items);
	},
});

/** A record's history, newest first. */
export const history = query({
	args: { recordId: v.id("records"), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { recordId, paginationOpts }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId || !(await typeVisible(ctx, member)(record.typeId))) return emptyPage();
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
		return (await resolveRefs(ctx, member, ids)).refs;
	},
});

/** Chat messages that reference this record and that you can see, newest first. */
export const discussion = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		const record = member && (await ctx.db.get(recordId));
		if (!member || record?.workspaceId !== member.workspaceId || !(await typeVisible(ctx, member)(record.typeId))) return [];
		const mentions = await ctx.db
			.query("recordMentions")
			.withIndex("by_record", (q) => q.eq("recordId", recordId))
			.order("desc")
			.take(50);
		const out = [];
		for (const m of mentions) {
			const message = await ctx.db.get(m.messageId);
			const chat = await ctx.db.get(m.chatId);
			if (!message || message.deleted || !chat || !(await canSee(ctx, chat, member)) || !(await canReadReply(ctx, member, message))) continue;
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
