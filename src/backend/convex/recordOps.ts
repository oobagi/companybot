import {
	FIELDS_PER_TYPE_MAX,
	DEFAULT_CURRENCY,
	type Field,
	type FieldConfig,
	type FieldValue,
	NAME_KEY,
	type Permission,
	RECORD_MAX_BYTES,
	type ValueMode,
	can,
	canEditMade,
	deniedMessage,
	fieldConfigError,
	indexEntries,
	keyOf,
	madeEditDenied,
	normalizeFieldConfig,
	normalizeValue,
	recordTypeCatalog,
	singularOf,
	sameValue,
	searchTextOf,
	valuesBytes,
} from "@companybot/core";
import { ConvexError, getDocumentSize } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Who, checkVersion, memberOf, nameOf, requireInWorkspace, toActor } from "./lib";

// Records, fields and their history. Shared by the app's functions (records.ts,
// recordTypes.ts) and agent tools (recordTools.ts), so both follow the same rules. Agents pass
// `agentId` and act as the member they help, like memory and connectors. See wiki/data.md.

export type Values = Record<string, FieldValue>;
type Change = Doc<"recordHistory">["changes"][number];

export function requireCan(member: Member, permission: Permission) {
	if (!can(member.role, permission)) throw new ConvexError(deniedMessage(permission));
}

/** A database in the person's workspace. Other workspaces' look like they don't exist. */
export async function requireType(ctx: QueryCtx, member: Member, typeId: Id<"recordTypes">) {
	return requireInWorkspace(member, await ctx.db.get(typeId), "Database");
}

export async function requireRecord(ctx: QueryCtx, member: Member, recordId: Id<"records">) {
	return requireInWorkspace(member, await ctx.db.get(recordId), "Record");
}

/** A type's fields in display order, archived ones included. At most FIELDS_PER_TYPE_MAX. */
export async function fieldsOf(ctx: QueryCtx, typeId: Id<"recordTypes">) {
	const rows = await ctx.db
		.query("recordFields")
		.withIndex("by_type", (q) => q.eq("typeId", typeId))
		.take(FIELDS_PER_TYPE_MAX);
	return rows.sort((a, b) => a.position - b.position);
}

export const toField = (f: Doc<"recordFields">): Field => ({
	key: f.key,
	label: f.label,
	kind: f.kind,
	...(f.options && { options: f.options }),
	...(f.linkTypeId && { linkType: f.linkTypeId }),
	...(f.multiple && { multiple: true }),
});

/** Changes go through here, so this is where record automations will hook in (`fireEvent`). */
export async function logChange(ctx: MutationCtx, who: Who, entry: Omit<Doc<"recordHistory">, "_id" | "_creationTime" | "workspaceId" | "userId" | "agentId">) {
	return ctx.db.insert("recordHistory", {
		workspaceId: who.member.workspaceId,
		userId: who.member.userId,
		...(who.agentId && { agentId: who.agentId }),
		...entry,
	});
}

// ---- Records ----

/** The workspace's currency: the default for new amounts, never applied to existing ones. */
export const currencyOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">) =>
	(await ctx.db.get(workspaceId))?.currency ?? DEFAULT_CURRENCY;

/**
 * Checks values (field key → value; null clears) against the fields, options, people and
 * records as they are now, and returns what to store. Every write goes through here, undo included.
 */
async function normalizeInput(
	ctx: QueryCtx,
	member: Member,
	fields: Doc<"recordFields">[],
	input: Record<string, unknown>,
	mode: ValueMode = "input",
) {
	const byKey = new Map(fields.map((f) => [f.key, f]));
	const currency = await currencyOf(ctx, member.workspaceId);
	const out: Record<string, FieldValue | null> = {};
	for (const [key, raw] of Object.entries(input)) {
		const field = byKey.get(key);
		if (!field || field.archived) throw new ConvexError(`There's no field “${key}”.`);
		const result = normalizeValue(toField(field), raw, mode, currency);
		if ("error" in result) throw new ConvexError(result.error);
		const ids = result.value === null ? [] : [result.value].flat().map(String);
		for (const id of field.kind === "user" ? ids : []) {
			const userId = ctx.db.normalizeId("users", id);
			if (!userId || !(await memberOf(ctx, userId, member.workspaceId)))
				throw new ConvexError(`Someone picked for “${field.label}” isn't in this workspace.`);
		}
		for (const id of field.kind === "link" ? ids : []) {
			const recordId = ctx.db.normalizeId("records", id);
			const target = recordId && (await ctx.db.get(recordId));
			if (!target || target.workspaceId !== member.workspaceId || target.typeId !== field.linkTypeId || target.archived)
				throw new ConvexError(`“${field.label}” links to a record that doesn't exist.`);
		}
		out[key] = result.value;
	}
	return out;
}

/** Rewrites the index rows (recordValues) of `keys`, or of every field. */
async function writeIndex(ctx: MutationCtx, record: Doc<"records">, fields: Doc<"recordFields">[], keys?: Set<string>) {
	for (const field of fields) {
		if (keys && !keys.has(field.key)) continue;
		const old = await ctx.db
			.query("recordValues")
			.withIndex("by_record", (q) => q.eq("recordId", record._id).eq("fieldId", field._id))
			.collect();
		for (const row of old) await ctx.db.delete(row._id);
		for (const entry of indexEntries(toField(field), record.values[field.key])) {
			const ref = "ref" in entry ? { ref: entry.ref as Id<"records"> } : entry;
			await ctx.db.insert("recordValues", { recordId: record._id, fieldId: field._id, ...ref, at: record._creationTime });
		}
	}
}

async function clearIndex(ctx: MutationCtx, recordId: Id<"records">) {
	const rows = await ctx.db
		.query("recordValues")
		.withIndex("by_record", (q) => q.eq("recordId", recordId))
		.collect();
	for (const row of rows) await ctx.db.delete(row._id);
}

function requireSize(values: Values) {
	if (valuesBytes(values) > RECORD_MAX_BYTES)
		throw new ConvexError(`This record is too big (over ${RECORD_MAX_BYTES / 1024} KB). Keep long text in a note or file instead.`);
}

const stamp = (who: Who) => ({ updatedAt: Date.now(), updatedBy: who.member.userId, updatedByAgent: who.agentId });

/** Returns the new record and its "created" history entry. */
export async function createRecord(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: Record<string, unknown>) {
	requireCan(who.member, "records.edit");
	const type = await requireType(ctx, who.member, typeId);
	if (type.archived) throw new ConvexError(`${type.plural} are archived.`);
	const fields = await fieldsOf(ctx, typeId);
	const values: Values = {};
	for (const [key, value] of Object.entries(await normalizeInput(ctx, who.member, fields, input))) {
		if (value !== null) values[key] = value;
	}
	const title = values[NAME_KEY];
	if (typeof title !== "string") throw new ConvexError(`Give the ${type.name.toLowerCase()} a name.`);
	requireSize(values);
	const id = await ctx.db.insert("records", {
		workspaceId: who.member.workspaceId,
		typeId,
		title,
		values,
		searchText: searchTextOf(fields.map(toField), values),
		archived: false,
		createdBy: who.member.userId,
		...stamp(who),
	});
	await writeIndex(ctx, (await ctx.db.get(id))!, fields);
	const change = await logChange(ctx, who, {
		typeId,
		recordId: id,
		action: "created",
		changes: Object.entries(values).map(([key, value]) => ({ key, new: value })),
	});
	return { id, change };
}

/**
 * Sets the given fields and leaves the rest alone, so people editing different fields never clash.
 * Returns the history entry, or null if nothing changed.
 */
export async function updateRecord(ctx: MutationCtx, who: Who, recordId: Id<"records">, input: Record<string, unknown>) {
	requireCan(who.member, "records.edit");
	const record = await requireRecord(ctx, who.member, recordId);
	if (record.archived) throw new ConvexError("Restore it before changing it.");
	const fields = await fieldsOf(ctx, record.typeId);
	return applyValues(ctx, who, record, fields, await normalizeInput(ctx, who.member, fields, input));
}

/** Stores `next` (null clears) and logs what changed. Returns the history entry, if anything changed. */
async function applyValues(
	ctx: MutationCtx,
	who: Who,
	record: Doc<"records">,
	fields: Doc<"recordFields">[],
	next: Record<string, FieldValue | null>,
	undoes?: Id<"recordHistory">,
) {
	const changes: Change[] = [];
	const values: Values = { ...record.values };
	for (const [key, value] of Object.entries(next)) {
		if (sameValue(record.values[key], value)) continue;
		changes.push({ key, ...(record.values[key] !== undefined && { old: record.values[key] }), ...(value !== null && { new: value }) });
		if (value === null) delete values[key];
		else values[key] = value;
	}
	if (changes.length === 0) return null;
	const title = values[NAME_KEY];
	if (typeof title !== "string") throw new ConvexError("Every record needs a name.");
	requireSize(values);
	await ctx.db.patch(record._id, { title, values, searchText: searchTextOf(fields.map(toField), values), ...stamp(who) });
	await writeIndex(ctx, { ...record, values }, fields, new Set(changes.map((c) => c.key)));
	return logChange(ctx, who, { typeId: record.typeId, recordId: record._id, action: "updated", changes, ...(undoes && { undoes }) });
}

/**
 * Archived records keep their values and history but leave lists, filters and search.
 * Links pointing at one stay as they are (rewriting them could be thousands of writes);
 * queries treat it as gone and show it as archived. Restoring rebuilds its index from
 * the fields as they are now; values on retired options or archived fields stay, as on
 * any live record.
 */
export async function setArchived(ctx: MutationCtx, who: Who, recordId: Id<"records">, archived: boolean, undoes?: Id<"recordHistory">) {
	requireCan(who.member, "records.edit");
	const record = await requireRecord(ctx, who.member, recordId);
	if (record.archived === archived) return null;
	await ctx.db.patch(recordId, { archived, ...stamp(who) });
	if (archived) await clearIndex(ctx, recordId);
	else await writeIndex(ctx, { ...record, archived }, await fieldsOf(ctx, record.typeId));
	return logChange(ctx, who, { typeId: record.typeId, recordId, action: archived ? "archived" : "restored", changes: [], ...(undoes && { undoes }) });
}

/**
 * Reverses one change to a record. Refuses if a value it touched has changed since,
 * so an undo never silently overwrites newer work, and checks the old values like any
 * other write: no archived fields, retired options, or archived link targets.
 */
export async function undoChange(ctx: MutationCtx, who: Who, historyId: Id<"recordHistory">) {
	requireCan(who.member, "records.edit");
	const entry = await ctx.db.get(historyId);
	if (!entry || entry.workspaceId !== who.member.workspaceId || !entry.recordId) throw new ConvexError("Change not found.");
	if (entry.undoneBy) throw new ConvexError("That change was already undone.");
	const record = await requireRecord(ctx, who.member, entry.recordId);
	let undoneBy: Id<"recordHistory"> | null;
	if (entry.action === "updated") {
		if (record.archived) throw new ConvexError("Restore it before undoing changes.");
		const fields = await fieldsOf(ctx, record.typeId);
		for (const change of entry.changes) {
			if (!sameValue(record.values[change.key], change.new)) {
				const label = fields.find((f) => f.key === change.key)?.label ?? change.key;
				throw new ConvexError(`“${label}” has changed since, so this can't be undone.`);
			}
		}
		const old = Object.fromEntries(entry.changes.map((c) => [c.key, c.old ?? null]));
		undoneBy = await applyValues(ctx, who, record, fields, await normalizeInput(ctx, who.member, fields, old, "stored"), historyId);
	} else undoneBy = await setArchived(ctx, who, record._id, entry.action !== "archived", historyId);
	if (!undoneBy) throw new ConvexError("Nothing to undo.");
	await ctx.db.patch(historyId, { undoneBy });
	return undoneBy;
}

/** Notes which records a chat message references, so each record can list where it was discussed. */
export async function noteMentions(ctx: MutationCtx, message: { _id: Id<"chatMessages">; chatId: Id<"chats"> }, recordIds: Id<"records">[]) {
	for (const recordId of recordIds) await ctx.db.insert("recordMentions", { recordId, messageId: message._id, chatId: message.chatId });
}

/** The records among `ids` in the workspace, deduped. Others are dropped, not trusted. */
export async function workspaceRecords(ctx: QueryCtx, workspaceId: Id<"workspaces">, ids: Id<"records">[]) {
	const out: Id<"records">[] = [];
	for (const id of new Set(ids)) if ((await ctx.db.get(id))?.workspaceId === workspaceId) out.push(id);
	return out;
}

// ---- Fields and types ----

export type FieldInput = Omit<FieldConfig, "options" | "linkType"> & {
	options?: { id?: string; label: string }[];
	linkTypeId?: Id<"recordTypes">;
};

function requireUniqueLabel(fields: Doc<"recordFields">[], label: string, except?: Id<"recordFields">) {
	if (fields.some((f) => f._id !== except && !f.archived && f.label.toLowerCase() === label.toLowerCase()))
		throw new ConvexError(`There's already a field called “${label}”.`);
}

function requireFieldConfig(config: FieldConfig) {
	const error = fieldConfigError(config);
	if (error) throw new ConvexError(error);
}

/** Adds a field to a type. Existing records just don't have a value yet: nothing to backfill. */
export async function createField(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: FieldInput) {
	requireCan(who.member, "fields.create");
	await requireType(ctx, who.member, typeId);
	const fields = await fieldsOf(ctx, typeId);
	if (fields.length >= FIELDS_PER_TYPE_MAX) throw new ConvexError(`A database holds up to ${FIELDS_PER_TYPE_MAX} fields.`);
	const { linkTypeId, ...rest } = input;
	const config = normalizeFieldConfig({ ...rest, linkType: linkTypeId });
	requireFieldConfig(config);
	requireUniqueLabel(fields, config.label);
	if (linkTypeId) await requireType(ctx, who.member, linkTypeId);
	const key = keyOf(config.label, fields.map((f) => f.key));
	const id = await insertField(ctx, who.member, typeId, { ...config, key }, Math.max(0, ...fields.map((f) => f.position)) + 1, linkTypeId);
	await logChange(ctx, who, { typeId, fieldId: id, action: "field.created", changes: [{ key: "label", new: config.label }] });
	return (await ctx.db.get(id))!;
}

async function requireEditableField(ctx: QueryCtx, member: Member, fieldId: Id<"recordFields">) {
	const field = requireInWorkspace(member, await ctx.db.get(fieldId), "Field");
	if (!canEditMade(toActor(member), "fields.manage", field.createdBy)) throw new ConvexError(madeEditDenied);
	return field;
}

/**
 * Renames a field or changes its options. Its kind is fixed: values were checked against it.
 * Options left out are retired, not deleted: records keep them, but they can't be set again.
 * Sending one back (by id, or the same label) brings it back.
 */
export async function updateField(
	ctx: MutationCtx,
	who: Who,
	fieldId: Id<"recordFields">,
	update: { label?: string; options?: { id?: string; label: string }[] },
) {
	const field = await requireEditableField(ctx, who.member, fieldId);
	let options = field.options;
	if (update.options) {
		const existing = field.options ?? [];
		const ids = existing.map((e) => e.id);
		const active = update.options.map((o) => {
			const id = o.id || existing.find((e) => e.label.toLowerCase() === o.label.trim().toLowerCase())?.id || keyOf(o.label, ids);
			ids.push(id);
			return { id, label: o.label };
		});
		const kept = new Set(active.map((o) => o.id));
		options = [...active, ...existing.filter((e) => !kept.has(e.id)).map((e) => ({ ...e, retired: true }))];
	}
	const config = normalizeFieldConfig({ ...toField(field), label: update.label ?? field.label, options });
	requireFieldConfig(config);
	requireUniqueLabel(await fieldsOf(ctx, field.typeId), config.label, fieldId);
	const changes: Change[] = [];
	if (config.label !== field.label) changes.push({ key: "label", old: field.label, new: config.label });
	const labels = (options?: { label: string; retired?: boolean }[]) => options?.filter((o) => !o.retired).map((o) => o.label) ?? [];
	if (!sameValue(labels(field.options), labels(config.options)))
		changes.push({ key: "options", old: labels(field.options), new: labels(config.options) });
	if (changes.length === 0) return;
	await ctx.db.patch(fieldId, { label: config.label, ...(config.options && { options: config.options }), updatedAt: Date.now() });
	await logChange(ctx, who, { typeId: field.typeId, fieldId, action: "field.updated", changes });
}

/** Archived fields keep their values on every record, so restoring one brings them back. */
export async function setFieldArchived(ctx: MutationCtx, who: Who, fieldId: Id<"recordFields">, archived: boolean) {
	const field = await requireEditableField(ctx, who.member, fieldId);
	if (field.key === NAME_KEY) throw new ConvexError("Every record needs a name, so this field stays.");
	if (field.archived === archived) return;
	if (!archived) requireUniqueLabel(await fieldsOf(ctx, field.typeId), field.label, fieldId);
	await ctx.db.patch(fieldId, { archived, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId: field.typeId, fieldId, action: archived ? "field.archived" : "field.restored", changes: [] });
}

const TYPES_MAX = 32;

/** Trimmed names, unique among live databases. The singular defaults to a guess from the plural. */
function databaseNames(plural: string, singular: string | undefined, types: Doc<"recordTypes">[], except?: Id<"recordTypes">) {
	const names = { name: (singular ?? singularOf(plural.trim())).trim(), plural: plural.trim() };
	if (!names.name || !names.plural || names.name.length > 120 || names.plural.length > 120) throw new ConvexError("Give the database a name, up to 120 characters.");
	if (types.some((t) => t._id !== except && !t.archived && [t.name, t.plural].some((n) => [names.name, names.plural].some((m) => n.toLowerCase() === m.toLowerCase()))))
		throw new ConvexError(`There's already a database called “${names.plural}”.`);
	return names;
}

/** A new database with just a name field. */
export async function createType(ctx: MutationCtx, who: Who, input: { plural: string; name?: string }) {
	requireCan(who.member, "fields.manage");
	const types = await typesOf(ctx, who.member.workspaceId);
	if (types.length >= TYPES_MAX) throw new ConvexError(`A workspace holds up to ${TYPES_MAX} databases, including archived ones.`);
	const names = databaseNames(input.plural, input.name, types);
	const typeId = await insertType(ctx, who.member, { key: keyOf(names.name, [...types.map((t) => t.key), "campaign"]), ...names });
	await insertField(ctx, who.member, typeId, { key: NAME_KEY, label: "Name", kind: "text" }, 0);
	await logChange(ctx, who, { typeId, action: "database.created", changes: Object.entries(names).map(([key, value]) => ({ key, new: value })) });
	return typeId;
}

/** Rename (a new plural alone re-guesses the singular) or archive. */
export async function updateType(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: { name?: string; plural?: string; archived?: boolean; version: number }) {
	requireCan(who.member, "fields.manage");
	const type = await requireType(ctx, who.member, typeId);
	checkVersion(type.version ?? 0, input.version);
	if (type.archived) throw new ConvexError("This database is archived.");
	const names = databaseNames(input.plural ?? type.plural, input.name ?? (input.plural === undefined ? type.name : undefined), await typesOf(ctx, who.member.workspaceId), typeId);
	const changes = (["name", "plural"] as const).filter((key) => type[key] !== names[key]).map((key) => ({ key, old: type[key], new: names[key] }));
	if (!changes.length && !input.archived) return;
	await ctx.db.patch(typeId, { ...names, archived: !!input.archived, version: (type.version ?? 0) + 1, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId, action: input.archived ? "database.archived" : "database.updated", changes });
}

/** Bounded by TYPES_MAX, which createType enforces. */
export const typesOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">) =>
	ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(TYPES_MAX);

const insertType = (ctx: MutationCtx, member: Pick<Member, "workspaceId" | "userId">, type: { key: string; name: string; plural: string }) =>
	ctx.db.insert("recordTypes", { workspaceId: member.workspaceId, ...type, archived: false, createdBy: member.userId, updatedAt: Date.now() });

const insertField = (
	ctx: MutationCtx,
	member: Pick<Member, "workspaceId" | "userId">,
	typeId: Id<"recordTypes">,
	{ linkType, ...field }: Field,
	position: number,
	linkTypeId?: Id<"recordTypes">,
) =>
	ctx.db.insert("recordFields", {
		workspaceId: member.workspaceId,
		typeId,
		...field,
		...(linkTypeId && { linkTypeId }),
		position,
		archived: false,
		createdBy: member.userId,
		updatedAt: Date.now(),
	});

/** Adds the built-in types (core's recordTypeCatalog) a workspace doesn't have yet. Safe to re-run. */
export async function seedRecordTypes(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
	const member = { workspaceId, userId };
	const ids = new Map((await typesOf(ctx, workspaceId)).map((t) => [t.key, t._id]));
	const added = recordTypeCatalog.filter((def) => !ids.has(def.key));
	for (const { key, name, plural } of added) ids.set(key, await insertType(ctx, member, { key, name, plural }));
	for (const def of added) {
		for (const [position, field] of def.fields.entries()) {
			await insertField(ctx, member, ids.get(def.key)!, field, position, field.linkType ? ids.get(field.linkType) : undefined);
		}
	}
}

// ---- Display ----

/** A person's or record's name, for a user or link value. Records linked to but archived say so. */
export type Ref = { name: string; archived?: true };

/** Most names one response resolves, and most bytes it reads doing so; the rest go through `records.refs`. */
const REFS_MAX = 200;
const REFS_BYTES = 4 * 1024 * 1024;

/** The people and records a set of values points at. */
export function idsIn(fields: Doc<"recordFields">[], values: Partial<Values>) {
	return fields.filter((f) => f.kind === "user" || f.kind === "link").flatMap((f) => [values[f.key] ?? []].flat().map(String));
}

/**
 * Names for `ids`, each read once, within a read budget so a page full of links can't
 * hit Convex's per-query limits. Ids past the budget come back in `unresolved`.
 */
export async function resolveRefs(ctx: QueryCtx, workspaceId: Id<"workspaces">, ids: Iterable<string>) {
	const refs: Record<string, Ref> = {};
	const unresolved: string[] = [];
	let count = 0;
	let bytes = 0;
	for (const id of new Set(ids)) {
		if (count >= REFS_MAX || bytes >= REFS_BYTES) {
			unresolved.push(id);
			continue;
		}
		count++;
		const recordId = ctx.db.normalizeId("records", id);
		const userId = recordId ? null : ctx.db.normalizeId("users", id);
		if (recordId) {
			const record = await ctx.db.get(recordId);
			if (record?.workspaceId !== workspaceId) continue;
			bytes += getDocumentSize(record);
			refs[id] = { name: record.title, ...(record.archived && { archived: true }) };
		} else if (userId) {
			refs[id] = { name: (await memberOf(ctx, userId, workspaceId)) ? await nameOf(ctx, userId) : "Former member" };
		}
	}
	return { refs, unresolved };
}

/** Records, display-ready, with the names their values point at resolved once for all of them. */
export async function toRows(ctx: QueryCtx, workspaceId: Id<"workspaces">, items: { record: Doc<"records">; fields: Doc<"recordFields">[] }[]) {
	const idsOf = items.map(({ record, fields }) => idsIn(fields, record.values));
	const { refs, unresolved } = await resolveRefs(ctx, workspaceId, idsOf.flat());
	const missing = new Set(unresolved);
	return items.map(({ record }, i) => ({
		_id: record._id,
		_creationTime: record._creationTime,
		typeId: record.typeId,
		title: record.title,
		values: record.values,
		archived: record.archived,
		updatedAt: record.updatedAt,
		refs: Object.fromEntries(idsOf[i]!.filter((id) => refs[id]).map((id) => [id, refs[id]!])),
		/** Ids past the read budget: look them up with `records.refs`. */
		unresolved: idsOf[i]!.filter((id) => missing.has(id)),
	}));
}
