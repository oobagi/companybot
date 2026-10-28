import { imageMaxBytes, sniffImage } from "@companybot/core/images";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, httpAction, internalMutation } from "./_generated/server";
import { requireLiveAgent } from "./agents";
import { mutation, query } from "./functions";
import { type Member, authUserId, checkPermission, memberOf, memo, preferencesOf, requireMember } from "./lib";
import { savePreferences } from "./preferences";

// Pictures people upload, on Convex file storage. The app POSTs the file to `upload` (an HTTP
// action, signed in), which reads its type from its first bytes, stores it, and notes who
// uploaded it (`uploads`). The app then hands the storage id to `set`, which takes only the
// caller's own unclaimed upload and uses its row up. Rows hold storage ids; queries return
// URLs. Replacing or removing a picture deletes the old file; so does deleting its row
// (lifecycle.ts `files`). Uploads nobody claims go after a day (`sweepUploads`).

/** Unclaimed uploads one person can have at once: enough for retries, not for filling storage. */
const PENDING_MAX = 20;
/** How long an upload waits to be attached before the sweep deletes it. */
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
const SWEEP_MAX = 100;

/** The app runs on its own origin (a file, or the dev server), and sends its sign-in token, not cookies. */
const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};
const reply = (status: number, body: { storageId: Id<"_storage"> } | { error: string }) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** Where the app uploads: `POST <site>/images/upload?workspaceId=…`, with the sign-in token. */
export const uploadEndpoint = query({ args: {}, handler: async () => `${process.env.CONVEX_SITE_URL}/images/upload` });

/** The CORS preflight for `upload`. */
export const uploadOptions = httpAction(async () => new Response(null, { status: 204, headers: cors }));

/** Takes one picture: 401 signed out, 413 too big, 415 not a PNG/JPEG/WebP/GIF by its bytes, 403 not allowed. */
export const upload = httpAction(async (ctx, request) => {
	if (!(await ctx.auth.getUserIdentity())) return reply(401, { error: "Sign in to upload." });
	const tooBig = () => reply(413, { error: "Pick an image under 2 MB." });
	if (Number(request.headers.get("content-length") ?? 0) > imageMaxBytes) return tooBig();
	// Raw HTTP bodies have no Convex size cap. Stop at our limit even without Content-Length.
	const buffer = new Uint8Array(imageMaxBytes);
	let size = 0;
	const reader = request.body?.getReader();
	if (reader) {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (size + value.byteLength > imageMaxBytes) {
					await reader.cancel();
					return tooBig();
				}
				buffer.set(value, size);
				size += value.byteLength;
			}
		} finally {
			reader.releaseLock();
		}
	}
	const bytes = buffer.subarray(0, size);
	const type = sniffImage(bytes);
	if (!type) return reply(415, { error: "Pick a PNG, JPEG, WebP or GIF image." });
	const storageId = await ctx.storage.store(new Blob([bytes], { type }));
	const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? undefined;
	try {
		await ctx.runMutation(internal.images.saveUpload, { storageId, workspaceId });
	} catch (e) {
		await ctx.storage.delete(storageId);
		return reply(403, { error: e instanceof ConvexError ? String(e.data) : "Upload refused." });
	}
	return reply(200, { storageId });
});

/** Notes who uploaded a file. Runs as them (the action passes their sign-in on). */
export const saveUpload = internalMutation({
	args: { storageId: v.id("_storage"), workspaceId: v.optional(v.string()) },
	handler: async (ctx, { storageId, workspaceId: requested }) => {
		const userId = await authUserId(ctx);
		if (!userId) throw new ConvexError("Sign in to upload.");
		const workspaceId = requested ? ctx.db.normalizeId("workspaces", requested) : undefined;
		if (requested && !(workspaceId && (await memberOf(ctx, userId, workspaceId)))) throw new ConvexError("You're not in that workspace.");
		const pending = await ctx.db.query("uploads").withIndex("by_user", (q) => q.eq("userId", userId)).take(PENDING_MAX);
		if (pending.length >= PENDING_MAX) throw new ConvexError("Too many uploads waiting. Try again tomorrow.");
		await ctx.db.insert("uploads", { storageId, userId, workspaceId: workspaceId ?? undefined, createdAt: Date.now() });
	},
});

/** What a picture is for: the open workspace's logo, your photo, or an agent's picture. */
const owner = v.union(v.literal("workspace"), v.literal("me"), v.id("agents"));

/** Sets a picture to one of your uploads, or (with null) removes it. */
export const set = mutation({
	args: { of: owner, file: v.union(v.id("_storage"), v.null()) },
	handler: async (ctx, { of, file }) => setImage(ctx, await requireMember(ctx), of, file),
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
	if (file && file === row?.image) return;
	if (file) await claimUpload(ctx, member, file);
	if (row?.image) await deleteFile(ctx, row.image);
	const image = file ?? undefined;
	if (of === "me") await savePreferences(ctx, member.userId, { image });
	else await ctx.db.patch(row!._id, { image });
}

/** Uses up the caller's own upload of `file`. Anyone else's, or one already used, is refused and left alone. */
async function claimUpload(ctx: MutationCtx, member: Member, file: Id<"_storage">) {
	const upload = await ctx.db.query("uploads").withIndex("by_storage", (q) => q.eq("storageId", file)).unique();
	if (upload?.userId !== member.userId) throw new ConvexError("That upload isn't available. Upload the image again.");
	await ctx.db.delete(upload._id);
}

/** Hourly (crons.ts): deletes uploads nobody attached within a day, and their files. */
export const sweepUploads = internalMutation({
	args: {},
	handler: async (ctx) => {
		const due = await ctx.db
			.query("uploads")
			.withIndex("by_created", (q) => q.lt("createdAt", Date.now() - UPLOAD_TTL_MS))
			.take(SWEEP_MAX);
		for (const row of due) {
			await deleteFile(ctx, row.storageId);
			await ctx.db.delete(row._id);
		}
		if (due.length === SWEEP_MAX) await ctx.scheduler.runAfter(0, internal.images.sweepUploads, {});
	},
});

/** Deletes a stored file, if it's still there. */
export async function deleteFile(ctx: MutationCtx, file: Id<"_storage">) {
	if (await ctx.db.system.get(file)) await ctx.storage.delete(file);
}

/** A picture's URL, or null to show initials. */
export const imageUrl = async (ctx: QueryCtx, file: Id<"_storage"> | undefined) => (file ? await ctx.storage.getUrl(file) : null);

/** `imageUrl`, once per file for a whole query: a long chat shows the same few faces. */
export const imageUrls = (ctx: QueryCtx) => memo((file: Id<"_storage"> | undefined) => imageUrl(ctx, file));
