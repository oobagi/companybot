import { v } from "convex/values";
import { mutation } from "./functions";
import { requireMember } from "./lib";
import { createField, toField, updateField } from "./recordOps";
import { fieldKind } from "./schema";

// Fields on databases. Adding, changing and deleting any of them takes `fields.edit`;
// adding one gives no extra rights over it. See wiki/data.md.

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

/** Renames a field, sets its icon (null: back to the kind's) or changes its options (send them all; keep `id`s to keep values). */
export const update = mutation({
	args: {
		fieldId: v.id("recordFields"),
		label: v.optional(v.string()),
		icon: v.optional(v.union(v.string(), v.null())),
		options: v.optional(options),
		position: v.optional(v.number()),
	},
	handler: async (ctx, { fieldId, ...update }) => updateField(ctx, { member: await requireMember(ctx) }, fieldId, update),
});
