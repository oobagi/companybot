import { v } from "convex/values";
import { mutation } from "./functions";
import { requireMember } from "./lib";
import { createField, setFieldTrashed, toField, updateField } from "./recordOps";
import { fieldKind } from "./schema";

// Fields on databases. Anyone can add one (`fields.create`) and change the ones they
// added; owners can change any (`fields.manage`). See wiki/data.md.

const options = v.array(v.object({ id: v.optional(v.string()), label: v.string() }));

/** Adds a field ("Roof type" on clients). Returns it, with the `key` its values use. */
export const create = mutation({
	args: {
		typeId: v.id("recordTypes"),
		label: v.string(),
		kind: fieldKind,
		options: v.optional(options),
		linkTypeId: v.optional(v.id("recordTypes")),
		multiple: v.optional(v.boolean()),
	},
	handler: async (ctx, { typeId, ...input }) => {
		const field = await createField(ctx, { member: await requireMember(ctx) }, typeId, input);
		return { _id: field._id, ...toField(field) };
	},
});

/** Renames a field or changes its options (send them all; keep `id`s to keep values). */
export const update = mutation({
	args: { fieldId: v.id("recordFields"), label: v.optional(v.string()), options: v.optional(options), position: v.optional(v.number()) },
	handler: async (ctx, { fieldId, ...update }) => updateField(ctx, { member: await requireMember(ctx) }, fieldId, update),
});

// COMPAT(0.1.0-alpha.8): alpha.6 apps archive and restore here; newer ones use trash.move / trash.restore.
export const archive = mutation({
	args: { fieldId: v.id("recordFields") },
	handler: async (ctx, { fieldId }) => setFieldTrashed(ctx, { member: await requireMember(ctx) }, fieldId, true),
});

export const restore = mutation({
	args: { fieldId: v.id("recordFields") },
	handler: async (ctx, { fieldId }) => setFieldTrashed(ctx, { member: await requireMember(ctx) }, fieldId, false),
});
