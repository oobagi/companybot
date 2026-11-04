import { isValidTimeZone } from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { imageUrl } from "./images";
import { authUserId, preferencesOf, requireUserId } from "./lib";
import { notify } from "./schema";

// Personal preferences: only you see them, and they follow you to every device.

const defaults = { displayName: "", sendWith: "enter" as const };
const defaultNotify = "all" as const;
const unset = { timeZone: null, deviceTimeZone: null };
const sendWith = v.union(v.literal("enter"), v.literal("mod-enter"));

export const get = query({
	args: {},
	handler: async (ctx) => {
		const userId = await authUserId(ctx);
		const prefs = userId && (await preferencesOf(ctx, userId));
		if (!prefs) return { ...defaults, notify: defaultNotify, ...unset, image: null };
		return {
			displayName: prefs.displayName,
			sendWith: prefs.sendWith,
			notify: prefs.notify ?? defaultNotify,
			/** Null means automatic. */
			timeZone: prefs.timeZone ?? null,
			deviceTimeZone: prefs.deviceTimeZone ?? null,
			/** Your photo's URL, or null for your initials. */
			image: await imageUrl(ctx, prefs.image),
		};
	},
});

const preferenceChanges = v.object({
		displayName: v.optional(v.string()),
		sendWith: v.optional(sendWith),
		notify: v.optional(notify),
		/** Null switches back to automatic. */
		timeZone: v.optional(v.union(v.string(), v.null())),
		deviceTimeZone: v.optional(v.string()),
});

export const update = mutation({
	args: preferenceChanges.fields,
	handler: async (ctx, args) => {
		return updatePreferences(ctx, await requireUserId(ctx), args);
	},
});

export async function updatePreferences(ctx: MutationCtx, userId: Id<"users">, { timeZone, ...rest }: Infer<typeof preferenceChanges>) {
	const changes = { ...rest, ...(timeZone !== undefined && { timeZone: timeZone ?? undefined }) };
	for (const zone of [changes.timeZone, changes.deviceTimeZone]) {
		if (zone !== undefined && !isValidTimeZone(zone)) throw new ConvexError("Unknown time zone.");
	}
	if (changes.displayName !== undefined) {
		changes.displayName = changes.displayName.trim();
		if (changes.displayName.length > 60) throw new ConvexError("Keep your name under 60 characters.");
	}
	await savePreferences(ctx, userId, changes);
}

/** Writes someone's preferences, making their row the first time. */
export async function savePreferences(ctx: MutationCtx, userId: Id<"users">, changes: Partial<Omit<Doc<"preferences">, "_id" | "_creationTime" | "userId">>) {
	const prefs = await preferencesOf(ctx, userId);
	if (prefs) await ctx.db.patch(prefs._id, changes);
	else await ctx.db.insert("preferences", { userId, ...defaults, ...changes });
}
