import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";

// Personal preferences: only you see them, and they follow you to every device.

const defaults = { displayName: "", sendWith: "enter" as const };
const sendWith = v.union(v.literal("enter"), v.literal("mod-enter"));

const find = (ctx: QueryCtx, userId: Id<"users">) =>
	ctx.db
		.query("preferences")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();

export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return defaults;
		const prefs = await find(ctx, userId);
		return prefs ? { displayName: prefs.displayName, sendWith: prefs.sendWith } : defaults;
	},
});

export const update = mutation({
	args: { displayName: v.optional(v.string()), sendWith: v.optional(sendWith) },
	handler: async (ctx, changes) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		if (changes.displayName !== undefined) {
			changes.displayName = changes.displayName.trim();
			if (changes.displayName.length > 60) throw new ConvexError("Keep your name under 60 characters.");
		}
		const prefs = await find(ctx, userId);
		if (prefs) await ctx.db.patch(prefs._id, changes);
		else await ctx.db.insert("preferences", { userId, ...defaults, ...changes });
	},
});
