import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { getMember, requireMember } from "./lib";
import { changeField, changesOf, previewChange } from "./fieldChanges";
import { createField, toField, typeVisible, updateField } from "./recordOps";
import { fieldKind } from "./schema";

// Fields on databases. Adding, changing and deleting any of them takes `fields.edit` and Edit in the
// database; adding one gives no extra rights over it. Every setting can change later: a new kind, one ↔
// several or another linked database converts existing values in the background (fieldChanges.ts),
// and can be undone. See wiki/data.md.

// An option without a color gets the next in turn when it's new, and keeps its own when it isn't.
const options = v.array(v.object({ id: v.optional(v.string()), label: v.string(), color: v.optional(v.string()) }));

/** Adds a field ("Roof type" on clients). Returns it, with the `key` its values use. */
export const create = mutation({
	args: {
		typeId: v.id("recordTypes"),
		label: v.string(),
		kind: fieldKind,
		icon: v.optional(v.string()),
		options: v.optional(options),
		linkTypeId: v.optional(v.id("recordTypes")),
		multiple: v.optional(v.boolean()),
	},
	handler: async (ctx, { typeId, ...input }) => {
		const field = await createField(ctx, { member: await requireMember(ctx) }, typeId, input);
		return { _id: field._id, ...toField(field) };
	},
});

/**
 * Renames a field, sets its icon (null: back to the kind's), changes its options (send them all; keep
 * `id`s to keep values) or moves it. With a different `kind`, `multiple` or `linkTypeId` it also changes
 * its setup: values convert in the background (see `preview`), and `options` are the ones to start a new
 * choice field with. Returns the change, if one started.
 */
export const update = mutation({
	args: {
		fieldId: v.id("recordFields"),
		label: v.optional(v.string()),
		icon: v.optional(v.union(v.string(), v.null())),
		options: v.optional(options),
		position: v.optional(v.number()),
		kind: v.optional(fieldKind),
		multiple: v.optional(v.boolean()),
		linkTypeId: v.optional(v.id("recordTypes")),
	},
	handler: async (ctx, { fieldId, kind, multiple, linkTypeId, ...update }) => {
		const who = { member: await requireMember(ctx) };
		const field = await ctx.db.get(fieldId);
		if (!field) throw new ConvexError("Field not found.");
		// Partial field updates preserve settings the caller did not supply.
		const shape = { kind: kind ?? field.kind, multiple: multiple ?? !!field.multiple, linkTypeId: linkTypeId ?? field.linkTypeId };
		const changes = shape.kind !== field.kind || shape.multiple !== !!field.multiple || (shape.kind === "link" && shape.linkTypeId !== field.linkTypeId);
		if (!changes) return void (await updateField(ctx, who, fieldId, update));
		// Renaming, the icon and reordering go first; options belong to the new setup.
		const { options: typed, ...rest } = update;
		if (field.kind === "choice" && shape.kind === "choice" && typed) await updateField(ctx, who, fieldId, update);
		else if (rest.label !== undefined || rest.icon !== undefined || rest.position !== undefined) await updateField(ctx, who, fieldId, rest);
		const started = await changeField(ctx, who, fieldId, { ...shape, options: shape.kind === "choice" && field.kind !== "choice" ? typed : undefined });
		return { changeId: started.changeId, change: started.change };
	},
});

/**
 * What changing a field's kind, one/several or linked database would do: how many values convert,
 * how many would be cleared (with a few), the options a choice gets, and saved views that lose a filter.
 * Null when nothing would change. Counts are of the first 500 values (`more`: there are others).
 */
export const preview = query({
	args: {
		fieldId: v.id("recordFields"),
		kind: fieldKind,
		multiple: v.optional(v.boolean()),
		linkTypeId: v.optional(v.id("recordTypes")),
		options: v.optional(options),
	},
	handler: async (ctx, { fieldId, ...shape }) => {
		const member = await getMember(ctx);
		if (!member) return null;
		// A change it would refuse says why, for the dialog to show, instead of failing the query.
		try {
			return await previewChange(ctx, member, fieldId, shape);
		} catch (error) {
			if (error instanceof ConvexError) return { error: String(error.data) };
			throw error;
		}
	},
});

/** A field's change in progress, if any (records converted so far), and its latest change that undo can reach. */
export const changes = query({
	args: { fieldId: v.id("recordFields") },
	handler: async (ctx, { fieldId }) => {
		const member = await getMember(ctx);
		const field = member && (await ctx.db.get(fieldId));
		if (!member || !field || field.workspaceId !== member.workspaceId || !(await typeVisible(ctx, member)(field.typeId))) return null;
		return changesOf(ctx, field);
	},
});
