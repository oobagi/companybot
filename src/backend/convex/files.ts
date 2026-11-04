import { FILE_MAX_BYTES, FILES_PER_MESSAGE, TURN_IMAGES_MAX, cleanFileName, imageMaxBytes, imageMaxMb, imageSize, isFileType, isImageType, modelTakesImage, sniffFile } from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { type MutationCtx, type QueryCtx, httpAction, internalAction, internalMutation } from "./_generated/server";
import { canSee } from "./chatOps";
import { mutation, query } from "./functions";
import { deleteFile, readBody, reply, storeUpload, uploadOf } from "./images";
import { type Member, requireMember } from "./lib";
import { readReply } from "./replyPrivacy";
import { writeSources } from "./replySources";
import { type attachment, fileInfo } from "./schema";
import { runningTurn } from "./turns";

// Files attached to chat messages, on Convex file storage, through the same signed-in upload as
// pictures (images.ts): the app POSTs a file to `upload`, which reads its type from its bytes,
// stores it with that type, and notes who uploaded it (an `uploads` row with `file` set, which a
// picture can't claim). `messages.send` takes only the caller's own unclaimed uploads from the open
// workspace (`claimFiles`), so an id someone else learns is worthless. Files go with their message:
// deleting it deletes them (`deleteAttachments`), and so do the channel and workspace cascades
// (lifecycle.ts `files`). Agents get each message's files listed in their prompt and read them with
// chat.read_file (`readFor`, then fileText.ts); pictures go to models that see them (`turnImages`).

export type Attachment = Infer<typeof attachment>;

/** Where the app uploads files: `POST <site>/files/upload?workspaceId=…&name=…`, with the sign-in token. */
export const uploadEndpoint = query({ args: {}, handler: async () => `${process.env.CONVEX_SITE_URL}/files/upload` });

/** Takes one file: 401 signed out, 413 over 20 MB, 415 not a type we take by its bytes, 403 not allowed. */
export const upload = httpAction(async (ctx, request) => {
	if (!(await ctx.auth.getUserIdentity())) return reply(401, { error: "Sign in to upload." });
	const bytes = await readBody(request, FILE_MAX_BYTES);
	if (!bytes) return reply(413, { error: `Pick a file under ${FILE_MAX_BYTES / 1024 / 1024} MB.` });
	const name = cleanFileName(new URL(request.url).searchParams.get("name") ?? "");
	const type = sniffFile(bytes, name);
	if (!type) return reply(415, { error: "Attach a picture, PDF, Word or Excel file, or plain text (Markdown, CSV, JSON)." });
	return storeUpload(ctx, request, bytes, type, { name, type, size: bytes.length, ...(isImageType(type) && imageSize(bytes, type)) });
});

/** Drops one of your uploads nobody attached yet (removed from the composer), and its file. */
export const discard = mutation({
	args: { file: v.id("_storage") },
	handler: async (ctx, { file }) => {
		const member = await requireMember(ctx);
		const upload = await uploadOf(ctx, file);
		if (upload?.userId !== member.userId || !upload.file) return;
		await deleteFile(ctx, file);
		await ctx.db.delete(upload._id);
	},
});

/**
 * Uses up the caller's own unclaimed file uploads from this workspace, in order, as a message's
 * attachments. Anyone else's, a picture's, or one already used is refused, and nothing is claimed.
 */
export async function claimFiles(ctx: MutationCtx, member: Member, files: Id<"_storage">[]): Promise<Attachment[]> {
	const unique = [...new Set(files)];
	if (unique.length > FILES_PER_MESSAGE) throw new ConvexError(`Attach up to ${FILES_PER_MESSAGE} files to a message.`);
	const attachments: Attachment[] = [];
	for (const storageId of unique) {
		const upload = await uploadOf(ctx, storageId);
		if (upload?.userId !== member.userId || upload.workspaceId !== member.workspaceId || !upload.file) {
			throw new ConvexError("A file isn't available anymore. Attach it again.");
		}
		await ctx.db.delete(upload._id);
		attachments.push({ storageId, ...upload.file });
	}
	return attachments;
}

/** Deletes a message's files, as when it's deleted. */
export async function deleteAttachments(ctx: MutationCtx, message: Doc<"chatMessages">) {
	for (const a of message.attachments ?? []) await deleteFile(ctx, a.storageId);
}

/**
 * Attaches a file the runner stored (`ctx.storage.store`, with its real type) to the reply a running
 * turn is writing: for agents that make files, like pictures (imageGen.ts). Returns its file id. Refused, and the file deleted, if the
 * turn stopped, its person lost the chat, the type isn't one messages take, or the reply is full.
 */
export const attachToReply = internalMutation({
	args: { turnId: v.id("agentTurns"), storageId: v.id("_storage"), name: v.string(), width: v.optional(v.number()), height: v.optional(v.number()) },
	handler: async (ctx, { turnId, storageId, name, width, height }): Promise<{ attached: true; id: string } | { error: string }> => {
		const refuse = async (error: string) => (await deleteFile(ctx, storageId), { error });
		const running = await runningTurn(ctx, turnId).catch((e: Error) => e);
		if (running instanceof Error) return refuse(running.message);
		const file = await ctx.db.system.get(storageId);
		const type = file?.contentType;
		if (!file || !type || !isFileType(type)) return refuse("Messages can't take that type of file.");
		const reply = await ctx.db.get(running.turn.replyId);
		const attachments = reply?.attachments ?? [];
		if (!reply || reply.deleted || attachments.length >= FILES_PER_MESSAGE) return refuse(`A reply holds up to ${FILES_PER_MESSAGE} files.`);
		const size = width && height ? { width, height } : {};
		await ctx.db.patch(reply._id, { usedPlaces: await writeSources(ctx, running.member, { filtered: true, preserveOwn: true }, reply), attachments: [...attachments, { storageId, name: cleanFileName(name), type, size: file.size, ...size }] });
		return { attached: true, id: fileId(reply._id, attachments.length) };
	},
});

/** "<message id>/<index>": how agents name a file. */
export const fileId = (messageId: Id<"chatMessages">, index: number) => `${messageId}/${index}`;

/** A message's files as agents see them. */
export const filesForModel = (m: Doc<"chatMessages">) =>
	(m.attachments ?? []).map((a, i) => ({ id: fileId(m._id, i), name: a.name, type: a.type, size: a.size }));

/** The newest pictures in these messages (oldest first) that a model can be sent, at most TURN_IMAGES_MAX. */
export const turnImages = (messages: Doc<"chatMessages">[]) =>
	messages
		.flatMap((m) => (m.attachments ?? []).flatMap((a, i) => (modelTakesImage(a) ? [{ id: fileId(m._id, i), storageId: a.storageId, type: a.type }] : [])))
		.slice(-TURN_IMAGES_MAX);

/** A file by its agent id, if it's on a message in a chat this person can see. */
export async function visibleFile(ctx: QueryCtx, member: Member, id: string) {
	const [messageId, index] = id.split("/");
	const normalized = messageId && ctx.db.normalizeId("chatMessages", messageId);
	const message = normalized && (await ctx.db.get(normalized));
	const chat = message && !message.deleted && message.workspaceId === member.workspaceId && (await ctx.db.get(message.chatId));
	if (!chat || chat.archived || !(await canSee(ctx, chat, member)) || !(await readReply(ctx, member, message!))) return null;
	return message.attachments?.[Number(index)] ?? null;
}

/** chat.read_file's lookup, as the turn's person now: null if they can't see it. */
export const readFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.string() },
	handler: async (ctx, { turnId, id }) => {
		const { member } = await runningTurn(ctx, turnId);
		const file = await visibleFile(ctx, member, id);
		return file;
	},
});

/**
 * For agents using a chat file elsewhere (a logo, an agent's picture, a page, another message):
 * copies each file the turn's person can see into a new upload of theirs, which the app's own
 * mutations then claim, so an agent passes the same checks a person does. A copy, because a
 * message's files go with it. `picture`: only pictures a person could upload as one (images.ts).
 * Returns the copies by file id; unclaimed ones go with `dropCopies`, or the upload sweep.
 */
export const copyFor = internalAction({
	args: { turnId: v.id("agentTurns"), ids: v.array(v.string()), picture: v.boolean() },
	handler: async (ctx, { turnId, ids, picture }): Promise<{ copies: Record<string, Id<"_storage">> } | { error: string }> => {
		const copies: Record<string, Id<"_storage">> = {};
		const fail = async (error: string) => {
			await ctx.runMutation(internal.files.dropCopies, { turnId, storageIds: Object.values(copies) });
			return { error };
		};
		for (const id of new Set(ids)) {
			const found = await ctx.runMutation(internal.files.readFor, { turnId, id });
			if (!found) return fail(`No file "${id}" in a chat you can see.`);
			const { storageId: source, ...file } = found;
			if (picture && !isImageType(file.type)) return fail(`${file.name} isn't a picture (PNG, JPEG, WebP or GIF).`);
			if (picture && file.size > imageMaxBytes) return fail(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; pictures here can be up to ${imageMaxMb} MB.`);
			const blob = await ctx.storage.get(source);
			if (!blob) return fail(`${file.name} was deleted.`);
			const storageId = await ctx.storage.store(blob);
			copies[id] = storageId;
			const saved = await ctx.runMutation(internal.files.saveCopy, { turnId, storageId, ...(!picture && { file }) });
			if (saved) return fail(saved);
		}
		return { copies };
	},
});

/** Notes a copy as the turn's person's unclaimed upload (with `file`, one for a message). Returns why not, after deleting it. */
export const saveCopy = internalMutation({
	args: { turnId: v.id("agentTurns"), storageId: v.id("_storage"), file: v.optional(fileInfo) },
	handler: async (ctx, { turnId, storageId, file }) => {
		const running = await runningTurn(ctx, turnId).catch((e: Error) => e);
		if (running instanceof Error) return (await deleteFile(ctx, storageId), running.message);
		const { member } = running;
		await ctx.db.insert("uploads", { storageId, userId: member.userId, workspaceId: member.workspaceId, createdAt: Date.now(), ...(file && { file }) });
		return null;
	},
});

/** Deletes copies nothing claimed (the call that wanted them failed). Claimed ones have no upload row, so they're left alone. */
export const dropCopies = internalMutation({
	args: { turnId: v.id("agentTurns"), storageIds: v.array(v.id("_storage")) },
	handler: async (ctx, { storageIds }) => {
		for (const storageId of storageIds) {
			const upload = await uploadOf(ctx, storageId);
			if (!upload) continue;
			await deleteFile(ctx, storageId);
			await ctx.db.delete(upload._id);
		}
	},
});
