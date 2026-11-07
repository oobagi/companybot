import { changeField, previewChange } from "./fieldChanges";
import {
	type RecordFindInput,
	type RecordPage,
	type RecordSaveInput,
	type RecordTypesResult,
	MULTI_MAX,
	NAME_KEY,
	databaseInput,
	displayValues,
	fieldInput,
	indexEntries,
	isGranted,
	viewInput,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation } from "./_generated/server";
import { activityPage } from "./activity";
import { deleteView, saveView, viewsOf } from "./databaseViews";
import { type Member, asToolResult, nameOf, normalizeEmail, profileOf, requireInWorkspace } from "./lib";
import {
	createType,
	updateType,
	createField,
	createRecord,
	currencyOf,
	fieldsOf,
	idsIn,
	inTrash,
	recordById,
	requireRecord,
	requireType,
	resolveRefs,
	setFieldTrashed,
	setRecordTrashed,
	setTypeTrashed,
	toField,
	toRows,
	typeVisible,
	typesOf,
	undoChange,
	updateField,
	updateRecord,
} from "./recordOps";
import { ANY_OF_MAX, CONDITIONS_MAX, type Condition } from "./recordQuery";
import { PAGE_MAX, activityAs, changedBy, historyAs, linkingRecords, listRecords, searchRecords, toEntries } from "./recordReads";
import { canAdd, reach } from "./placeAccess";
import { notePlace } from "./replySources";
import { withReceipt } from "./approvals";
import { opArg } from "./schema";
import { runningTurn } from "./turns";

// Records tools (core's RecordStore), acting as the turn's person: their role, read fresh
// on every call by runningTurn, and history names both them and the agent. Everything
// goes through recordOps, like the app. Types, fields, teammates and linked records can be
// named the way people say them; ids work too. See wiki/data.md.

const SEARCH_MAX = 20;
/** Records that link here, and recent changes, shown by records_get. */
const LINKED_MAX = 10;
const CHANGES_MAX = 5;

/** Live databases the person can see, oldest first. */
async function liveTypes(ctx: QueryCtx, member: Member) {
	const visible = typeVisible(ctx, { ...member, replyId: undefined });
	const types = [];
	for (const t of await typesOf(ctx, member.workspaceId)) if (!t.archived && (await visible(t._id))) types.push(t);
	return types.sort((a, b) => a._creationTime - b._creationTime);
}

/** Pick one by name, or say which ones it could be. */
function pickOne<T>(matches: T[], what: string, describe: (m: T) => string) {
	if (matches.length > 1) throw new ConvexError(`“${what}” could be ${matches.map(describe).join(" or ")}. Use the exact key.`);
	return matches[0];
}

/**
 * Writes name what they change by id or key, never by a name that can change, so a held call runs on what
 * was approved even if it's renamed and another takes the name meanwhile (`byName` false; core record-tools).
 */
const typeByKey = (ctx: QueryCtx, member: Member, key: string, trashed = false, need: "view" | "add" = "view") => typeNamed(ctx, member, key, trashed, false, need);

/**
 * A type by id or key, else by name or plural ("deal", "Deals"). Ambiguous names are refused. `trashed`: one in Archive.
 * One the person can't see is found all the same, then refused naming who can ("Only Office and Owners can see
 * Deals."), so the agent can tell them whom to ask.
 */
async function typeNamed(ctx: QueryCtx, member: Member, name: string, trashed = false, byName = true, need: "view" | "add" = "view") {
	const all = (await typesOf(ctx, member.workspaceId)).filter((t) => t.archived === trashed).sort((a, b) => a._creationTime - b._creationTime);
	const sees = typeVisible(ctx, { ...member, replyId: undefined });
	// `add`: a database they may add to (Add) counts too: they list and change their own records there.
	const visible = async (id: Id<"recordTypes">) => (await sees(id)) || (need === "add" && canAdd(member, all.find((t) => t._id === id)?.access));
	const types: Doc<"recordTypes">[] = [];
	const hidden: Doc<"recordTypes">[] = [];
	for (const t of all) ((await visible(t._id)) ? types : hidden).push(t);
	const raw = name.trim();
	const n = raw.toLowerCase();
	const exact = (among: Doc<"recordTypes">[]) => among.find((t) => t._id === raw || t.key === raw) ?? among.find((t) => t.key === n);
	const named = (among: Doc<"recordTypes">[]) => among.filter((t) => [t.name, t.plural].some((x) => x.toLowerCase() === n));
	// Ones they can see first, so suggestions and "could be" lists never name the rest. One they can't see,
	// named unambiguously, is refused naming who can (requireType), so they know whom to ask.
	if (!exact(types) && byName && named(types).length > 1) for (const t of named(types)) await notePlace(ctx, member, t._id, t.access);
	const type = byName
		? exact(types) ?? pickOne(named(types), raw, (t) => `${t.plural} (${t.key})`) ?? exact(hidden) ?? (named(hidden).length === 1 ? named(hidden)[0] : undefined)
		: exact(types) ?? exact(hidden);
	if (!type) {
		// Suggestions are returned text too, unlike candidates examined during a successful lookup.
		for (const t of types) await notePlace(ctx, member, t._id, t.access);
		if (!byName) throw new ConvexError(`Name the database by its key or id (names can change). Keys: ${types.map((t) => t.key).join(", ")}.`);
		throw new ConvexError(`There's no database “${name}”. Types: ${types.map((t) => t.key).join(", ")}.`);
	}
	// Refused by id, the refusal can't name it; by its key or name, it says back only what they typed.
	return requireType(ctx, member, type._id, need, type._id === raw ? undefined : raw);
}

/** A live field (or, `trashed`, one in Archive) by exact key, else (`byLabel`) by label. A label two fields could match is refused. */
function fieldNamed(fields: Doc<"recordFields">[], name: string, type: Doc<"recordTypes">, trashed = false, byLabel = true) {
	const live = fields.filter((f) => f.archived === trashed);
	const raw = name.trim();
	const n = raw.toLowerCase();
	const field =
		live.find((f) => f.key === raw) ??
		live.find((f) => f.key === n) ??
		(!byLabel ? undefined : pickOne(
			live.filter((f) => f.label.toLowerCase() === n),
			raw,
			(f) => `${f.label} (${f.key})`,
		));
	if (!field && !byLabel) throw new ConvexError(`Name ${type.plural.toLowerCase()}' fields by key (labels can change). records_types lists them.`);
	if (!field) throw new ConvexError(`${type.plural} have no field “${name}”. records_types lists them.`);
	return field;
}

/** Distinct names one call may look up; ids don't count. Each lookup is a couple of index rows. */
const LOOKUPS_MAX = 100;
/** Teammates a failed name lookup lists. */
const TEAM_LISTED = 20;

/**
 * Turns teammates and linked records as people name them ("me", "Ana", "Acme Roofing") into
 * ids, for one call. Ids pass through. Linked names are an exact lookup of the target type's
 * name field in the index (live records only), so each costs two index rows. Teammates are an
 * email in `members.by_email`, else a name in one read of the members' stored names. Lookups are
 * memoized and capped, and the team is read once.
 */
class Names {
	private cache = new Map<string, Promise<string>>();
	private team?: Promise<{ userId: Id<"users">; name: string }[]>;
	/** `exact`, for writes: linked records by id only, and teammates by id, email or "me", never by a name that can change. */
	constructor(
		private ctx: QueryCtx,
		private member: Member,
		private exact = false,
	) {}

	/** One value, or each item of a list (checked against the field's limits first). */
	async ids(field: Doc<"recordFields">, raw: unknown, max = MULTI_MAX) {
		if (!Array.isArray(raw)) return this.id(field, raw);
		if (raw.length > max) throw new ConvexError(`“${field.label}” takes up to ${max} values.`);
		const out = [];
		for (const x of raw) out.push(await this.id(field, x));
		return out;
	}

	id(field: Doc<"recordFields">, raw: unknown): Promise<unknown> | unknown {
		if (typeof raw !== "string" || !raw.trim() || (field.kind !== "user" && field.kind !== "link")) return raw;
		const text = raw.trim();
		if (this.ctx.db.normalizeId(field.kind === "user" ? "users" : "records", text)) return text;
		if (this.exact && field.kind === "link") throw new ConvexError(`Link “${field.label}” by record id (records_find gives them), not “${text}”: names can change.`);
		const key = `${field.kind === "user" ? "user" : field.linkTypeId}:${text.toLowerCase()}`;
		let found = this.cache.get(key);
		if (!found) {
			if (this.cache.size >= LOOKUPS_MAX) throw new ConvexError(`That's more than ${LOOKUPS_MAX} names to look up at once. Use ids, or fewer at a time.`);
			found = field.kind === "user" ? this.user(text) : this.record(field.linkTypeId!, text);
			this.cache.set(key, found);
		}
		return found;
	}

	private async user(text: string) {
		const lower = text.toLowerCase();
		if (lower === "me") return this.member.userId;
		const byEmail = await this.ctx.db
			.query("members")
			.withIndex("by_email", (q) => q.eq("workspaceId", this.member.workspaceId).eq("email", normalizeEmail(text)))
			.first();
		if (this.exact) {
			if (byEmail) return byEmail.userId;
			throw new ConvexError(`Name teammates by id, email or "me", not “${text}”: names can change.`);
		}
		this.team ??= this.ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", this.member.workspaceId))
			.collect()
			.then((rows) => Promise.all(rows.map(async (m) => ({ userId: m.userId, name: (await profileOf(this.ctx, m)).name }))));
		const team = await this.team;
		// Someone's email and someone else's name alike is as ambiguous as two names.
		const matches = new Set([...(byEmail ? [byEmail.userId] : []), ...team.filter((m) => m.name.toLowerCase() === lower).map((m) => m.userId)]);
		if (matches.size === 1) return [...matches][0]!;
		if (matches.size) throw new ConvexError(`Several teammates are called “${text}”. Use their email.`);
		const names = team.slice(0, TEAM_LISTED).map((m) => m.name);
		throw new ConvexError(`No teammate “${text}”. Teammates: ${names.join(", ")}${team.length > TEAM_LISTED ? ` and ${team.length - TEAM_LISTED} more` : ""}.`);
	}

	/** The live record of `typeId` named exactly `text` (case-insensitive). */
	private async record(typeId: Id<"recordTypes">, text: string) {
		const ctx = this.ctx;
		// Finding a record by name reads its database, so it takes seeing it.
		const type = await requireType(ctx, this.member, typeId);
		const nameField = (await fieldsOf(ctx, typeId)).find((f) => f.key === NAME_KEY)!;
		const entry = indexEntries(toField(nameField), text)[0] as { str: string };
		const rows = await ctx.db
			.query("recordValues")
			.withIndex("by_field_str", (q) => q.eq("fieldId", nameField._id).eq("str", entry.str))
			.take(2);
		// Long names share an index key only by hash; check the one match really is it.
		if (rows.length === 1) {
			const record = await ctx.db.get(rows[0]!.recordId);
			if (record && !record.archived && record.title.toLowerCase() === text.toLowerCase()) return record._id;
		}
		if (rows.length > 1)
			throw new ConvexError(`Several ${type.plural.toLowerCase()} are named “${text}”. Find them with records_find and use an id.`);
		throw new ConvexError(`No ${type.name.toLowerCase()} named “${text}”. Find it with records_find, or use its id.`);
	}
}

/** Values by field key, with teammates and links as ids (Names `exact`). */
async function valuesFor(names: Names, type: Doc<"recordTypes">, fields: Doc<"recordFields">[], values: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(values)) {
		const field = fieldNamed(fields, name, type, false, false);
		if (Array.isArray(raw) && !field.multiple) throw new ConvexError(`“${field.label}” holds one value.`);
		out[field.key] = await names.ids(field, raw);
	}
	return out;
}

/** `exact`: a saved view's, which keeps them, so by key and id only (Names `exact`); a search's may use names. */
async function conditionsFor(ctx: QueryCtx, member: Member, type: Doc<"recordTypes">, fields: Doc<"recordFields">[], filters: NonNullable<RecordFindInput["filters"]>, exact = false) {
	if (filters.length > CONDITIONS_MAX) throw new ConvexError(`Use up to ${CONDITIONS_MAX} filters.`);
	const names = new Names(ctx, member, exact);
	const conditions: Condition[] = [];
	for (const { field: name, ...test } of filters) {
		const field = fieldNamed(fields, name, type, false, !exact);
		const c: Condition = { ...test, field: field.key };
		if (c.eq !== undefined) c.eq = await names.id(field, c.eq);
		if (c.in) c.in = (await names.ids(field, c.in, ANY_OF_MAX)) as unknown[];
		conditions.push(c);
	}
	return conditions;
}

/**
 * Records as list tools return them: `_id` (and `_type` across types), then values as people
 * read them by field key. Field keys always start with a letter (keyOf), so they never clash.
 */
async function rowsOf(ctx: QueryCtx, member: Member, items: { record: Doc<"records">; fields: Doc<"recordFields">[] }[], withType?: Map<Id<"recordTypes">, string>) {
	const rows = await toRows(ctx, member, items);
	return rows.map((row, i): { _id: Id<"records">; _type?: string } & Record<string, string | number> => ({
		_id: row._id,
		...(withType && { _type: withType.get(row.typeId) ?? "" }),
		...displayValues(items[i]!.fields.filter((f) => !f.archived).map(toField), row.values, row.refs),
	}));
}

/**
 * A record as agents read it: values by field key, as people read them. Also a wake turn's record (turns.ts).
 * Checks, as of this read, that the person can see its database: a queued wake or a long turn may outlive their access.
 */
export async function recordOut(ctx: QueryCtx, member: Member, recordId: Id<"records">) {
	// Checks its database: View, or (Add) that they made it.
	const record = await requireRecord(ctx, member, recordId);
	const type = (await ctx.db.get(record.typeId))!;
	const [row] = await rowsOf(ctx, member, [{ record, fields: await fieldsOf(ctx, record.typeId) }]);
	const { _id, ...values } = row!;
	return { id: _id, type: type.key, typeName: type.name, name: record.title, ...((await inTrash(ctx, record)) && { inTrash: true }), values };
}

/** A field as agents see it. `linksTo`: the key of the database it links to. */
const fieldOut = (f: Doc<"recordFields">, linksTo?: string) => ({
	key: f.key,
	label: f.label,
	kind: f.kind,
	...(f.icon && { icon: f.icon }),
	position: f.position,
	...(f.archived && { inTrash: true }),
	...(f.options && { choices: f.options, options: f.options.filter((o) => !o.retired).map((o) => o.label) }),
	...(f.linkTypeId && { linksTo }),
	...(f.multiple && { multiple: true as const }),
});

export const typesFor = internalMutation({
	args: { turnId: v.id("agentTurns"), trashed: v.optional(v.boolean()) },
	handler: async (ctx, { turnId, trashed = false }): Promise<RecordTypesResult> => {
		const { member } = await runningTurn(ctx, turnId);
		const visible = typeVisible(ctx, { ...member, replyId: undefined });
		const all = await typesOf(ctx, member.workspaceId);
		const types = [];
		// Add (without View) lists the database too: they add records there and see only their own.
		const onlyYours = new Set<Id<"recordTypes">>();
		for (const t of all) {
			if (t.archived !== trashed) continue;
			if (await visible(t._id)) types.push(t);
			else if (canAdd(member, t.access)) (types.push(t), onlyYours.add(t._id));
		}
		// A link into a database they can't see names no key, so the agent can't go looking.
		const keys = new Map<Id<"recordTypes">, string>();
		const rows = [];
		for (const t of types) {
			await notePlace(ctx, member, t._id, t.access);
			const fields = await fieldsOf(ctx, t._id);
			for (const field of fields) {
				if (!field.linkTypeId || keys.has(field.linkTypeId)) continue;
				const linked = all.find((t) => t._id === field.linkTypeId);
				const seen = linked && await visible(linked._id);
				keys.set(field.linkTypeId, seen ? linked.key : "(a database you can't see)");
				if (seen) await notePlace(ctx, member, linked._id, linked.access);
			}
			rows.push({ type: t.key, name: t.name, plural: t.plural, version: t.version ?? 0, ...(t.archived && { inTrash: true }), ...(onlyYours.has(t._id) && { onlyYours: true as const }), fields: fields.map((f) => fieldOut(f, f.linkTypeId && (keys.get(f.linkTypeId) ?? "(a deleted database)"))) });
		}
		return {
			currency: await currencyOf(ctx, member.workspaceId),
			types: rows,
		};
	},
});

export const findFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member } = await runningTurn(ctx, turnId);
		const { type: typeName, search, filters = [], sort, trashed = false, cursor, numItems } = input as RecordFindInput & { numItems: number };
		return asToolResult(async (): Promise<RecordPage> => {
			if (search?.trim()) {
				if (filters.length || sort || trashed) throw new ConvexError("Search on its own, or list with filters and a sort instead.");
				const type = typeName ? await typeNamed(ctx, member, typeName) : null;
				const found = await searchRecords(ctx, member, search, { typeId: type?._id, limit: Math.min(numItems, SEARCH_MAX), cursor });
				const keys = type ? undefined : new Map((await liveTypes(ctx, member)).map((t) => [t._id, t.key]));
				const rows = await rowsOf(ctx, member, found.items, keys);
				return { type: type?.plural ?? "Records", typeName: type?.name ?? "Record", rows, more: !!found.cursor, ...(found.cursor && { cursor: found.cursor }) };
			}
			if (!typeName) throw new ConvexError("Say which database to list, or search.");
			const type = await typeNamed(ctx, member, typeName, false, true, "add");
			// Add without View lists only the records they made.
			const owner = reach(member, type.access) ? undefined : { createdBy: member.userId };
			const fields = await fieldsOf(ctx, type._id);
			const conditions = await conditionsFor(ctx, member, type, fields, filters);
			const sortBy = sort && {
				field: ["createdAt", "updatedAt"].includes(sort.field) ? sort.field : fieldNamed(fields, sort.field, type).key,
				order: sort.order,
			};
			const result = await listRecords(
				ctx,
				member.workspaceId,
				{ typeId: type._id, fields },
				{ archived: trashed, conditions, sort: sortBy, owner, paginationOpts: { numItems: Math.min(Math.max(numItems, 1), PAGE_MAX), cursor: cursor ?? null } },
			);
			const rows = await rowsOf(ctx, member, result.page.map((record) => ({ record, fields })));
			return { type: type.plural, typeName: type.name, rows, more: !result.isDone, ...(!result.isDone && { cursor: result.continueCursor }) };
		});
	},
});

export const getFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.string() },
	handler: async (ctx, { turnId, id }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const record = await recordById(ctx, member, id);
			const recordId = record._id;
			const fields = await fieldsOf(ctx, record.typeId);
			const out = await recordOut(ctx, member, recordId);
			const [row] = await toRows(ctx, member, [{ record, fields }]);
			const links = Object.fromEntries(
				fields
					.filter((f) => f.kind === "link" && !f.archived && record.values[f.key] !== undefined)
					.map((f) => [f.key, [record.values[f.key]!].flat().map((x) => ({ id: String(x), name: row!.refs[String(x)]?.locked ? "Locked record" : (row!.refs[String(x)]?.name ?? String(x)) }))]),
			);
			const linkedFrom = [];
			for (const { record: other, fields: theirs, fieldId } of (await linkingRecords(ctx, member, recordId, { paginationOpts: { numItems: LINKED_MAX, cursor: null } })).page) {
				const type = await ctx.db.get(other.typeId);
				if (type) linkedFrom.push({ id: other._id, type: type.key, name: other.title, via: theirs.find((f) => f._id === fieldId)?.label ?? "" });
			}
			const entries = await ctx.db
				.query("recordHistory")
				.withIndex("by_record", (q) => q.eq("recordId", recordId))
				.order("desc")
				.take(CHANGES_MAX);
			const { refs } = await resolveRefs(ctx, member, entries.flatMap((e) => e.changes.flatMap((c) => [...idsIn(fields, { [c.key]: c.old }), ...idsIn(fields, { [c.key]: c.new })])));
			const shown = (field: Doc<"recordFields"> | undefined, key: string, value: unknown) =>
				value === undefined ? "empty" : field ? String(displayValues([toField(field)], { [key]: value as never }, refs)[key]) : JSON.stringify(value);
			const changes = await Promise.all(
				entries.map(async (e) => ({
					change: e._id,
					time: new Date(e._creationTime).toISOString(),
					action: e.action,
					by: await changedBy(ctx, e),
					...(e.agentId && { agent: (await ctx.db.get(e.agentId))?.name ?? "an agent" }),
					...(e.action === "updated" && {
						changed: e.changes.map((c) => {
							const field = fields.find((f) => f.key === c.key);
							return `${field?.label ?? c.key}: ${shown(field, c.key, c.old)} → ${shown(field, c.key, c.new)}`;
						}),
					}),
					...(e.undoneBy && { undone: true }),
				})),
			);
			return { ...out, links, linkedFrom, changes };
		});
	},
});

export const saveFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(opArg), input: v.any() },
	handler: (ctx, { turnId, op, input }) => withReceipt(ctx, op, turnId, async () => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { id, type: typeName, values = {}, trash } = input as RecordSaveInput;
		return asToolResult(async () => {
			const hasValues = Object.keys(values).length > 0;
			if (trash !== undefined && hasValues) throw new ConvexError("Delete or restore on its own, then change values in another call.");
			let recordId: Id<"records">;
			let change: Id<"recordHistory"> | null;
			if (id) {
				const record = await recordById(ctx, member, id);
				recordId = record._id;
				if (trash !== undefined) change = await setRecordTrashed(ctx, who, recordId, trash);
				else if (hasValues) {
					const type = (await ctx.db.get(record.typeId))!;
					const fields = await fieldsOf(ctx, type._id);
					change = await updateRecord(ctx, who, recordId, await valuesFor(new Names(ctx, member, true), type, fields, values));
				} else throw new ConvexError("Nothing to change: give values, or trash.");
			} else {
				if (trash !== undefined) throw new ConvexError("Create the record first.");
				if (!typeName) throw new ConvexError("Say which database to create.");
				const type = await typeByKey(ctx, member, typeName, false, "add");
				const fields = await fieldsOf(ctx, type._id);
				({ id: recordId, change } = await createRecord(ctx, who, type._id, await valuesFor(new Names(ctx, member, true), type, fields, values)));
			}
			return { ...(await recordOut(ctx, member, recordId)), ...(change ? { change } : { unchanged: true }) };
		});
	}),
});

export const undoFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(opArg), change: v.string() },
	handler: (ctx, { turnId, op, change }) => withReceipt(ctx, op, turnId, async () => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const historyId = ctx.db.normalizeId("recordHistory", change);
			if (!historyId) throw new ConvexError("Change not found.");
			const undoneBy = await undoChange(ctx, who, historyId);
			const entry = (await ctx.db.get(historyId))!;
			// A field's kind change: its values convert back in the background.
			if (!entry.recordId) return { undone: change, name: (await ctx.db.get(entry.fieldId!))?.label ?? "a field", field: true, converting: true, change: undoneBy };
			return { undone: change, ...(await recordOut(ctx, member, entry.recordId!)), change: undoneBy };
		});
	}),
});

export const saveFieldFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(opArg), input: v.any() },
	handler: (ctx, { turnId, op, input }) => withReceipt(ctx, op, turnId, async () => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const { type: typeName, field: name, label, kind, icon, options: rawOptions, linksTo, multiple, trash, position, preview } = fieldInput.parse(input);
			const options = rawOptions?.map((o) => typeof o === "string" ? { label: o } : o);
			const type = await typeByKey(ctx, member, typeName);
			let fieldId: Id<"recordFields">;
			let changed: Awaited<ReturnType<typeof changeField>> | undefined;
			if (trash !== undefined) {
				if (!name || label || kind || icon !== undefined || options || linksTo || multiple !== undefined || position !== undefined) throw new ConvexError("Say which field to delete or restore, on its own.");
				fieldId = fieldNamed(await fieldsOf(ctx, type._id), name, type, !trash, false)._id;
				await setFieldTrashed(ctx, who, fieldId, trash);
			} else if (name) {
				const field = fieldNamed(await fieldsOf(ctx, type._id), name, type, false, false);
				const linkTypeId = linksTo ? (await typeByKey(ctx, member, linksTo))._id : field.linkTypeId;
				// Saying the setup it has already changes nothing.
				const setup = (kind !== undefined && kind !== field.kind) || (multiple !== undefined && multiple !== !!field.multiple) || (linksTo !== undefined && linkTypeId !== field.linkTypeId);
				const shape = setup && {
					kind: kind ?? field.kind,
					multiple: multiple ?? !!field.multiple,
					linkTypeId,
					options: (kind ?? field.kind) === "choice" && field.kind !== "choice" ? options : undefined,
				};
				if (preview) {
					if (!shape) throw new ConvexError("Preview a change to kind, multiple or linksTo.");
					const result = await previewChange(ctx, member, field._id, shape);
					return { type: type.key, typePlural: type.plural, ...fieldOut(field, field.linkTypeId && (await ctx.db.get(field.linkTypeId))?.key), preview: true as const, ...(result ?? { unchanged: true }) };
				}
				const choiceEdit = options && !(shape && shape.options);
				if (label !== undefined || icon !== undefined || position !== undefined || choiceEdit) await updateField(ctx, who, field._id, { label, icon, options: choiceEdit ? options : undefined, position });
				if (shape) changed = await changeField(ctx, who, field._id, shape);
				fieldId = field._id;
			} else {
				if (position !== undefined) throw new ConvexError("Create the field before moving it.");
				if (!label || !kind) throw new ConvexError("Give the new field a label and a kind.");
				const linkTypeId = linksTo ? (await typeByKey(ctx, member, linksTo))._id : undefined;
				fieldId = (await createField(ctx, who, type._id, { label, kind, ...(icon && { icon }), options, linkTypeId, multiple }))._id;
			}
			const f = (await ctx.db.get(fieldId))!;
			const out = { type: type.key, typePlural: type.plural, ...fieldOut(f, f.linkTypeId && (await ctx.db.get(f.linkTypeId))?.key) };
			// The change id undoes it (records_undo); values convert in the background, by the preview's counts.
			return changed ? { ...out, changed: changed.change, change: changed.historyId, converting: true, preview: changed.preview } : out;
		});
	}),
});

export const saveDatabaseFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(opArg), input: v.any() },
	handler: (ctx, { turnId, op, input }) => withReceipt(ctx, op, turnId, async () => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const parsed = databaseInput.safeParse(input);
			if (!parsed.success) throw new ConvexError(parsed.error.issues[0]!.message);
			const { type: key, name: plural, singular: name, version, trash } = parsed.data;
			let id: Id<"recordTypes">;
			if (key && trash !== undefined) {
				if (plural || name) throw new ConvexError("Delete or restore a database on its own.");
				id = (await typeByKey(ctx, member, key, !trash))._id;
				await setTypeTrashed(ctx, who, id, trash);
			} else if (key) {
				id = (await typeByKey(ctx, member, key))._id;
				await updateType(ctx, who, id, { name, plural, version: version ?? -1 });
			} else {
				if (!plural || trash !== undefined) throw new ConvexError("Give the new database a name.");
				id = await createType(ctx, who, { plural, name });
			}
			const type = (await ctx.db.get(id))!;
			return { type: type.key, name: type.name, plural: type.plural, version: type.version ?? 0, ...(type.archived && { inTrash: true }) };
		});
	}),
});

export const viewsFor = internalMutation({
	args: { turnId: v.id("agentTurns"), type: v.string() },
	handler: async (ctx, { turnId, type: name }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => ({ rows: await viewsOf(ctx, member, (await typeNamed(ctx, member, name))._id) }));
	},
});

export const saveViewFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(opArg), input: v.any() },
	handler: (ctx, { turnId, op, input }) => withReceipt(ctx, op, turnId, async () => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const checked = viewInput.safeParse(input);
			if (!checked.success) throw new ConvexError(checked.error.issues[0]!.message);
			const parsed = checked.data;
			const type = await typeByKey(ctx, member, parsed.type);
			const viewId = parsed.id ? ctx.db.normalizeId("databaseViews", parsed.id) : undefined;
			if (parsed.id && !viewId) throw new ConvexError("View not found.");
			const old = viewId ? (await viewsOf(ctx, member, type._id)).find((v) => v._id === viewId) : undefined;
			if (viewId && !old) throw new ConvexError("View not found.");
			if (parsed.remove) {
				if (!old) throw new ConvexError("Pick a saved view to delete.");
				await deleteView(ctx, who, old._id, parsed.version ?? -1);
				return { deleted: old.name };
			}
			const fields = await fieldsOf(ctx, type._id);
			// Kept settings drop fields archived since, so renaming an old view still works.
			const live = (key: string) => fields.some((f) => f.key === key && !f.archived);
			const sort = parsed.sort && { ...parsed.sort, field: ["createdAt", "updatedAt"].includes(parsed.sort.field) ? parsed.sort.field : fieldNamed(fields, parsed.sort.field, type, false, false).key };
			const id = await saveView(ctx, who, type._id, {
				name: parsed.name ?? old?.name ?? "",
				filters: parsed.filters ? await conditionsFor(ctx, member, type, fields, parsed.filters, true) : old?.filters.filter((c) => live(c.field)) ?? [],
				sort: parsed.sort === null ? undefined : sort ?? (old?.sort && (["createdAt", "updatedAt"].includes(old.sort.field) || live(old.sort.field)) ? old.sort : undefined),
				columns: parsed.columns ?? old?.columns.filter(live) ?? ["name"],
				layout: parsed.layout ?? old?.layout,
				groupBy: parsed.groupBy === null ? undefined : parsed.groupBy ? fieldNamed(fields, parsed.groupBy, type, false, false).key : old?.groupBy && live(old.groupBy) ? old.groupBy : undefined,
			}, viewId || undefined, parsed.version);
			return ctx.db.get(id);
		});
	}),
});

export const historyFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.optional(v.string()), source: v.optional(v.union(v.literal("records"), v.literal("agents"))), cursor: v.optional(v.string()), change: v.optional(v.string()), limit: v.optional(v.number()) },
	handler: async (ctx, { turnId, id, source, cursor, change, limit }) => {
		const { member, turn } = await runningTurn(ctx, turnId);
		const agent = await ctx.db.get(turn.agentId);
		if (!agent || agent.archived || !isGranted(agent.tools, "records.history")) throw new ConvexError("This agent no longer has that tool.");
		return asToolResult(async () => {
			const opts = { numItems: Math.min(Math.max(limit ?? 20, 1), 20), cursor: cursor ?? null };
			if (change) {
				if (source === "agents") throw new ConvexError("Use change only for record history.");
				const entryId = ctx.db.normalizeId("recordHistory", change);
				const entry = requireInWorkspace(member, entryId ? await ctx.db.get(entryId) : null, "Change");
				await requireType(ctx, member, entry.typeId);
				if (id && entry.recordId !== id) throw new ConvexError("Change belongs to a different record.");
				return (await toEntries(ctx, member, [{ entry, fields: await fieldsOf(ctx, entry.typeId) }]))[0]!;
			}
			if (source === "agents") {
				if (id) throw new ConvexError("Use id only for record history.");
				return activityPage(ctx, member, opts);
			}
			if (!id) return activityAs(ctx, member, opts);
			return historyAs(ctx, member, await recordById(ctx, member, id), opts);
		});
	},
});
