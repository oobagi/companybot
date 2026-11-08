import {
	type ChangeCounts,
	type ChoiceOption,
	type Condition,
	type Converted,
	type ConvertContext,
	type Field,
	type FieldShape,
	type FieldValue,
	NAME_KEY,
	addCounts,
	convertCondition,
	convertValue,
	countChange,
	describeChange,
	emptyCounts,
	fieldConfigError,
	groupsBy,
	indexEntries,
	kindLabels,
	normalizeFieldConfig,
	optionMaker,
	sameValue,
	searchTextOf,
	shapeChanged,
	sortsBy,
	valuesBytes,
	RECORD_MAX_BYTES,
} from "@companybot/core";
import { ConvexError, getDocumentSize, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { type Member, type Who, memberOf, nameOf } from "./lib";
import { currencyOf, fieldsOf, logChange, requireEditableField, requireType, toField, writeIndex } from "./recordOps";
import { writeSources } from "./replySources";

// Changing a field's kind, one/several or linked database after it's made (wiki/data.md → Changing a
// field). The rules are core's (field-change.ts); this runs them over every record in the background,
// a batch per scheduled run, keeps each changed record's old value so the change can be undone, and
// rebuilds the field's index rows. While it runs the field is locked (`recordFields.change`) and reads
// show records not reached yet converted on the fly (recordOps `shownValues`), so apps, old ones too,
// always get values that fit the field's kind.

/** Records per run, and what they may read (half of Convex's 16 MiB: each record is also written, with its kept value). */
const BATCH = 100;
const BATCH_BYTES = 4 * 1024 * 1024;
/** Records sharing the last one's creation time are taken with it (imports), up to this many more. */
const TIES_MAX = 200;
/** How long a change's old values are kept, so it can be undone. */
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Records the preview converts, and the most it reads doing so. */
const SAMPLE = 500;
const SAMPLE_BYTES = 4 * 1024 * 1024;
/** Teammates read to match names (→ Person). */
const TEAM_MAX = 1000;
/** A change untouched this long has stopped (a run failed); the cron starts it again. */
const STALLED_MS = 10 * 60_000;

/** What someone asks a field to become. Options only matter for → Choice: they're kept, then values add theirs. */
export type ShapeInput = { kind: Field["kind"]; multiple?: boolean; linkTypeId?: Id<"recordTypes">; options?: { id?: string; label: string }[] };

type Shape = Doc<"fieldChanges">["from"];

export const shapeOf = (f: Doc<"recordFields"> | Shape): Shape => ({
	kind: f.kind,
	...(f.options && { options: f.options }),
	...(f.linkTypeId && { linkTypeId: f.linkTypeId }),
	...(f.multiple && { multiple: true }),
});

/** core's Field for a shape, under the field's key and label. */
export const asField = (field: Doc<"recordFields">, shape: Shape): Field => ({
	key: field.key,
	label: field.label,
	kind: shape.kind,
	...(shape.options && { options: shape.options }),
	...(shape.linkTypeId && { linkType: shape.linkTypeId }),
	...(shape.multiple && { multiple: true }),
});

const coreShape = (s: Shape): FieldShape => ({ kind: s.kind, options: s.options, linkType: s.linkTypeId, multiple: s.multiple });

/**
 * Converts many values with lookups done once for all of them: a first pass notes the names, teammates
 * and records it needs, they're read, and a second pass converts the rest.
 */
async function converter(ctx: QueryCtx, workspaceId: Id<"workspaces">, field: Doc<"recordFields">, from: Shape, to: Shape, option?: (label: string) => string | null) {
	const names = new Map<string, string>();
	const people = new Map<string, string | null>();
	const records = new Map<string, string | null>();
	const wanted = { names: new Set<string>(), people: new Set<string>(), records: new Set<string>() };
	const ask = <T>(map: Map<string, T>, set: Set<string>, key: string) => (map.has(key) ? map.get(key) : (set.add(key), undefined));
	const context: ConvertContext = {
		currency: await currencyOf(ctx, workspaceId),
		option,
		name: (id) => ask(names, wanted.names, id),
		person: (text) => ask(people, wanted.people, text.toLowerCase()),
		record: (text) => ask(records, wanted.records, text.toLowerCase()),
	};
	const fromField = asField(field, from);
	const toField_ = asField(field, to);
	let team: Map<string, string | null> | undefined;
	async function lookUp() {
		for (const id of wanted.names) names.set(id, await nameFor(ctx, workspaceId, id));
		if (wanted.people.size && !team) team = await teamByName(ctx, workspaceId);
		for (const text of wanted.people) people.set(text, team!.get(text) ?? null);
		for (const text of wanted.records) records.set(text, to.linkTypeId ? await recordNamed(ctx, to.linkTypeId, text) : null);
		for (const set of Object.values(wanted)) set.clear();
	}
	return async (values: FieldValue[]) => {
		const out: Converted[] = values.map((v) => convertValue(fromField, toField_, v, context));
		if (out.some((r) => "unknown" in r)) {
			await lookUp();
			for (const [i, r] of out.entries()) if ("unknown" in r) out[i] = convertValue(fromField, toField_, values[i]!, context);
		}
		// Every lookup has been done; anything still unknown can't be matched.
		return out.map((r) => ("unknown" in r ? { value: null, lost: [] } : r));
	};
}

/** A teammate's or record's name, for a value becoming text. Records deleted for good, and people who left, have none. */
async function nameFor(ctx: QueryCtx, workspaceId: Id<"workspaces">, id: string) {
	const recordId = ctx.db.normalizeId("records", id);
	if (recordId) {
		const record = await ctx.db.get(recordId);
		return record?.workspaceId === workspaceId ? record.title : "";
	}
	const userId = ctx.db.normalizeId("users", id);
	return userId && (await memberOf(ctx, userId, workspaceId)) ? nameOf(ctx, userId) : "";
}

/** Teammates by lowercase name and email. A name two people share matches neither. */
async function teamByName(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const map = new Map<string, string | null>();
	const add = (key: string | undefined, userId: string) => {
		if (!key) return;
		const k = key.trim().toLowerCase();
		map.set(k, map.has(k) && map.get(k) !== userId ? null : userId);
	};
	const members = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(TEAM_MAX);
	for (const m of members) {
		add(m.email, m.userId);
		// COMPAT(0.1.0-alpha.10): `name` is copied onto members by migrations.memberProfiles; until then, read the profile.
		add(m.name ?? (await nameOf(ctx, m.userId)), m.userId);
	}
	return map;
}

/** The live record of a database named exactly this (any case), or null for none or several. */
async function recordNamed(ctx: QueryCtx, typeId: Id<"recordTypes">, lower: string) {
	const nameField = (await fieldsOf(ctx, typeId)).find((f) => f.key === NAME_KEY);
	if (!nameField) return null;
	const entry = indexEntries(toField(nameField), lower)[0] as { str: string };
	const rows = await ctx.db.query("recordValues").withIndex("by_field_str", (q) => q.eq("fieldId", nameField._id).eq("str", entry.str)).take(2);
	if (rows.length !== 1) return null;
	const record = await ctx.db.get(rows[0]!.recordId);
	return record && !record.archived && record.title.toLowerCase() === lower ? record._id : null;
}

/** The setup a field would have, checked like any field's: options for → Choice start from `typed`, then the field's own if it was one. */
async function targetShape(ctx: QueryCtx, member: Member, field: Doc<"recordFields">, input: ShapeInput): Promise<Shape> {
	if (field.key === NAME_KEY && input.kind !== "text") throw new ConvexError("Every record's name is text, so Name stays a text field.");
	const several = ["choice", "user", "link"].includes(input.kind) && !!input.multiple;
	const linkTypeId = input.kind === "link" ? input.linkTypeId : undefined;
	if (input.kind === "link") {
		if (!linkTypeId) throw new ConvexError("Pick the database this field links to.");
		// Linking shows that database's records here, so it takes seeing it.
		if ((await requireType(ctx, member, linkTypeId)).archived) throw new ConvexError("That database is in Archive. Restore it first.");
	}
	// Links becoming something else read the linked records' names into this database.
	if (field.kind === "link" && field.linkTypeId && field.linkTypeId !== linkTypeId && (await ctx.db.get(field.linkTypeId))) await requireType(ctx, member, field.linkTypeId);
	let options: ChoiceOption[] | undefined;
	if (input.kind === "choice") {
		const kept = field.kind === "choice" ? (field.options ?? []) : [];
		const maker = optionMaker(kept);
		for (const o of input.options ?? []) if (o.label.trim()) maker.option(o.label.trim());
		options = maker.options;
	}
	return { kind: input.kind, ...(options && { options }), ...(linkTypeId && { linkTypeId }), ...(several && { multiple: true }) };
}

/** The first live records with a value, converted as the change would: what the preview shows. */
async function sample(ctx: QueryCtx, member: Member, field: Doc<"recordFields">, to: Shape) {
	// Oldest first, so options come in the order records were added.
	const rows = ctx.db.query("recordValues").withIndex("by_field_at", (q) => q.eq("fieldId", field._id));
	const values: FieldValue[] = [];
	const seen = new Set<string>();
	let bytes = 0;
	let more = false;
	for await (const row of rows) {
		if (seen.has(row.recordId)) continue;
		if (values.length >= SAMPLE || bytes >= SAMPLE_BYTES) {
			more = true;
			break;
		}
		seen.add(row.recordId);
		const record = await ctx.db.get(row.recordId);
		if (!record) continue;
		bytes += getDocumentSize(record);
		const value = record.values[field.key];
		if (value !== undefined) values.push(value);
	}
	const maker = to.kind === "choice" ? optionMaker(to.options) : undefined;
	const convert = await converter(ctx, member.workspaceId, field, shapeOf(field), to, maker?.option);
	const counts = emptyCounts();
	for (const result of await convert(values)) countChange(counts, result);
	return { counts, more, made: maker?.made ?? [], options: maker?.options };
}

/** Saved views of a database whose filters, sort or grouping on this field stop fitting, and what they'd become. */
async function viewsAffected(ctx: QueryCtx, field: Doc<"recordFields">, from: Shape, to: Shape) {
	const views = await ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", field.typeId)).take(50);
	const out: { view: Doc<"databaseViews">; filters: Condition[]; sort: boolean; group: boolean; dropped: boolean }[] = [];
	for (const view of views) {
		const converted = view.filters.map((c) => (c.field === field.key ? convertCondition(coreShape(from), coreShape(to), c) : c));
		const filters = converted.filter((c) => c !== null);
		const sort = view.sort?.field === field.key && !sortsBy(coreShape(to));
		const group = view.groupBy === field.key && !groupsBy(coreShape(to));
		const changed = converted.some((c, i) => c !== view.filters[i]);
		if (changed || sort || group) out.push({ view, filters, sort, group, dropped: filters.length !== view.filters.length });
	}
	return out;
}

export type ChangePreview = Awaited<ReturnType<typeof previewChange>>;

/**
 * What changing a field would do, before anything changes: values that convert, ones cleared (with a
 * few), options it makes, and views whose filters stop fitting. Counts come from the first SAMPLE
 * records with a value; `more` says there are others, which convert by the same rules.
 */
export async function previewChange(ctx: QueryCtx, member: Member, fieldId: Id<"recordFields">, input: ShapeInput) {
	const field = await requireChangeable(ctx, member, fieldId);
	const to = await targetShape(ctx, member, field, input);
	if (!shapeChanged(coreShape(shapeOf(field)), coreShape(to))) return null;
	const { counts, more, made, options } = await sample(ctx, member, field, to);
	// Views that lose something; a filter that converts to an option it makes doesn't count.
	const views = (await viewsAffected(ctx, field, shapeOf(field), to.kind === "choice" ? { ...to, options } : to)).filter((v) => v.dropped || v.sort || v.group);
	return { ...counts, more, options: made, views: views.map((v) => v.view.name), change: await describe(ctx, shapeOf(field), to) };
}

async function requireChangeable(ctx: QueryCtx, member: Member, fieldId: Id<"recordFields">) {
	const field = await requireEditableField(ctx, member, fieldId);
	if (field.archived) throw new ConvexError("This field is in Archive. Restore it to make changes.");
	if (field.change) throw new ConvexError(`“${field.label}” is still changing. Try again when it's done.`);
	return field;
}

/** "Text → Choice", with databases by name. */
async function describe(ctx: QueryCtx, from: Shape, to: Shape) {
	const names = new Map<string, string>();
	for (const id of [from.linkTypeId, to.linkTypeId]) if (id) names.set(id, (await ctx.db.get(id))?.plural ?? "a deleted database");
	return describeChange(coreShape(from), coreShape(to), (k) => kindLabels[k], (id) => names.get(id) ?? id);
}

/** History's lines for a change, as people read them (the change itself keeps the exact setups). */
async function historyLines(ctx: QueryCtx, from: Shape, to: Shape) {
	const lines: { key: string; old?: string; new?: string }[] = [];
	if (from.kind !== to.kind) lines.push({ key: "kind", old: kindLabels[from.kind], new: kindLabels[to.kind] });
	if (!!from.multiple !== !!to.multiple) lines.push({ key: "multiple", old: from.multiple ? "Several" : "One", new: to.multiple ? "Several" : "One" });
	if ((from.linkTypeId ?? null) !== (to.linkTypeId ?? null)) {
		const name = async (id?: Id<"recordTypes">) => (id ? ((await ctx.db.get(id))?.plural ?? "A deleted database") : undefined);
		lines.push({ key: "linkType", old: await name(from.linkTypeId), new: await name(to.linkTypeId) });
	}
	return lines;
}

/**
 * Starts changing a field's kind, one/several or linked database. The field takes its new setup at once
 * and is locked while every record converts in the background; saved views drop filters, sorts and
 * grouping that stop fitting, and say so. Returns the change, with the preview's counts.
 */
export async function changeField(ctx: MutationCtx, who: Who, fieldId: Id<"recordFields">, input: ShapeInput) {
	const field = await requireChangeable(ctx, who.member, fieldId);
	const from = shapeOf(field);
	let to = await targetShape(ctx, who.member, field, input);
	if (!shapeChanged(coreShape(from), coreShape(to))) throw new ConvexError("That's the setup it has already.");
	const preview = await sample(ctx, who.member, field, to);
	// → Choice starts with the options its newest values make; the rest add theirs as they convert.
	if (to.kind === "choice") to = { ...to, options: preview.options };
	const error = fieldConfigError(normalizeFieldConfig({ ...asField(field, to), options: to.options }));
	if (error) throw new ConvexError(to.kind === "choice" && !to.options?.length ? "There are no values to make options from. Add at least one option." : error);
	await writeSources(ctx, who.member, field.typeId);
	return startChange(ctx, who, field, from, to, preview.counts);
}

async function startChange(ctx: MutationCtx, who: Who, field: Doc<"recordFields">, from: Shape, to: Shape, preview: ChangeCounts, undoes?: Doc<"fieldChanges">) {
	await tidyViews(ctx, field, from, to);
	const now = Date.now();
	const id = await ctx.db.insert("fieldChanges", {
		workspaceId: field.workspaceId,
		typeId: field.typeId,
		fieldId: field._id,
		from,
		to,
		...(undoes && { undoes: undoes._id }),
		status: "running",
		doneThrough: 0,
		counts: emptyCounts(),
		userId: who.member.userId,
		...(who.agentId && { agentId: who.agentId }),
		updatedAt: now,
	});
	const historyId = await logChange(ctx, who, {
		typeId: field.typeId,
		fieldId: field._id,
		action: "field.updated",
		changes: await historyLines(ctx, from, to),
		...(undoes?.historyId && { undoes: undoes.historyId }),
	});
	if (undoes) {
		await ctx.db.patch(undoes._id, { undoneBy: id });
		if (undoes.historyId) await ctx.db.patch(undoes.historyId, { undoneBy: historyId });
	}
	await ctx.db.patch(field._id, {
		kind: to.kind,
		options: to.options,
		linkTypeId: to.linkTypeId,
		multiple: to.multiple,
		change: id,
		updatedAt: now,
	});
	await ctx.db.patch(id, { historyId, run: await ctx.scheduler.runAfter(0, internal.fieldChanges.step, { id }) });
	return { changeId: id, historyId, change: await describe(ctx, from, to), preview };
}

/** Drops what stops fitting from saved views and the All tab's grouping, and has each view say why. */
async function tidyViews(ctx: MutationCtx, field: Doc<"recordFields">, from: Shape, to: Shape) {
	const what = await describe(ctx, from, to);
	for (const { view, filters, sort, group, dropped: droppedFilter } of await viewsAffected(ctx, field, from, to)) {
		const dropped = [droppedFilter && "filter", sort && "sort", group && "grouping"].filter(Boolean).join(" and ");
		// A filter that converted (text "is X" → the option X) needs no note.
		await ctx.db.patch(view._id, {
			filters,
			...(sort && { sort: undefined }),
			...(group && { groupBy: undefined }),
			version: view.version + 1,
			...(dropped && { notice: `“${field.label}” changed (${what}), so its ${dropped} ${dropped.includes(" and ") ? "were" : "was"} removed.` }),
		});
	}
	const type = await ctx.db.get(field.typeId);
	if (type?.display?.groupBy === field.key && !groupsBy(coreShape(to))) await ctx.db.patch(type._id, { display: { ...type.display, groupBy: undefined } });
}

/**
 * Undoes a change: the field takes its old setup and every record its old value, where it hasn't changed
 * since; values changed since convert back by the same rules. Only the field's latest change can be
 * undone (then the one before it), within KEEP_MS.
 */
export async function undoFieldChange(ctx: MutationCtx, who: Who, historyId: Id<"recordHistory">) {
	const job = await ctx.db.query("fieldChanges").withIndex("by_history", (q) => q.eq("historyId", historyId)).first();
	if (!job || job.undoes) throw new ConvexError("Only a change to a field's kind, one/several or linked database can be undone.");
	const field = await requireChangeable(ctx, who.member, job.fieldId);
	if (job.undoneBy) throw new ConvexError("That change was already undone.");
	if (job.forgotten || !job.keepUntil || job.keepUntil < Date.now()) throw new ConvexError("That change is too old to undo: its old values are kept for 30 days.");
	const later = await ctx.db.query("fieldChanges").withIndex("by_field", (q) => q.eq("fieldId", field._id)).order("desc").take(50);
	if (later.some((c) => c._creationTime > job._creationTime && !c.undoes && !c.undoneBy)) throw new ConvexError("Undo the later change to this field first.");
	const now = shapeOf(field);
	// Options stay as they are now when it was a choice before and still is (renames kept); else the old ones come back.
	const back: Shape = { ...job.from, ...(job.from.kind === "choice" && now.kind === "choice" && { options: mergeOptions(job.from.options ?? [], now.options ?? []) }) };
	if (back.linkTypeId) {
		const target = await ctx.db.get(back.linkTypeId);
		if (!target) throw new ConvexError("The database it linked to was deleted, so this can't be undone.");
		if (target.archived) throw new ConvexError(`${target.plural} is in Archive. Restore it first.`);
		await requireType(ctx, who.member, back.linkTypeId);
	}
	await writeSources(ctx, who.member, field.typeId);
	return startChange(ctx, who, field, now, back, emptyCounts(), job);
}

/** The old options, renamed as they are now, then any added since. */
function mergeOptions(old: ChoiceOption[], now: ChoiceOption[]) {
	const byId = new Map(now.map((o) => [o.id, o]));
	return [...old.map((o) => byId.get(o.id) ?? o), ...now.filter((o) => !old.some((p) => p.id === o.id))];
}

/** One batch of records, oldest first, then the next run. The last one unlocks the field. */
export const step = internalMutation({
	args: { id: v.id("fieldChanges") },
	handler: async (ctx, { id }) => {
		const job = await ctx.db.get(id);
		if (!job || job.status !== "running") return;
		const field = await ctx.db.get(job.fieldId);
		// Deleted for good meanwhile: its cascade deletes this change too.
		if (!field || field.change !== id) return;
		const records = await ctx.db
			.query("records")
			.withIndex("by_type_created", (q) => q.eq("typeId", job.typeId).gt("_creationTime", job.doneThrough))
			.take(BATCH);
		let batch = records;
		let bytes = 0;
		for (const [i, r] of records.entries()) {
			bytes += getDocumentSize(r);
			if (bytes > BATCH_BYTES && i > 0) {
				batch = records.slice(0, i);
				break;
			}
		}
		const last = batch.at(-1);
		// More may follow: this is the last batch only if it took every record left.
		const more = batch.length < records.length || records.length === BATCH;
		// Records sharing the last one's creation time go in this batch, so "converted through" is exact.
		if (last && more) {
			const ties = await ctx.db.query("records").withIndex("by_type_created", (q) => q.eq("typeId", job.typeId).eq("_creationTime", last._creationTime)).take(TIES_MAX);
			batch = [...batch, ...ties.filter((t) => !batch.some((b) => b._id === t._id))];
		}
		const maker = job.to.kind === "choice" ? optionMaker(field.options) : undefined;
		const convert = await converter(ctx, job.workspaceId, field, job.from, job.to, maker?.option);
		const fields = await fieldsOf(ctx, job.typeId);
		const shown = fields.map((f) => (f._id === field._id ? { ...f, ...job.to, options: maker?.options ?? job.to.options } : f));
		const withValue = batch.filter((r) => r.values[field.key] !== undefined);
		// An undo puts back what was there, where the record hasn't changed since.
		const kept = new Map<Id<"records">, Doc<"fieldChangeValues">>();
		if (job.undoes)
			for (const r of batch) {
				const row = await ctx.db.query("fieldChangeValues").withIndex("by_change", (q) => q.eq("changeId", job.undoes!).eq("recordId", r._id)).first();
				if (row) kept.set(r._id, row);
			}
		const restored = (r: Doc<"records">) => {
			const row = kept.get(r._id);
			return row && sameValue(r.values[field.key], row.new) ? row : undefined;
		};
		const converted = await convert(withValue.filter((r) => !restored(r)).map((r) => r.values[field.key]!));
		const counts = emptyCounts();
		let next = 0;
		for (const record of batch) {
			const old = record.values[field.key];
			const row = restored(record);
			let value: FieldValue | null;
			if (row) value = row.old ?? null;
			else if (old === undefined) continue;
			else {
				const result = converted[next++]!;
				countChange(counts, result);
				value = result.value;
			}
			const values = { ...record.values };
			if (value === null) delete values[field.key];
			else values[field.key] = value;
			// A value that would make the record too big doesn't fit either.
			if (value !== null && valuesBytes(values) > RECORD_MAX_BYTES) delete values[field.key];
			const changed = !sameValue(old, values[field.key]);
			if (changed) {
				await ctx.db.patch(record._id, { values, searchText: searchTextOf(shown.map(toField), values) });
				if (!job.undoes) await ctx.db.insert("fieldChangeValues", { changeId: id, recordId: record._id, ...(old !== undefined && { old }), ...(values[field.key] !== undefined && { new: values[field.key] }) });
			}
			// Records in Archive have no index rows; they're rebuilt from the field when one is restored.
			if (!record.archived) await writeIndex(ctx, { ...record, values }, shown, new Set([field.key]));
		}
		if (maker?.made.length) await ctx.db.patch(field._id, { options: maker.options });
		const total = addCounts(job.counts, counts);
		if (!last || !more) {
			const now = Date.now();
			await ctx.db.patch(field._id, { change: undefined, updatedAt: now });
			await ctx.db.patch(id, { status: "done", counts: total, doneThrough: last?._creationTime ?? job.doneThrough, finishedAt: now, run: undefined, updatedAt: now, ...(!job.undoes && { keepUntil: now + KEEP_MS }) });
			// An undo's change has nothing left to undo: its kept values go now.
			if (job.undoes) await ctx.scheduler.runAfter(0, internal.fieldChanges.forget, { id: job.undoes });
			return;
		}
		const run = await ctx.scheduler.runAfter(0, internal.fieldChanges.step, { id });
		await ctx.db.patch(id, { doneThrough: batch.at(-1)!._creationTime, counts: total, run, error: undefined, updatedAt: Date.now() });
	},
});

/** Deletes one change's kept values, a few thousand per run, then marks it forgotten (it can't be undone). */
export const forget = internalMutation({
	args: { id: v.id("fieldChanges") },
	handler: async (ctx, { id }) => {
		const rows = await ctx.db.query("fieldChangeValues").withIndex("by_change", (q) => q.eq("changeId", id)).take(1000);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length === 1000) return void (await ctx.scheduler.runAfter(0, internal.fieldChanges.forget, { id }));
		if (await ctx.db.get(id)) await ctx.db.patch(id, { forgotten: true, keepUntil: undefined });
	},
});

/**
 * Hourly (crons.ts): forgets changes kept past KEEP_MS, and starts again changes whose last run
 * failed. A failed run leaves its batch undone, so running it again is safe.
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = await ctx.db.query("fieldChanges").withIndex("by_keep", (q) => q.gt("keepUntil", 0).lt("keepUntil", Date.now())).take(20);
		for (const job of old) {
			await ctx.db.patch(job._id, { keepUntil: undefined });
			await ctx.scheduler.runAfter(0, internal.fieldChanges.forget, { id: job._id });
		}
		const stalled = await ctx.db.query("fieldChanges").withIndex("by_status", (q) => q.eq("status", "running").lt("updatedAt", Date.now() - STALLED_MS)).take(50);
		for (const job of stalled) {
			const run = job.run && (await ctx.db.system.get(job.run));
			if (run?.state.kind === "pending" || run?.state.kind === "inProgress") continue;
			const error = run?.state.kind === "failed" ? (run.state.error ?? "Failed.") : "Its last run stopped without an error.";
			console.error(`Field change ${job._id} stopped: ${error}. Starting it again.`);
			await ctx.db.patch(job._id, { error, updatedAt: Date.now(), run: await ctx.scheduler.runAfter(0, internal.fieldChanges.step, { id: job._id }) });
		}
	},
});

/**
 * A field's change in progress (records converted so far), and its latest one people can undo:
 * what it was, how many values it cleared, and whether undo is open (old values kept, nothing later).
 */
export async function changesOf(ctx: QueryCtx, field: Doc<"recordFields">) {
	const recent = await ctx.db.query("fieldChanges").withIndex("by_field", (q) => q.eq("fieldId", field._id)).order("desc").take(20);
	const running = field.change ? recent.find((c) => c._id === field.change) : undefined;
	const last = recent.find((c) => !c.undoes && !c.undoneBy);
	return {
		running: running ? { converted: running.counts.checked, undoing: !!running.undoes } : null,
		last: last?.historyId
			? {
					historyId: last.historyId,
					change: await describe(ctx, last.from, last.to),
					at: last._creationTime,
					converted: last.counts.converted,
					cleared: last.counts.cleared,
					undoable: last.status === "done" && !last.forgotten && !!last.keepUntil && last.keepUntil > Date.now(),
				}
			: null,
	};
}
