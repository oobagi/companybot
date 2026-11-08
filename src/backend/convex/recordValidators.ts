import { v } from "convex/values";

export const condition = v.object({
	field: v.string(),
	eq: v.optional(v.any()),
	in: v.optional(v.array(v.any())),
	gt: v.optional(v.any()),
	gte: v.optional(v.any()),
	lt: v.optional(v.any()),
	lte: v.optional(v.any()),
	empty: v.optional(v.boolean()),
});
export const recordGroup = v.object({ field: v.string(), option: v.union(v.string(), v.null()) });
export const recordSort = v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) });
export const viewLayout = v.union(v.literal("table"), v.literal("board"));
/** `layout` and `groupBy` are optional: views saved before boards read as tables. `groupBy` is a single-valued choice field's key. */
/** Table column widths in pixels, by field key. */
export const columnWidths = v.record(v.string(), v.number());

export const viewConfig = {
	name: v.string(),
	filters: v.array(condition),
	sort: v.optional(recordSort),
	columns: v.array(v.string()),
	layout: v.optional(viewLayout),
	groupBy: v.optional(v.string()),
	/** Table column widths in pixels, by field key, for columns someone resized. The rest use their kind's default. */
	widths: v.optional(columnWidths),
};
