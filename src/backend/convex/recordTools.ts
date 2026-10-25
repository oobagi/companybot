import {
	type FieldSaveInput,
	type RecordFindInput,
	type RecordPage,
	type RecordSaveInput,
	type RecordTypesResult,
	displayValues,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation, internalQuery } from "./_generated/server";
import { type Member, asToolResult, nameOf } from "./lib";
import {
	type Who,
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
import { type Condition, findRecords } from "./recordQuery";
import { runningTurn } from "./turns";

// Records tools (core's RecordStore), acting as the turn's person: their role, read fresh
// on every call by runningTurn, and history names both them and the agent. Everything
// goes through recordOps, like the app. Types, fields, teammates and linked records can be
// named the way people say them; ids work too. See wiki/data.md.

const PAGE_MAX = 50;
const SEARCH_MAX = 20;
/** Records that link here, and recent changes, shown by records_get. */
const LINKED_MAX = 10;
const CHANGES_MAX = 5;

async function acting(ctx: QueryCtx, turnId: Id<"agentTurns">) {
	const { turn, member } = await runningTurn(ctx, turnId);
	return { member, who: { member, agentId: turn.agentId } satisfies Who };
}

const liveTypes = async (ctx: QueryCtx, member: Member) =>
	(await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived).sort((a, b) => a._creationTime - b._creationTime);

/** A type by key, name, plural or id ("deal", "Deals"). */
async function typeNamed(ctx: QueryCtx, member: Member, name: string) {
	const types = await liveTypes(ctx, member);
	const n = name.trim().toLowerCase();
	const type = types.find((t) => t._id === name || [t.key, t.name, t.plural].some((x) => x.toLowerCase() === n));
	if (!type) throw new ConvexError(`There's no record type “${name}”. Types: ${types.map((t) => t.key).join(", ")}.`);
	return type;
}

/** A live field by key or label. */
function fieldNamed(fields: Doc<"recordFields">[], name: string, type: Doc<"recordTypes">) {
	const n = name.trim().toLowerCase();
	const field = fields.find((f) => !f.archived && (f.key === n || f.label.toLowerCase() === n));
	if (!field) throw new ConvexError(`${type.plural} have no field “${name}”. records_types lists them.`);
	return field;
}

/** A teammate or linked record as people name them ("me", "Ana", "Acme Roofing"), as its id. Ids pass through. */
async function idFor(ctx: QueryCtx, member: Member, field: Doc<"recordFields">, raw: unknown) {
	if (typeof raw !== "string" || !raw.trim()) return raw;
	const text = raw.trim();
	const lower = text.toLowerCase();
	if (field.kind === "user") {
		if (ctx.db.normalizeId("users", text)) return text;
		if (lower === "me") return member.userId;
		const rows = await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		const team = await Promise.all(
			rows.map(async (m) => ({ id: m.userId, name: await nameOf(ctx, m.userId), email: (await ctx.db.get(m.userId))?.email ?? "" })),
		);
		const matches = team.filter((p) => p.name.toLowerCase() === lower || p.email.toLowerCase() === lower);
		if (matches.length === 1) return matches[0]!.id;
		throw new ConvexError(
			matches.length
				? `Several teammates are called “${text}”. Use their email.`
				: `No teammate “${text}”. Teammates: ${team.map((p) => p.name).join(", ")}.`,
		);
	}
	if (field.kind === "link" && field.linkTypeId) {
		if (ctx.db.normalizeId("records", text)) return text;
		const typeId = field.linkTypeId;
		const found = await ctx.db
			.query("records")
			.withSearchIndex("search", (q) =>
				q.search("searchText", text).eq("workspaceId", member.workspaceId).eq("archived", false).eq("typeId", typeId),
			)
			.take(SEARCH_MAX);
		const exact = found.filter((r) => r.title.toLowerCase() === lower);
		if (exact.length === 1) return exact[0]!._id;
		const type = (await ctx.db.get(typeId))!;
		if (exact.length > 1)
			throw new ConvexError(`Several ${type.plural.toLowerCase()} are named “${text}”. Use an id: ${exact.map((r) => r._id).join(", ")}.`);
		const close = found.slice(0, 5).map((r) => `${r.title} (${r._id})`);
		throw new ConvexError(`No ${type.name.toLowerCase()} named “${text}”.${close.length ? ` Close: ${close.join(", ")}.` : ""}`);
	}
	return raw;
}

const idsFor = (ctx: QueryCtx, member: Member, field: Doc<"recordFields">, raw: unknown) =>
	Array.isArray(raw) ? Promise.all(raw.map((x) => idFor(ctx, member, field, x))) : idFor(ctx, member, field, raw);

/** Values by field key or label → by key, with teammates and links named as ids. */
async function valuesFor(ctx: QueryCtx, member: Member, type: Doc<"recordTypes">, fields: Doc<"recordFields">[], values: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(values)) {
		const field = fieldNamed(fields, name, type);
		out[field.key] = await idsFor(ctx, member, field, raw);
	}
	return out;
}

/** Records as tools return them: id, then values as people read them. */
async function rowsOf(ctx: QueryCtx, member: Member, items: { record: Doc<"records">; fields: Doc<"recordFields">[] }[], withType?: Map<Id<"recordTypes">, string>) {
	const rows = await toRows(ctx, member.workspaceId, items);
	return rows.map((row, i) => ({
		...displayValues(items[i]!.fields.filter((f) => !f.archived).map(toField), row.values, row.refs),
		id: row._id,
		...(withType && { type: withType.get(row.typeId) ?? "" }),
	}));
}

async function recordOut(ctx: QueryCtx, member: Member, recordId: Id<"records">) {
	const record = (await ctx.db.get(recordId))!;
	const type = (await ctx.db.get(record.typeId))!;
	const [row] = await rowsOf(ctx, member, [{ record, fields: await fieldsOf(ctx, record.typeId) }]);
	const { id, ...values } = row!;
	return { id, type: type.key, name: record.title, ...(record.archived && { archived: true }), values };
}

export const typesFor = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }): Promise<RecordTypesResult> => {
		const { member } = await acting(ctx, turnId);
		const types = await liveTypes(ctx, member);
		const keys = new Map(types.map((t) => [t._id, t.key]));
		return {
			currency: await currencyOf(ctx, member.workspaceId),
			types: await Promise.all(
				types.map(async (t) => ({
					type: t.key,
					name: t.name,
					plural: t.plural,
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
		const { member } = await acting(ctx, turnId);
		const { type: typeName, search, filters = [], sort, archived = false, cursor, numItems } = input as RecordFindInput & { numItems: number };
		return asToolResult(async (): Promise<RecordPage> => {
			if (search?.trim()) {
				if (filters.length || sort || cursor || archived) throw new ConvexError("Search on its own, or list with filters and a sort instead.");
				const type = typeName ? await typeNamed(ctx, member, typeName) : null;
				const found = await ctx.db
					.query("records")
					.withSearchIndex("search", (q) => {
						const s = q.search("searchText", search).eq("workspaceId", member.workspaceId).eq("archived", false);
						return type ? s.eq("typeId", type._id) : s;
					})
					.take(Math.min(numItems, SEARCH_MAX));
				const fields = new Map<Id<"recordTypes">, Doc<"recordFields">[]>();
				for (const r of found) if (!fields.has(r.typeId)) fields.set(r.typeId, await fieldsOf(ctx, r.typeId));
				const keys = type ? undefined : new Map((await liveTypes(ctx, member)).map((t) => [t._id, t.key]));
				const rows = await rowsOf(ctx, member, found.map((record) => ({ record, fields: fields.get(record.typeId)! })), keys);
				return { type: type?.plural ?? "Records", rows, more: false };
			}
			if (!typeName) throw new ConvexError("Say which record type to list, or search.");
			const type = await typeNamed(ctx, member, typeName);
			const fields = await fieldsOf(ctx, type._id);
			const conditions: Condition[] = [];
			for (const { field: name, ...test } of filters) {
				const field = fieldNamed(fields, name, type);
				const c: Condition = { ...test, field: field.key };
				if (c.eq !== undefined) c.eq = await idFor(ctx, member, field, c.eq);
				if (c.in) c.in = await Promise.all(c.in.map((x) => idFor(ctx, member, field, x)));
				conditions.push(c);
			}
			const sortBy = sort && {
				field: ["createdAt", "updatedAt"].includes(sort.field) ? sort.field : fieldNamed(fields, sort.field, type).key,
				order: sort.order,
			};
			const result = await findRecords(ctx, {
				workspaceId: member.workspaceId,
				typeId: type._id,
				archived,
				fields,
				conditions,
				sort: sortBy,
				currency: await currencyOf(ctx, member.workspaceId),
				pageMax: PAGE_MAX,
				paginationOpts: { numItems: Math.min(Math.max(numItems, 1), PAGE_MAX), cursor: cursor ?? null },
			});
			const rows = await rowsOf(ctx, member, result.page.map((record) => ({ record, fields })));
			return { type: type.plural, rows, more: !result.isDone, ...(!result.isDone && { cursor: result.continueCursor }) };
		});
	},
});

export const getFor = internalQuery({
	args: { turnId: v.id("agentTurns"), id: v.string() },
	handler: async (ctx, { turnId, id }) => {
		const { member } = await acting(ctx, turnId);
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
			for (const ref of await ctx.db
				.query("recordValues")
				.withIndex("by_ref", (q) => q.eq("ref", recordId))
				.take(LINKED_MAX)) {
				const other = await ctx.db.get(ref.recordId);
				const via = await ctx.db.get(ref.fieldId);
				const type = other && (await ctx.db.get(other.typeId));
				if (other && !other.archived && type) linkedFrom.push({ id: other._id, type: type.key, name: other.title, via: via?.label ?? "" });
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
		const { member, who } = await acting(ctx, turnId);
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
					change = await updateRecord(ctx, who, recordId, await valuesFor(ctx, member, type, fields, values));
				} else throw new ConvexError("Nothing to change: give values, or archived.");
			} else {
				if (archived !== undefined) throw new ConvexError("Create the record first.");
				if (!typeName) throw new ConvexError("Say which record type to create.");
				const type = await typeNamed(ctx, member, typeName);
				const fields = await fieldsOf(ctx, type._id);
				recordId = await createRecord(ctx, who, type._id, await valuesFor(ctx, member, type, fields, values));
				change = (await ctx.db
					.query("recordHistory")
					.withIndex("by_record", (q) => q.eq("recordId", recordId))
					.order("desc")
					.first())!._id;
			}
			return { ...(await recordOut(ctx, member, recordId)), ...(change ? { change } : { unchanged: true }) };
		});
	},
});

export const undoFor = internalMutation({
	args: { turnId: v.id("agentTurns"), change: v.string() },
	handler: async (ctx, { turnId, change }) => {
		const { member, who } = await acting(ctx, turnId);
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
		const { member, who } = await acting(ctx, turnId);
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
