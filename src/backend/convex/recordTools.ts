import { databaseInput, viewInput } from "@companybot/core";
import { deleteView, saveView, viewsOf } from "./databaseViews";
import {
	type FieldSaveInput,
	type RecordFindInput,
	type RecordPage,
	type RecordSaveInput,
	type RecordTypesResult,
	MULTI_MAX,
	NAME_KEY,
	displayValues,
	indexEntries,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { type Member, asToolResult, nameOf } from "./lib";
import {
	createType,
	updateType,
	createField,
	createRecord,
	currencyOf,
	fieldsOf,
	idsIn,
	requireRecord,
	resolveRefs,
	setArchived,
	toField,
	toRows,
	typesOf,
	undoChange,
	updateField,
	updateRecord,
} from "./recordOps";
import { ANY_OF_MAX, CONDITIONS_MAX, type Condition } from "./recordQuery";
import { PAGE_MAX, linkingRecords, listRecords, searchRecords } from "./recordReads";
import { runningTurn } from "./turns";

// Records tools (core's RecordStore), acting as the turn's person: their role, read fresh
// on every call by runningTurn, and history names both them and the agent. Everything
// goes through recordOps, like the app. Types, fields, teammates and linked records can be
// named the way people say them; ids work too. See wiki/data.md.

const SEARCH_MAX = 20;
/** Records that link here, and recent changes, shown by records_get. */
const LINKED_MAX = 10;
const CHANGES_MAX = 5;

const liveTypes = async (ctx: QueryCtx, member: Member) =>
	(await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived).sort((a, b) => a._creationTime - b._creationTime);

/** Pick one by name, or say which ones it could be. */
function pickOne<T>(matches: T[], what: string, describe: (m: T) => string) {
	if (matches.length > 1) throw new ConvexError(`“${what}” could be ${matches.map(describe).join(" or ")}. Use the exact key.`);
	return matches[0];
}

/** A type by id or key, else by name or plural ("deal", "Deals"). Ambiguous names are refused. */
async function typeNamed(ctx: QueryCtx, member: Member, name: string) {
	const types = await liveTypes(ctx, member);
	const raw = name.trim();
	const n = raw.toLowerCase();
	const type =
		types.find((t) => t._id === raw || t.key === raw) ??
		types.find((t) => t.key === n) ??
		pickOne(
			types.filter((t) => [t.name, t.plural].some((x) => x.toLowerCase() === n)),
			raw,
			(t) => `${t.plural} (${t.key})`,
		);
	if (!type) throw new ConvexError(`There's no database “${name}”. Types: ${types.map((t) => t.key).join(", ")}.`);
	return type;
}

/** A live field by exact key, else by label. A label two fields could match is refused. */
function fieldNamed(fields: Doc<"recordFields">[], name: string, type: Doc<"recordTypes">) {
	const live = fields.filter((f) => !f.archived);
	const raw = name.trim();
	const n = raw.toLowerCase();
	const field =
		live.find((f) => f.key === raw) ??
		live.find((f) => f.key === n) ??
		pickOne(
			live.filter((f) => f.label.toLowerCase() === n),
			raw,
			(f) => `${f.label} (${f.key})`,
		);
	if (!field) throw new ConvexError(`${type.plural} have no field “${name}”. records_types lists them.`);
	return field;
}

/** Distinct names one call may look up; ids don't count. Each lookup is a couple of index rows. */
const LOOKUPS_MAX = 100;

/**
 * Turns teammates and linked records as people name them ("me", "Ana", "Acme Roofing") into
 * ids, for one call. Ids pass through. Linked names are an exact lookup of the target type's
 * name field in the index (live records only), so each costs two index rows. Lookups are
 * memoized and capped, and the team is read once.
 */
class Names {
	private cache = new Map<string, Promise<string>>();
	private team?: Promise<{ id: Id<"users">; name: string; email: string }[]>;
	constructor(
		private ctx: QueryCtx,
		private member: Member,
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
		this.team ??= this.ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", this.member.workspaceId))
			.collect()
			.then((rows) =>
				Promise.all(
					rows.map(async (m) => ({ id: m.userId, name: await nameOf(this.ctx, m.userId), email: (await this.ctx.db.get(m.userId))?.email ?? "" })),
				),
			);
		const team = await this.team;
		const matches = team.filter((p) => p.name.toLowerCase() === lower || p.email.toLowerCase() === lower);
		if (matches.length === 1) return matches[0]!.id;
		throw new ConvexError(
			matches.length
				? `Several teammates are called “${text}”. Use their email.`
				: `No teammate “${text}”. Teammates: ${team.map((p) => p.name).join(", ")}.`,
		);
	}

	/** The live record of `typeId` named exactly `text` (case-insensitive). */
	private async record(typeId: Id<"recordTypes">, text: string) {
		const ctx = this.ctx;
		const type = (await ctx.db.get(typeId))!;
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

/** Values by field key or label → by key, with teammates and links named as ids. */
async function valuesFor(names: Names, type: Doc<"recordTypes">, fields: Doc<"recordFields">[], values: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(values)) {
		const field = fieldNamed(fields, name, type);
		if (Array.isArray(raw) && !field.multiple) throw new ConvexError(`“${field.label}” holds one value.`);
		out[field.key] = await names.ids(field, raw);
	}
	return out;
}

async function conditionsFor(ctx: QueryCtx, member: Member, type: Doc<"recordTypes">, fields: Doc<"recordFields">[], filters: NonNullable<RecordFindInput["filters"]>) {
	if (filters.length > CONDITIONS_MAX) throw new ConvexError(`Use up to ${CONDITIONS_MAX} filters.`);
	const names = new Names(ctx, member);
	const conditions: Condition[] = [];
	for (const { field: name, ...test } of filters) {
		const field = fieldNamed(fields, name, type);
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
	const rows = await toRows(ctx, member.workspaceId, items);
	return rows.map((row, i): { _id: Id<"records">; _type?: string } & Record<string, string | number> => ({
		_id: row._id,
		...(withType && { _type: withType.get(row.typeId) ?? "" }),
		...displayValues(items[i]!.fields.filter((f) => !f.archived).map(toField), row.values, row.refs),
	}));
}

async function recordOut(ctx: QueryCtx, member: Member, recordId: Id<"records">) {
	const record = (await ctx.db.get(recordId))!;
	const type = (await ctx.db.get(record.typeId))!;
	const [row] = await rowsOf(ctx, member, [{ record, fields: await fieldsOf(ctx, record.typeId) }]);
	const { _id, ...values } = row!;
	return { id: _id, type: type.key, typeName: type.name, name: record.title, ...(record.archived && { archived: true }), values };
}

export const typesFor = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }): Promise<RecordTypesResult> => {
		const { member } = await runningTurn(ctx, turnId);
		const types = await liveTypes(ctx, member);
		const keys = new Map(types.map((t) => [t._id, t.key]));
		return {
			currency: await currencyOf(ctx, member.workspaceId),
			types: await Promise.all(
				types.map(async (t) => ({
					type: t.key,
					name: t.name,
					plural: t.plural,
					version: t.version ?? 0,
					fields: (await fieldsOf(ctx, t._id))
						.filter((f) => !f.archived)
						.map((f) => ({
							key: f.key,
							label: f.label,
							kind: f.kind,
							...(f.options && { options: f.options.filter((o) => !o.retired).map((o) => o.label) }),
							...(f.linkTypeId && { linksTo: keys.get(f.linkTypeId) ?? "(archived type)" }),
							...(f.multiple && { multiple: true as const }),
						})),
				})),
			),
		};
	},
});

export const findFor = internalQuery({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member } = await runningTurn(ctx, turnId);
		const { type: typeName, search, filters = [], sort, archived = false, cursor, numItems } = input as RecordFindInput & { numItems: number };
		return asToolResult(async (): Promise<RecordPage> => {
			if (search?.trim()) {
				if (filters.length || sort || cursor || archived) throw new ConvexError("Search on its own, or list with filters and a sort instead.");
				const type = typeName ? await typeNamed(ctx, member, typeName) : null;
				const found = await searchRecords(ctx, member.workspaceId, search, { typeId: type?._id, limit: Math.min(numItems, SEARCH_MAX) });
				const keys = type ? undefined : new Map((await liveTypes(ctx, member)).map((t) => [t._id, t.key]));
				const rows = await rowsOf(ctx, member, found, keys);
				return { type: type?.plural ?? "Records", typeName: type?.name ?? "Record", rows, more: false };
			}
			if (!typeName) throw new ConvexError("Say which database to list, or search.");
			const type = await typeNamed(ctx, member, typeName);
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
				{ archived, conditions, sort: sortBy, paginationOpts: { numItems: Math.min(Math.max(numItems, 1), PAGE_MAX), cursor: cursor ?? null } },
			);
			const rows = await rowsOf(ctx, member, result.page.map((record) => ({ record, fields })));
			return { type: type.plural, typeName: type.name, rows, more: !result.isDone, ...(!result.isDone && { cursor: result.continueCursor }) };
		});
	},
});

export const getFor = internalQuery({
	args: { turnId: v.id("agentTurns"), id: v.string() },
	handler: async (ctx, { turnId, id }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const recordId = ctx.db.normalizeId("records", id);
			if (!recordId) throw new ConvexError("Record not found.");
			const record = await requireRecord(ctx, member, recordId);
			const fields = await fieldsOf(ctx, record.typeId);
			const out = await recordOut(ctx, member, recordId);
			const [row] = await toRows(ctx, member.workspaceId, [{ record, fields }]);
			const links = Object.fromEntries(
				fields
					.filter((f) => f.kind === "link" && !f.archived && record.values[f.key] !== undefined)
					.map((f) => [f.key, [record.values[f.key]!].flat().map((x) => ({ id: String(x), name: row!.refs[String(x)]?.name ?? String(x) }))]),
			);
			const linkedFrom = [];
			for (const { record: other, fields: theirs, fieldId } of (await linkingRecords(ctx, recordId, { paginationOpts: { numItems: LINKED_MAX, cursor: null } })).page) {
				const type = await ctx.db.get(other.typeId);
				if (type) linkedFrom.push({ id: other._id, type: type.key, name: other.title, via: theirs.find((f) => f._id === fieldId)?.label ?? "" });
			}
			const entries = await ctx.db
				.query("recordHistory")
				.withIndex("by_record", (q) => q.eq("recordId", recordId))
				.order("desc")
				.take(CHANGES_MAX);
			const { refs } = await resolveRefs(ctx, member.workspaceId, entries.flatMap((e) => e.changes.flatMap((c) => [...idsIn(fields, { [c.key]: c.old }), ...idsIn(fields, { [c.key]: c.new })])));
			const shown = (field: Doc<"recordFields"> | undefined, key: string, value: unknown) =>
				value === undefined ? "empty" : field ? String(displayValues([toField(field)], { [key]: value as never }, refs)[key]) : JSON.stringify(value);
			const changes = await Promise.all(
				entries.map(async (e) => ({
					change: e._id,
					time: new Date(e._creationTime).toISOString(),
					action: e.action,
					by: await nameOf(ctx, e.userId),
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
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { id, type: typeName, values = {}, archived } = input as RecordSaveInput;
		return asToolResult(async () => {
			const hasValues = Object.keys(values).length > 0;
			if (archived !== undefined && hasValues) throw new ConvexError("Archive or restore on its own, then change values in another call.");
			let recordId: Id<"records">;
			let change: Id<"recordHistory"> | null;
			if (id) {
				const normalized = ctx.db.normalizeId("records", id);
				if (!normalized) throw new ConvexError("Record not found.");
				const record = await requireRecord(ctx, member, normalized);
				recordId = record._id;
				if (archived !== undefined) change = await setArchived(ctx, who, recordId, archived);
				else if (hasValues) {
					const type = (await ctx.db.get(record.typeId))!;
					const fields = await fieldsOf(ctx, type._id);
					change = await updateRecord(ctx, who, recordId, await valuesFor(new Names(ctx, member), type, fields, values));
				} else throw new ConvexError("Nothing to change: give values, or archived.");
			} else {
				if (archived !== undefined) throw new ConvexError("Create the record first.");
				if (!typeName) throw new ConvexError("Say which database to create.");
				const type = await typeNamed(ctx, member, typeName);
				const fields = await fieldsOf(ctx, type._id);
				({ id: recordId, change } = await createRecord(ctx, who, type._id, await valuesFor(new Names(ctx, member), type, fields, values)));
			}
			return { ...(await recordOut(ctx, member, recordId)), ...(change ? { change } : { unchanged: true }) };
		});
	},
});

export const undoFor = internalMutation({
	args: { turnId: v.id("agentTurns"), change: v.string() },
	handler: async (ctx, { turnId, change }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const historyId = ctx.db.normalizeId("recordHistory", change);
			if (!historyId) throw new ConvexError("Change not found.");
			const undoneBy = await undoChange(ctx, who, historyId);
			const entry = (await ctx.db.get(historyId))!;
			return { undone: change, ...(await recordOut(ctx, member, entry.recordId!)), change: undoneBy };
		});
	},
});

export const saveFieldFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		const { type: typeName, field: name, label, kind, options, linksTo, multiple } = input as FieldSaveInput;
		return asToolResult(async () => {
			const type = await typeNamed(ctx, member, typeName);
			let fieldId: Id<"recordFields">;
			if (name) {
				const field = fieldNamed(await fieldsOf(ctx, type._id), name, type);
				if ((kind && kind !== field.kind) || linksTo || multiple !== undefined)
					throw new ConvexError("Only a field's name and options can change. Add a new field instead.");
				await updateField(ctx, who, field._id, { label, options: options?.map((o) => ({ label: o })) });
				fieldId = field._id;
			} else {
				if (!label || !kind) throw new ConvexError("Give the new field a label and a kind.");
				const linkTypeId = linksTo ? (await typeNamed(ctx, member, linksTo))._id : undefined;
				fieldId = (await createField(ctx, who, type._id, { label, kind, options: options?.map((o) => ({ label: o })), linkTypeId, multiple }))._id;
			}
			const f = (await ctx.db.get(fieldId))!;
			return {
				type: type.key,
				typePlural: type.plural,
				key: f.key,
				label: f.label,
				kind: f.kind,
				...(f.options && { options: f.options.filter((o) => !o.retired).map((o) => o.label) }),
				...(f.linkTypeId && { linksTo: (await ctx.db.get(f.linkTypeId))?.key }),
				...(f.multiple && { multiple: true }),
			};
		});
	},
});

export const saveDatabaseFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const parsed = databaseInput.safeParse(input);
			if (!parsed.success) throw new ConvexError(parsed.error.issues[0]!.message);
			const { type: key, name: plural, singular: name, version, archived } = parsed.data;
			let id: Id<"recordTypes">;
			if (key) {
				id = (await typeNamed(ctx, member, key))._id;
				await updateType(ctx, who, id, { name, plural, archived, version: version ?? -1 });
			} else {
				if (!plural || archived !== undefined) throw new ConvexError("Give the new database a name.");
				id = await createType(ctx, who, { plural, name });
			}
			const type = (await ctx.db.get(id))!;
			return { type: type.key, name: type.name, plural: type.plural, version: type.version ?? 0, archived: type.archived };
		});
	},
});

export const viewsFor = internalQuery({
	args: { turnId: v.id("agentTurns"), type: v.string() },
	handler: async (ctx, { turnId, type: name }) => {
		const { member } = await runningTurn(ctx, turnId);
		return asToolResult(async () => ({ rows: await viewsOf(ctx, member, (await typeNamed(ctx, member, name))._id) }));
	},
});

export const saveViewFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { member, who } = await runningTurn(ctx, turnId);
		return asToolResult(async () => {
			const checked = viewInput.safeParse(input);
			if (!checked.success) throw new ConvexError(checked.error.issues[0]!.message);
			const parsed = checked.data;
			const type = await typeNamed(ctx, member, parsed.type);
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
			const sort = parsed.sort && { ...parsed.sort, field: ["createdAt", "updatedAt"].includes(parsed.sort.field) ? parsed.sort.field : fieldNamed(fields, parsed.sort.field, type).key };
			const id = await saveView(ctx, who, type._id, {
				name: parsed.name ?? old?.name ?? "",
				filters: parsed.filters ? await conditionsFor(ctx, member, type, fields, parsed.filters) : old?.filters.filter((c) => live(c.field)) ?? [],
				sort: parsed.sort === null ? undefined : sort ?? old?.sort,
				columns: parsed.columns ?? old?.columns.filter(live) ?? ["name"],
			}, viewId || undefined, parsed.version);
			return ctx.db.get(id);
		});
	},
});
