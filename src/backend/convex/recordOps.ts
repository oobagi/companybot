import {
	FIELDS_PER_TYPE_MAX,
	DEFAULT_CURRENCY,
	type Field,
	type FieldConfig,
	type FieldValue,
	NAME_KEY,
	RECORD_MAX_BYTES,
	type ValueMode,
	autoColor,
	convertValue,
	fieldConfigError,
	indexEntries,
	keyOf,
	normalizeFieldConfig,
	normalizeValue,
	singularOf,
	sameValue,
	searchTextOf,
	valuesBytes,
} from "@companybot/core";
import { type AccessLevel, PUBLIC_ACCESS, canAddIn, reaches } from "@companybot/core";
import { ConvexError, getDocumentSize } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, type Outsider, type Who, type Writer, checkPermission, checkVersion, memberOf, memo, nameOf, requireInWorkspace } from "./lib";
import { canAdd, reach, requireAccess } from "./placeAccess";
import { notePlace, readArtifact, writeSources } from "./replySources";
import { toggleTrash } from "./trashOps";
import { asField, undoFieldChange } from "./fieldChanges";

// Records, fields and their history. Shared by the app's functions (records.ts,
// recordTypes.ts) and agent tools (recordTools.ts), so both follow the same rules. Agents pass
// `agentId` and act as the member they help, like memory and connectors. See wiki/data.md.

export type Values = Record<string, FieldValue>;
type Change = Doc<"recordHistory">["changes"][number];

/**
 * A database in the person's workspace that they reach `need` in (its Who can access list).
 * Other workspaces' look like they don't exist; one kept from them names who can see or change it.
 * `edit` is for changes, so it also refuses a database in Archive. `add` is Add or Edit: they may add
 * records and see and change their own (`requireRecord`), not everyone's.
 */
export async function requireType(ctx: QueryCtx, member: Member, typeId: Id<"recordTypes">, need: AccessLevel = "view", asked?: string) {
	const type = requireInWorkspace(member, await ctx.db.get(typeId), "Database");
	requireAccess(member, "database", type.plural, type.access, need, asked);
	if (!(await readArtifact(ctx, member, type))) throw new ConvexError("Database not found.");
	await notePlace(ctx, member, type._id, type.access);
	if (need === "edit" && type.archived) throw new ConvexError("This database is in Archive. Restore it to make changes.");
	return type;
}

/** Whether `member` made this record: with Add, those are the ones they see and change. Records made from outside are their contact's. */
export const madeBy = (record: Doc<"records">, member: Member) => !record.contact && !!record.createdBy && record.createdBy === member.userId;

/**
 * A record whose database the person reaches `need` in (as `requireType`). With Add instead, only one
 * they made (`madeBy`), for viewing and changing alike: Add never shows anyone else's.
 */
export async function requireRecord(ctx: QueryCtx, member: Member, recordId: Id<"records">, need: AccessLevel = "view") {
	const record = requireInWorkspace(member, await ctx.db.get(recordId), "Record");
	const type = await ctx.db.get(record.typeId);
	const own = !!type && madeBy(record, member) && canAdd(member, type.access) && !reaches(reach(member, type.access), need);
	await requireType(ctx, member, record.typeId, own ? "add" : need);
	return record;
}

/**
 * How far someone reaches in each database ("edit", "view" or null), read once per call however many
 * records share it. Lists, search, links and history drop what this says null to.
 */
export const typeReach = (ctx: QueryCtx, member: Member) =>
	memo(async (typeId: Id<"recordTypes">) => {
		const type = await ctx.db.get(typeId);
		if (!type || type.workspaceId !== member.workspaceId) return null;
		const level = await readArtifact(ctx, { ...member, replyId: undefined }, type) ? reach(member, type.access) : null;
		if (level) await notePlace(ctx, member, type._id, type.access);
		return level;
	});

/** Whether someone can see records of this database (`typeReach`). */
export const typeVisible = (ctx: QueryCtx, member: Member) => {
	const level = typeReach(ctx, member);
	return async (typeId: Id<"recordTypes">) => reaches(await level(typeId), "view");
};

/** A record from an id an agent sent, which may be any string. */
export function recordById(ctx: QueryCtx, member: Member, id: string, notFound = "Record not found.") {
	const recordId = ctx.db.normalizeId("records", id);
	if (!recordId) throw new ConvexError(notFound);
	return requireRecord(ctx, member, recordId);
}

/** Whether each database is in Archive, read once per call however many records share it. */
export const typeTrashed = (ctx: QueryCtx) => memo((typeId: Id<"recordTypes">) => ctx.db.get(typeId).then((t) => !t || t.archived));

/** A record is in Archive on its own, or with its database. */
export const inTrash = async (ctx: QueryCtx, record: Doc<"records">) => record.archived || (await typeTrashed(ctx)(record.typeId));

/** Refuses changes to a record in Archive. */
export async function requireLive(ctx: QueryCtx, record: Doc<"records">) {
	if (await inTrash(ctx, record)) throw new ConvexError("This record is in Archive. Restore it to make changes.");
}

/** A type's fields in display order, archived ones included. At most FIELDS_PER_TYPE_MAX. */
/** A field a board can group cards by: a live choice field holding one option. */
export const groupsCards = (f: Doc<"recordFields">) => !f.archived && f.kind === "choice" && !f.multiple;

/** Why a database with no such field can't show as a board: it would show no cards to anyone. */
export const NO_BOARD = "Add a choice field first: a board groups cards by one.";

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
	...(f.icon && { icon: f.icon }),
	...(f.options && { options: f.options }),
	...(f.linkTypeId && { linkType: f.linkTypeId }),
	...(f.multiple && { multiple: true }),
});

/**
 * Fields as this person's app shows them. A link to a database they can't see keeps no id of it, which
 * agents' tools would take and name: `linksHidden` instead, and its values show as locked records.
 */
export function fieldsShown(ctx: QueryCtx, member: Member) {
	const visible = typeVisible(ctx, member);
	return async (f: Doc<"recordFields">) => {
		const { linkType, ...field } = toField(f);
		if (!linkType) return field;
		return (await visible(f.linkTypeId!)) ? { ...field, linkType } : { ...field, linksHidden: true as const };
	};
}

/** Changes go through here, so this is where record automations will hook in (`fireEvent`). */
export async function logChange(ctx: MutationCtx, who: Writer, entry: Omit<Doc<"recordHistory">, "_id" | "_creationTime" | "workspaceId" | "userId" | "agentId" | "contact">) {
	if ("outsider" in who) {
		const { workspaceId, contact, agentId } = who.outsider;
		return ctx.db.insert("recordHistory", { workspaceId, contact, agentId, ...entry });
	}
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
	/** The record's values now: a link it already has may stay even where the person can't see its target. */
	current: Values = {},
) {
	const byKey = new Map(fields.map((f) => [f.key, f]));
	const currency = await currencyOf(ctx, member.workspaceId);
	const out: Record<string, FieldValue | null> = {};
	for (const [key, raw] of Object.entries(input)) {
		const field = byKey.get(key);
		if (!field || field.archived) throw new ConvexError(`There's no field “${key}”.`);
		if (field.change) throw new ConvexError(`“${field.label}” is changing kind. Try again when it's done.`);
		const result = normalizeValue(toField(field), raw, mode, currency);
		if ("error" in result) throw new ConvexError(result.error);
		const ids = result.value === null ? [] : [result.value].flat().map(String);
		for (const id of field.kind === "user" ? ids : []) {
			const userId = ctx.db.normalizeId("users", id);
			if (!userId || !(await memberOf(ctx, userId, member.workspaceId)))
				throw new ConvexError(`Someone picked for “${field.label}” isn't in this workspace.`);
		}
		const kept = new Set([current[key] ?? []].flat().map(String));
		for (const id of field.kind === "link" ? ids : []) {
			const recordId = ctx.db.normalizeId("records", id);
			const target = recordId && (await ctx.db.get(recordId));
			if (!target || target.workspaceId !== member.workspaceId || target.typeId !== field.linkTypeId || (await inTrash(ctx, target)))
				throw new ConvexError(`“${field.label}” links to a record that doesn't exist.`);
			// Linking reads the target (its name shows on this record), so it takes seeing its database.
			if (!kept.has(id)) await requireRecord(ctx, member, target._id);
		}
		out[key] = result.value;
	}
	return out;
}

/** Rewrites the index rows (recordValues) of `keys`, or of every field. */
export async function writeIndex(ctx: MutationCtx, record: Doc<"records">, fields: Doc<"recordFields">[], keys?: Set<string>) {
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

const stamp = (who: Writer) =>
	"outsider" in who ? { updatedAt: Date.now(), updatedBy: undefined, updatedByAgent: who.outsider.agentId } : { updatedAt: Date.now(), updatedBy: who.member.userId, updatedByAgent: who.agentId };

/** Returns the new record and its "created" history entry. Takes Edit or Add in its database. */
export async function createRecord(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: Record<string, unknown>) {
	checkPermission(who.member, "records.edit");
	const type = await requireType(ctx, who.member, typeId, "add");
	if (type.archived) throw new ConvexError(`${type.plural} is in Archive.`);
	const fields = await fieldsOf(ctx, typeId);
	const values: Values = {};
	for (const [key, value] of Object.entries(await normalizeInput(ctx, who.member, fields, input))) {
		if (value !== null) values[key] = value;
	}
	const title = values[NAME_KEY];
	if (typeof title !== "string") throw new ConvexError(`Give the ${type.name.toLowerCase()} a name.`);
	requireSize(values);
	await writeSources(ctx, who.member, typeId);
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
	checkPermission(who.member, "records.edit");
	const record = await requireRecord(ctx, who.member, recordId, "edit");
	await requireLive(ctx, record);
	const fields = await fieldsOf(ctx, record.typeId);
	return applyValues(ctx, who, record, fields, await normalizeInput(ctx, who.member, fields, input, "input", record.values));
}

/** Stores `next` (null clears) and logs what changed. Returns the history entry, if anything changed. */
async function applyValues(
	ctx: MutationCtx,
	who: Writer,
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
	if (!("outsider" in who)) await writeSources(ctx, who.member, record.typeId);
	await ctx.db.patch(record._id, { title, values, searchText: searchTextOf(fields.map(toField), values), ...stamp(who) });
	await writeIndex(ctx, { ...record, values }, fields, new Set(changes.map((c) => c.key)));
	return logChange(ctx, who, { typeId: record.typeId, recordId: record._id, action: "updated", changes, ...(undoes && { undoes }) });
}

/**
 * Moves a record to Archive or back. In Trash it keeps its values and history but leaves lists,
 * filters and search. Links pointing at one stay as they are (rewriting them could be thousands
 * of writes); queries treat it as gone and show it as deleted. Restoring rebuilds its index from
 * the fields as they are now; values on retired options or fields in Archive stay, as on any live record.
 */
export async function setRecordTrashed(ctx: MutationCtx, who: Who, recordId: Id<"records">, archived: boolean, undoes?: Id<"recordHistory">) {
	checkPermission(who.member, "records.edit");
	const record = await requireRecord(ctx, who.member, recordId, "edit");
	if (record.archived === archived) return null;
	if (archived) await requireLive(ctx, record);
	else {
		const type = await ctx.db.get(record.typeId);
		if (type?.archived) throw new ConvexError(`${type.plural} is in Archive. Restore it first.`);
	}
	await toggleTrash(ctx, who, archived, { kind: "record", id: recordId, name: record.title, typeId: record.typeId });
	await ctx.db.patch(recordId, { archived, ...stamp(who) });
	if (archived) await clearIndex(ctx, recordId);
	else await writeIndex(ctx, { ...record, archived }, await fieldsOf(ctx, record.typeId));
	return logChange(ctx, who, { typeId: record.typeId, recordId, action: archived ? "archived" : "restored", changes: [], ...(undoes && { undoes }) });
}

/**
 * Reverses one change to a record. Refuses if a value it touched has changed since,
 * so an undo never silently overwrites newer work, and checks the old values like any
 * other write: no fields in Archive, retired options, or link targets in Archive.
 */
export async function undoChange(ctx: MutationCtx, who: Who, historyId: Id<"recordHistory">) {
	const entry = await ctx.db.get(historyId);
	// A change to a field's kind takes the field's permission (fieldChanges.ts), not the records'.
	if (entry?.workspaceId === who.member.workspaceId && entry.fieldId && !entry.recordId) return (await undoFieldChange(ctx, who, historyId)).historyId;
	checkPermission(who.member, "records.edit");
	if (!entry || entry.workspaceId !== who.member.workspaceId || !entry.recordId) throw new ConvexError("Change not found.");
	if (entry.undoneBy) throw new ConvexError("That change was already undone.");
	const record = await requireRecord(ctx, who.member, entry.recordId, "edit");
	let undoneBy: Id<"recordHistory"> | null;
	if (entry.action === "updated") {
		await requireLive(ctx, record);
		const fields = await fieldsOf(ctx, record.typeId);
		for (const change of entry.changes) {
			if (!sameValue(record.values[change.key], change.new)) {
				const label = fields.find((f) => f.key === change.key)?.label ?? change.key;
				throw new ConvexError(`“${label}” has changed since, so this can't be undone.`);
			}
		}
		const old = Object.fromEntries(entry.changes.map((c) => [c.key, c.old ?? null]));
		undoneBy = await applyValues(ctx, who, record, fields, await normalizeInput(ctx, who.member, fields, old, "stored", record.values), historyId);
	} else undoneBy = await setRecordTrashed(ctx, who, record._id, entry.action !== "archived", historyId);
	if (!undoneBy) throw new ConvexError("Nothing to undo.");
	await ctx.db.patch(historyId, { undoneBy });
	return undoneBy;
}

// ---- Records for someone outside (Public at Add) ----

/**
 * A database someone outside may add to: in their workspace, live, with Public at Add on its list. They see
 * only the records they made there (`ownRecordFor`), never its other records or its settings.
 */
export async function addableFor(ctx: QueryCtx, by: Outsider, typeId: Id<"recordTypes">) {
	const type = await ctx.db.get(typeId);
	if (!type || type.workspaceId !== by.workspaceId || type.archived || !canAddIn(PUBLIC_ACCESS, type.access)) throw new ConvexError("That database isn't shared with you.");
	return type;
}

/** One of their own records (made from this contact) in a database they may add to. Anyone else's looks like it doesn't exist. */
export async function ownRecordFor(ctx: QueryCtx, by: Outsider, recordId: Id<"records">) {
	const record = await ctx.db.get(recordId);
	if (!record || record.workspaceId !== by.workspaceId || record.contact !== by.contact) throw new ConvexError("Record not found.");
	await addableFor(ctx, by, record.typeId);
	return record;
}

/** Fields someone outside may fill: never a teammate or a link (picking one would read people or other records). */
export const outsiderFields = (fields: Doc<"recordFields">[]) => fields.filter((f) => !f.archived && f.kind !== "user" && f.kind !== "link");

/** Values from outside, checked like any write against the fields they may fill. */
async function outsiderInput(ctx: QueryCtx, by: Outsider, fields: Doc<"recordFields">[], input: Record<string, unknown>) {
	const byKey = new Map(outsiderFields(fields).map((f) => [f.key, f]));
	const currency = await currencyOf(ctx, by.workspaceId);
	const out: Record<string, FieldValue | null> = {};
	for (const [key, raw] of Object.entries(input)) {
		const field = byKey.get(key);
		if (!field) throw new ConvexError(`There's no field “${key}” you can fill.`);
		const result = normalizeValue(toField(field), raw, "input", currency);
		if ("error" in result) throw new ConvexError(result.error);
		out[key] = result.value;
	}
	return out;
}

/** A record made for someone outside, by the agent talking with them. History names the agent and their contact. */
export async function createRecordFor(ctx: MutationCtx, by: Outsider, typeId: Id<"recordTypes">, input: Record<string, unknown>) {
	const type = await addableFor(ctx, by, typeId);
	const fields = await fieldsOf(ctx, type._id);
	const values: Values = {};
	for (const [key, value] of Object.entries(await outsiderInput(ctx, by, fields, input))) if (value !== null) values[key] = value;
	const title = values[NAME_KEY];
	if (typeof title !== "string") throw new ConvexError(`Give the ${type.name.toLowerCase()} a name.`);
	requireSize(values);
	const id = await ctx.db.insert("records", {
		workspaceId: by.workspaceId,
		typeId,
		title,
		values,
		searchText: searchTextOf(fields.map(toField), values),
		archived: false,
		contact: by.contact,
		...stamp({ outsider: by }),
	});
	await writeIndex(ctx, (await ctx.db.get(id))!, fields);
	const change = await logChange(ctx, { outsider: by }, { typeId, recordId: id, action: "created", changes: Object.entries(values).map(([key, value]) => ({ key, new: value })) });
	return { id, change };
}

/** Changing or cancelling needs a sender that checked out: anyone can put someone else's address in an email's From. */
function requireVerified(by: Outsider) {
	if (!by.verified)
		throw new ConvexError("This email's sender couldn't be verified, so their records can't be changed or cancelled from it. Tell them, and offer a text or someone on staff instead.");
}

/** Changes one of their own records' fields (null clears), like `updateRecord`. */
export async function updateRecordFor(ctx: MutationCtx, by: Outsider, recordId: Id<"records">, input: Record<string, unknown>) {
	requireVerified(by);
	const record = await ownRecordFor(ctx, by, recordId);
	await requireLive(ctx, record);
	const fields = await fieldsOf(ctx, record.typeId);
	return applyValues(ctx, { outsider: by }, record, fields, await outsiderInput(ctx, by, fields, input));
}

/** Archives one of their own records (cancels it). Staff can restore it from Archive; they can't. */
export async function archiveRecordFor(ctx: MutationCtx, by: Outsider, recordId: Id<"records">) {
	requireVerified(by);
	const record = await ownRecordFor(ctx, by, recordId);
	await requireLive(ctx, record);
	await toggleTrash(ctx, { outsider: by }, true, { kind: "record", id: recordId, name: record.title, typeId: record.typeId });
	await ctx.db.patch(recordId, { archived: true, ...stamp({ outsider: by }) });
	await clearIndex(ctx, recordId);
	return logChange(ctx, { outsider: by }, { typeId: record.typeId, recordId, action: "archived", changes: [] });
}

/** Notes which records a chat message references, so each record can list where it was discussed. */
/** The records among `ids` the person can see, deduped. Others are dropped, not trusted. */
export async function workspaceRecords(ctx: QueryCtx, member: Member, ids: Id<"records">[]) {
	const visible = typeVisible(ctx, member);
	const out: Id<"records">[] = [];
	for (const id of new Set(ids)) {
		const record = await ctx.db.get(id);
		if (record?.workspaceId === member.workspaceId && (await visible(record.typeId))) out.push(id);
	}
	return out;
}

// ---- Fields and types ----

export type FieldInput = Omit<FieldConfig, "options" | "linkType"> & {
	options?: OptionInput[];
	linkTypeId?: Id<"recordTypes">;
};

type OptionInput = { id?: string; label: string; color?: string };

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
	checkPermission(who.member, "fields.edit");
	await requireType(ctx, who.member, typeId, "edit");
	const fields = await fieldsOf(ctx, typeId);
	if (fields.length >= FIELDS_PER_TYPE_MAX) throw new ConvexError(`A database holds up to ${FIELDS_PER_TYPE_MAX} fields.`);
	const { linkTypeId, ...rest } = input;
	// New options without a color get the palette in turn.
	const config = normalizeFieldConfig({ ...rest, linkType: linkTypeId, options: rest.options?.map((o, i) => ({ ...o, color: o.color ?? autoColor(i) })) });
	requireFieldConfig(config);
	requireUniqueLabel(fields, config.label);
	// Linking to a database shows its records' names here, so it takes seeing it.
	if (linkTypeId && (await requireType(ctx, who.member, linkTypeId)).archived) throw new ConvexError("This database is in Archive. Restore it to make changes.");
	const key = keyOf(config.label, fields.map((f) => f.key));
	await writeSources(ctx, who.member, typeId);
	const id = await insertField(ctx, who.member, typeId, { ...config, key }, Math.max(0, ...fields.map((f) => f.position)) + 1, linkTypeId);
	await logChange(ctx, who, { typeId, fieldId: id, action: "field.created", changes: [{ key: "label", new: config.label }, ...(config.icon ? [{ key: "icon", new: config.icon }] : [])] });
	return (await ctx.db.get(id))!;
}

export async function requireEditableField(ctx: QueryCtx, member: Member, fieldId: Id<"recordFields">) {
	const field = requireInWorkspace(member, await ctx.db.get(fieldId), "Field");
	await requireType(ctx, member, field.typeId, "edit");
	checkPermission(member, "fields.edit");
	return field;
}

/**
 * Renames a field, sets its icon (null: back to its kind's) or changes its options. Its kind is fixed:
 * values were checked against it. Options left out are retired, not deleted: records keep them, but
 * they can't be set again. Sending one back (by id, or the same label) brings it back.
 */
export async function updateField(
	ctx: MutationCtx,
	who: Who,
	fieldId: Id<"recordFields">,
	update: { label?: string; icon?: string | null; options?: OptionInput[]; position?: number },
) {
	const field = await requireEditableField(ctx, who.member, fieldId);
	if (field.archived) throw new ConvexError("This field is in Archive. Restore it to make changes.");
	if (field.change) throw new ConvexError(`“${field.label}” is still changing. Try again when it's done.`);
	if (update.label !== undefined || update.icon !== undefined || update.options !== undefined) await writeSources(ctx, who.member, field.typeId);
	let options = field.options;
	if (update.options) {
		const existing = field.options ?? [];
		const ids = existing.map((e) => e.id);
		let added = existing.length;
		const active = update.options.map((o) => {
			const id = o.id || existing.find((e) => e.label.toLowerCase() === o.label.trim().toLowerCase())?.id || keyOf(o.label, ids);
			ids.push(id);
			const before = existing.find((e) => e.id === id);
			// A missing color keeps the option's own; only a new option gets the next in turn.
			// COMPAT(0.1.0-alpha.10): those apps send every option without one, so this is what keeps their saves from
			// wiping colors. Agents' plain-label options and the API rely on it too, so once they're gone only this note goes.
			const color = o.color ?? (before ? before.color : autoColor(added++));
			return { id, label: o.label, ...(color && { color }) };
		});
		const kept = new Set(active.map((o) => o.id));
		options = [...active, ...existing.filter((e) => !kept.has(e.id)).map((e) => ({ ...e, retired: true }))];
	}
	const icon = update.icon === undefined ? field.icon : (update.icon ?? undefined);
	const config = normalizeFieldConfig({ ...toField(field), label: update.label ?? field.label, icon, options });
	requireFieldConfig(config);
	requireUniqueLabel(await fieldsOf(ctx, field.typeId), config.label, fieldId);
	const changes: Change[] = [];
	let reordered: Doc<"recordFields">[] | undefined;
	if (update.position !== undefined) {
		checkPermission(who.member, "fields.edit");
		const fields = (await fieldsOf(ctx, field.typeId)).filter((f) => !f.archived);
		if (field.key === NAME_KEY || !Number.isInteger(update.position) || update.position < 1 || update.position >= fields.length)
			throw new ConvexError("Choose a field position after Name within the live fields.");
		const old = fields.findIndex((f) => f._id === fieldId);
		if (old !== update.position) {
			reordered = fields.filter((f) => f._id !== fieldId);
			reordered.splice(update.position, 0, field);
			changes.push({ key: "position", old, new: update.position });
		}
	}
	if (config.label !== field.label) changes.push({ key: "label", old: field.label, new: config.label });
	if (config.icon !== field.icon) changes.push({ key: "icon", ...(field.icon && { old: field.icon }), ...(config.icon && { new: config.icon }) });
	const labels = (options?: { label: string; retired?: boolean }[]) => options?.filter((o) => !o.retired).map((o) => o.label) ?? [];
	if (!sameValue(labels(field.options), labels(config.options)))
		changes.push({ key: "options", old: labels(field.options), new: labels(config.options) });
	// Recolored options, as "Won: green", the way a rename is "options".
	const recolored = (config.options ?? []).filter((o) => {
		const before = field.options?.find((e) => e.id === o.id);
		return !o.retired && before && (before.color ?? "default") !== (o.color ?? "default");
	});
	if (recolored.length) {
		const colorOf = (o: { label: string; color?: string }) => `${o.label}: ${o.color ?? "default"}`;
		changes.push({ key: "colors", old: recolored.map((o) => colorOf(field.options!.find((e) => e.id === o.id)!)), new: recolored.map(colorOf) });
	}
	if (changes.length === 0) return;
	if (reordered) for (const [position, f] of reordered.entries()) await ctx.db.patch(f._id, { position });
	await ctx.db.patch(fieldId, { label: config.label, icon: config.icon, ...(config.options && { options: config.options }), updatedAt: Date.now() });
	await logChange(ctx, who, { typeId: field.typeId, fieldId, action: "field.updated", changes });
}

/** A field in Archive keeps its values on every record, so restoring it brings them back. */
export async function setFieldTrashed(ctx: MutationCtx, who: Who, fieldId: Id<"recordFields">, archived: boolean) {
	const field = archived
		? await requireEditableField(ctx, who.member, fieldId)
		: requireInWorkspace(who.member, await ctx.db.get(fieldId), "Field");
	if (field.key === NAME_KEY) throw new ConvexError("Every record needs a name, so this field stays.");
	if (field.archived === archived) return;
	if (field.change) throw new ConvexError(`“${field.label}” is still changing. Try again when it's done.`);
	if (!archived) {
		await requireType(ctx, who.member, field.typeId, "edit");
		requireUniqueLabel(await fieldsOf(ctx, field.typeId), field.label, fieldId);
	}
	await toggleTrash(ctx, who, archived, { kind: "field", id: fieldId, name: field.label, typeId: field.typeId });
	await ctx.db.patch(fieldId, { archived, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId: field.typeId, fieldId, action: archived ? "field.archived" : "field.restored", changes: [] });
}

const TYPES_MAX = 32;

/** Trimmed names, unique among live databases. The singular defaults to a guess from the plural. */
function databaseNames(plural: string, singular: string | undefined, types: Doc<"recordTypes">[], except?: Id<"recordTypes">) {
	const names = { name: (singular ?? singularOf(plural.trim())).trim(), plural: plural.trim() };
	if (!names.name || !names.plural || names.name.length > 120 || names.plural.length > 120) throw new ConvexError("Give the database a name, up to 120 characters.");
	// Say which name clashes, and with which database: a shared singular ("Poker hand") isn't the plural asked for.
	for (const t of types) {
		if (t._id === except || t.archived) continue;
		const same = (n: string) => [names.name, names.plural].some((m) => n.toLowerCase() === m.toLowerCase());
		if (same(t.plural)) throw new ConvexError(`There's already a database called “${t.plural}”.`);
		if (same(t.name)) throw new ConvexError(`“${t.plural}” already uses “${t.name}” as its name for one entry. Give this database a different one.`);
	}
	return names;
}

/** A new database with just a name field. */
export async function createType(ctx: MutationCtx, who: Who, input: { plural: string; name?: string }) {
	checkPermission(who.member, "fields.edit");
	await writeSources(ctx, who.member);
	const types = await typesOf(ctx, who.member.workspaceId);
	if (types.length >= TYPES_MAX) throw new ConvexError(`A workspace holds up to ${TYPES_MAX} databases, including ones in Archive.`);
	const names = databaseNames(input.plural, input.name, types);
	const typeId = await insertType(ctx, who.member, { key: keyOf(names.name, [...types.map((t) => t.key), "campaign"]), ...names });
	await insertField(ctx, who.member, typeId, { key: NAME_KEY, label: "Name", kind: "text" }, 0);
	await logChange(ctx, who, { typeId, action: "database.created", changes: Object.entries(names).map(([key, value]) => ({ key, new: value })) });
	return typeId;
}

/** Rename. A new plural alone re-guesses the singular. */
export async function updateType(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: { name?: string; plural?: string; version: number }) {
	checkPermission(who.member, "fields.edit");
	const type = await requireType(ctx, who.member, typeId, "edit");
	checkVersion(type.version ?? 0, input.version);
	await writeSources(ctx, who.member, typeId);
	const names = databaseNames(input.plural ?? type.plural, input.name ?? (input.plural === undefined ? type.name : undefined), await typesOf(ctx, who.member.workspaceId), typeId);
	const changes = (["name", "plural"] as const).filter((key) => type[key] !== names[key]).map((key) => ({ key, old: type[key], new: names[key] }));
	if (!changes.length) return;
	await ctx.db.patch(typeId, { ...names, version: (type.version ?? 0) + 1, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId, action: "database.updated", changes });
}

/** Moves a database to Archive, with its records, fields and views, or brings it back if its names are free. */
export async function setTypeTrashed(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, archived: boolean) {
	if (archived) checkPermission(who.member, "fields.edit");
	const type = await requireType(ctx, who.member, typeId);
	// Archiving or restoring changes it for everyone who sees it, so it takes Edit in it.
	requireAccess(who.member, "database", type.plural, type.access, "edit");
	if (type.archived === archived) return;
	if (!archived) databaseNames(type.plural, type.name, await typesOf(ctx, who.member.workspaceId), typeId);
	await toggleTrash(ctx, who, archived, { kind: "database", id: typeId, name: type.plural });
	await ctx.db.patch(typeId, { archived, version: (type.version ?? 0) + 1, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId, action: archived ? "database.archived" : "database.restored", changes: [] });
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
	{ linkType: _linkType, ...field }: Field,
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

// ---- Display ----

/**
 * A person's or record's name, for a user or link value. `archived`: the record is in Archive, or
 * deleted for good. `locked`: a record in a database the person can't see; its name stays hidden.
 */
export type Ref = { name: string; archived?: true; locked?: true };

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
export async function resolveRefs(ctx: QueryCtx, member: Member, ids: Iterable<string>) {
	const { workspaceId } = member;
	const visible = typeVisible(ctx, member);
	const refs: Record<string, Ref> = {};
	const unresolved: string[] = [];
	let count = 0;
	let bytes = 0;
	const trashed = typeTrashed(ctx);
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
			// Every record read counts against the budget, including ones refused below.
			if (record) bytes += getDocumentSize(record);
			// Deleted for good: its links stay stored, like ones to a record in Archive.
			if (!record) refs[id] = { name: "Deleted record", archived: true };
			if (record?.workspaceId !== workspaceId) continue;
			// A link into a database they can't see shows as a locked chip, without the record's name.
			if (!(await visible(record.typeId))) {
				refs[id] = { name: "", locked: true };
				continue;
			}
			refs[id] = { name: record.title, ...((record.archived || (await trashed(record.typeId))) && { archived: true }) };
		} else if (userId) {
			refs[id] = { name: (await memberOf(ctx, userId, workspaceId)) ? await nameOf(ctx, userId) : "Former member" };
		}
	}
	return { refs, unresolved };
}

/**
 * A record's values as its fields read now. While a field's kind is changing (fieldChanges.ts), records the
 * change hasn't reached yet are converted here by the same rules, without lookups: a value that needs one
 * (a teammate or record by name, a name for text) reads as empty until the change gets to it. So every app,
 * older ones too, gets values that fit the field's kind.
 * COMPAT(0.1.0-alpha.10): released apps render each cell by the field's kind (an amount cell given text throws),
 * so they must never see a value in the old shape.
 */
export async function shownValues(ctx: QueryCtx, record: Doc<"records">, fields: Doc<"recordFields">[], jobs: (id: Id<"fieldChanges">) => Promise<Doc<"fieldChanges"> | null>) {
	let values = record.values;
	for (const field of fields) {
		if (!field.change || values[field.key] === undefined) continue;
		const job = await jobs(field.change);
		if (!job || record._creationTime <= job.doneThrough) continue;
		const options = field.options?.filter((o) => !o.retired) ?? [];
		const result = convertValue(asField(field, job.from), toField(field), values[field.key]!, {
			currency: await currencyOf(ctx, record.workspaceId),
			option: (label) => options.find((o) => o.label.toLowerCase() === label.toLowerCase())?.id ?? null,
		});
		values = { ...values };
		if ("unknown" in result || result.value === null) delete values[field.key];
		else values[field.key] = result.value;
	}
	return values;
}

/** Records, display-ready, with the names their values point at resolved once for all of them. */
export async function toRows(ctx: QueryCtx, member: Member, rawItems: { record: Doc<"records">; fields: Doc<"recordFields">[] }[]) {
	const jobs = memo((id: Id<"fieldChanges">) => ctx.db.get(id));
	const items = await Promise.all(rawItems.map(async ({ record, fields }) => ({ record: { ...record, values: await shownValues(ctx, record, fields, jobs) }, fields })));
	const idsOf = items.map(({ record, fields }) => idsIn(fields, record.values));
	const { refs, unresolved } = await resolveRefs(ctx, member, idsOf.flat());
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
