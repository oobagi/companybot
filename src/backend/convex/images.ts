import { imageError } from "@companybot/core/images";
import { ConvexError, type Infer, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireLiveAgent } from "./agents";
import { mutation } from "./functions";
import { type Member, checkPermission, memo, preferencesOf, requireMember } from "./lib";
import { savePreferences } from "./preferences";

// Pictures people upload, on Convex file storage: the app gets a one-time URL (`uploadUrl`),
// POSTs the file to it, then hands the storage id to `set`. Rows hold the storage id; queries
// return its URL. Replacing or removing one deletes the old file; so does deleting its row
// (lifecycle.ts `files`). Storage ids stay on the server: only URLs go out.

/** What a picture is for: the open workspace's logo, your photo, or an agent's picture. */
const owner = v.union(v.literal("workspace"), v.literal("me"), v.id("agents"));

/** A one-time URL to POST one image to. */
export const uploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		await requireMember(ctx);
		return await ctx.storage.generateUploadUrl();
	},
});

/** Sets (or, with null, removes) a picture. A file that isn't a fit picture is deleted, and its reason returned. */
export const set = mutation({
	args: { of: owner, file: v.union(v.id("_storage"), v.null()) },
	handler: async (ctx, { of, file }): Promise<{ error?: string }> => setImage(ctx, await requireMember(ctx), of, file),
});

/**
 * Owners change the workspace's logo and, like any other agent edit, agents' pictures (in
 * Trash, they're read-only). Everyone changes their own photo, wherever they are.
 */
export async function setImage(ctx: MutationCtx, member: Member, of: Infer<typeof owner>, file: Id<"_storage"> | null) {
	const row =
		of === "workspace"
			? await ctx.db.get(checkPermission(member, "workspace.manage").workspaceId)
			: of === "me"
				? await preferencesOf(ctx, member.userId)
				: await requireLiveAgent(ctx, checkPermission(member, "agents.manage"), of);
	if (file && file === row?.image) return {};
	if (file) {
		const error = await checkImage(ctx, file);
		if (error) return { error };
	}
	if (row?.image) await deleteFile(ctx, row.image);
	const image = file ?? undefined;
	if (of === "me") await savePreferences(ctx, member.userId, { image });
	else await ctx.db.patch(row!._id, { image });
	return {};
}

/** Why a just-uploaded file can't be a picture (and deletes it), or undefined. Someone else's is refused, never deleted. */
async function checkImage(ctx: MutationCtx, file: Id<"_storage">) {
	const meta = await ctx.db.system.get(file);
	if (!meta) throw new ConvexError("That upload didn't finish. Try again.");
	if (await inUse(ctx, file)) throw new ConvexError("That image is already in use.");
	const error = imageError({ type: meta.contentType, size: meta.size });
	if (error) await ctx.storage.delete(file);
	return error;
}

/** Whether a row already shows this file. */
const inUse = async (ctx: QueryCtx, file: Id<"_storage">) =>
	!!(
		(await ctx.db.query("workspaces").withIndex("by_image", (q) => q.eq("image", file)).first()) ??
		(await ctx.db.query("preferences").withIndex("by_image", (q) => q.eq("image", file)).first()) ??
		(await ctx.db.query("agents").withIndex("by_image", (q) => q.eq("image", file)).first())
	);

/** Deletes a stored file, if it's still there. */
export async function deleteFile(ctx: MutationCtx, file: Id<"_storage">) {
	if (await ctx.db.system.get(file)) await ctx.storage.delete(file);
}

/** A picture's URL, or null to show initials. */
export const imageUrl = async (ctx: QueryCtx, file: Id<"_storage"> | undefined) => (file ? await ctx.storage.getUrl(file) : null);

/** `imageUrl`, once per file for a whole query: a long chat shows the same few faces. */
export const imageUrls = (ctx: QueryCtx) => memo((file: Id<"_storage"> | undefined) => imageUrl(ctx, file));
