import { isValidTimeZone } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { notify } from "./schema";

// Personal preferences: only you see them, and they follow you to every device.

const defaults = { displayName: "", sendWith: "enter" as const };
const defaultNotify = "all" as const;
const unset = { timeZone: null, deviceTimeZone: null };
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
		if (!userId) return { ...defaults, notify: defaultNotify, ...unset };
		const prefs = await find(ctx, userId);
		if (!prefs) return { ...defaults, notify: defaultNotify, ...unset };
		return {
			displayName: prefs.displayName,
			sendWith: prefs.sendWith,
			notify: prefs.notify ?? defaultNotify,
			/** Null means automatic. */
			timeZone: prefs.timeZone ?? null,
			deviceTimeZone: prefs.deviceTimeZone ?? null,
		};
	},
});

export const update = mutation({
	args: {
		displayName: v.optional(v.string()),
		sendWith: v.optional(sendWith),
		notify: v.optional(notify),
		/** Null switches back to automatic. */
		timeZone: v.optional(v.union(v.string(), v.null())),
		deviceTimeZone: v.optional(v.string()),
	},
	handler: async (ctx, { timeZone, ...rest }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		const changes = { ...rest, ...(timeZone !== undefined && { timeZone: timeZone ?? undefined }) };
		for (const zone of [changes.timeZone, changes.deviceTimeZone]) {
			if (zone !== undefined && !isValidTimeZone(zone)) throw new ConvexError("Unknown time zone.");
		}
		if (changes.displayName !== undefined) {
			changes.displayName = changes.displayName.trim();
			if (changes.displayName.length > 60) throw new ConvexError("Keep your name under 60 characters.");
		}
		const prefs = await find(ctx, userId);
		if (prefs) await ctx.db.patch(prefs._id, changes);
		else await ctx.db.insert("preferences", { userId, ...defaults, ...changes });
	},
});
