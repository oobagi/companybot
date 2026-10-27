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
export const recordSort = v.object({ field: v.string(), order: v.union(v.literal("asc"), v.literal("desc")) });
export const viewConfig = { name: v.string(), filters: v.array(condition), sort: v.optional(recordSort), columns: v.array(v.string()) };
