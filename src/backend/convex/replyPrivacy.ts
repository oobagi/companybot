import { EVERYONE, whoCan } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canPost, reachOf } from "./chatOps";
import { type Member, nameOf } from "./lib";
import { fileStates, pageStates } from "./pageTree";
import { type AccessList, chatAccess, reach } from "./placeAccess";
import { inheritPlaces, type UsedPlace } from "./replySources";

export type Source = { exclusiveTo?: Id<"users">; membersOnly: boolean; users?: Id<"users">[]; person?: string; where: string; access: AccessList; visible: boolean; name: string; why: string };
type SourceReader = { pages: ReturnType<typeof pageStates>; sources: Map<string, Promise<Source>> };
const readers = new WeakMap<QueryCtx, SourceReader>();

/** Query-local, viewer-keyed caching keeps long message lists within Convex's read limits. Mutations read live. */
export function source(ctx: QueryCtx, member: Member, id: UsedPlace, audience = false): Promise<Source> {
	if ("patch" in ctx.db) return loadSource(ctx, member, id, audience, pageStates(ctx));
	let reader = readers.get(ctx);
	if (!reader) { reader = { pages: pageStates(ctx), sources: new Map() }; readers.set(ctx, reader); }
	const key = `${member.workspaceId}/${member.userId}/${member.owner}/${[...member.roles].sort().join(",")}/${id}/${audience}`;
	let pending = reader.sources.get(key);
	if (!pending) { pending = loadSource(ctx, member, id, audience, reader.pages); reader.sources.set(key, pending); }
	return pending;
}

/** One write gets a live snapshot: each source and common page ancestor is loaded once. */
export function writeSourceReader(ctx: QueryCtx, member: Member) {
	const pages = pageStates(ctx);
	const sources = new Map<UsedPlace, Promise<Source>>();
	return (id: UsedPlace) => {
		let pending = sources.get(id);
		if (!pending) { pending = loadSource(ctx, member, id, true, pages); sources.set(id, pending); }
		return pending;
	};
}

/** Access and seats have already been loaded; checking another viewer needs no database reads. */
export const opensSource = (viewer: Member, policy: { access?: AccessList; users?: Id<"users">[]; exclusiveTo?: Id<"users"> }) =>
	(policy.exclusiveTo ? viewer.userId === policy.exclusiveTo : !!reach(viewer, policy.access)) && (!policy.users || policy.users.includes(viewer.userId));

async function loadSource(ctx: QueryCtx, member: Member, id: UsedPlace, audience: boolean, pages: ReturnType<typeof pageStates>): Promise<Source> {
	const userId = ctx.db.normalizeId("users", id);
	if (userId) {
		const person = await nameOf(ctx, userId);
		return { person, exclusiveTo: userId, membersOnly: true, users: [userId], where: "", access: [], visible: userId === member.userId, name: `personal information for ${person}`, why: `personal information for ${person}` };
	}
	const databaseId = ctx.db.normalizeId("recordTypes", id);
	if (databaseId) {
		const db = await ctx.db.get(databaseId);
		return { membersOnly: false, where: "", access: db ? db.access : [], visible: !!db && db.workspaceId === member.workspaceId && !!reach(member, db.access), name: db?.plural ?? "a deleted database", why: `the ${db?.plural ?? "deleted"} database` };
	}
	const pageId = ctx.db.normalizeId("pages", id);
	if (pageId) {
		const page = await ctx.db.get(pageId);
		const access = page ? (await pages(page)).access : [];
		const kind = page?.kind === "folder" ? "folder" : "page";
		return { membersOnly: false, where: "", access, visible: !!page && page.workspaceId === member.workspaceId && !!reach(member, access), name: page?.title ?? `a deleted ${kind}`, why: `the ${page?.title ?? "deleted"} ${kind}` };
	}
	const fileId = ctx.db.normalizeId("driveFiles", id);
	if (fileId) {
		const file = await ctx.db.get(fileId);
		const access = file ? (await fileStates(ctx, pages)(file)).access : [];
		return { membersOnly: false, where: "", access, visible: !!file && file.workspaceId === member.workspaceId && !!reach(member, access), name: file?.name ?? "a deleted file", why: `the ${file?.name ?? "deleted"} file` };
	}
	const chatId = ctx.db.normalizeId("chats", id);
	const chat = chatId && (await ctx.db.get(chatId));
	const visible = !!chat && (await reachOf(ctx, chat, member)) === "ok";
	const named = chat?.kind === "channel" ? `#${chat.name}` : "a private conversation";
	const users = audience && chat && (chat.private || chat.kind !== "channel") ? (await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect()).flatMap((m) => m.userId ? [m.userId] : []) : undefined;
	const dmUsers = chat?.kind === "dm" ? chat.dmKey?.split(",").filter((key) => key.startsWith("u:")).map((key) => key.slice(2) as Id<"users">) : undefined;
	const person = dmUsers?.length === 1 ? await nameOf(ctx, dmUsers[0]!) : undefined;
	return { person, exclusiveTo: dmUsers?.length === 1 ? dmUsers[0] : undefined, users, access: chat ? chatAccess(chat) : [], visible, membersOnly: !!chat && (chat.private || chat.kind === "dm"), where: visible ? named : chat?.kind === "channel" ? "a private channel" : "a private conversation", name: chat ? named : "a deleted channel", why: chat ? chat.kind === "channel" ? `the #${chat.name} channel` : "a private conversation" : "a deleted channel" };
}

/** Current access, never a saved audience: gaining a role makes old replies readable too. */
export async function canReadSources(ctx: QueryCtx, member: Member, sources: UsedPlace[] = []) {
	for (const id of sources) if (!(await source(ctx, member, id)).visible) return false;
	return true;
}

/** A pure viewer check: filtering a row must not change the reply being written. */
export async function canReadReply(ctx: QueryCtx, member: Member, message: Doc<"chatMessages"> | null) {
	if (!message) return false;
	if (message.workspaceId !== member.workspaceId) return false;
	if (message.sharedBy) return true;
	return canReadSources(ctx, member, message.usedPlaces);
}

/** Sharing releases shown text, never the private tool trace behind it. */
export async function canReadReplyDetails(ctx: QueryCtx, member: Member, message: Doc<"chatMessages"> | null) {
	return !!message && message.workspaceId === member.workspaceId && await canReadSources(ctx, member, message.usedPlaces);
}

export async function readReplyDetails(ctx: QueryCtx, member: Member, message: Doc<"chatMessages"> | null) {
	if (!message || !(await canReadReplyDetails(ctx, member, message))) return false;
	await inheritPlaces(ctx, member, message.usedPlaces);
	return true;
}

/** Old clients get the same generic tool summary as new ones, with no private labels or links. */
export function genericToolParts(parts: Doc<"chatMessages">["parts"]): Doc<"chatMessages">["parts"] {
	const count = new Set(parts.flatMap((p) => p.type === "tool" || p.type === "approval" ? [p.id] : [])).size;
	let shown = false;
	return parts.flatMap((part) => {
		if (part.type !== "tool" && part.type !== "approval") return [part];
		if (shown) return [];
		shown = true;
		return [{ type: "text" as const, text: `Used ${count} ${count === 1 ? "tool" : "tools"}` }];
	});
}

/** Called only for content actually returned to the agent. */
export async function readReply(ctx: QueryCtx, member: Member, message: Doc<"chatMessages"> | null) {
	if (!message || !(await canReadReply(ctx, member, message))) return false;
	if (!message.sharedBy) await inheritPlaces(ctx, member, message.usedPlaces);
	return true;
}

export type ReplyPrivacy = { hidden: boolean; label: string; why: string | null; share: string | null; sharedBy: string | null };

export async function replyPrivacy(ctx: QueryCtx, member: Member, message: Doc<"chatMessages">): Promise<ReplyPrivacy | null> {
	if (message.sharedBy) {
		const sharedBy = await nameOf(ctx, message.sharedBy);
		return { hidden: false, label: `Shared by ${sharedBy}`, why: null, share: null, sharedBy };
	}
	const places = message.usedPlaces?.filter((id) => id !== message.chatId) ?? [];
	if (!places.length) return null;
	const chat = await ctx.db.get(message.chatId);
	const sources = await Promise.all(places.map((id) => source(ctx, member, id)));
	const hidden = sources.some((s) => !s.visible);
	// Membership is an additional limit that roles alone cannot describe.
	const roles = member.workspaceRoles.filter((r) => !r.owner && sources.every((s) => !!reach({ ...member, owner: false, roles: [r.id] }, s.access)));
	const list: AccessList = roles.map((r) => ({ role: r.id, level: "view" }));
	const who = whoCan(list, member.workspaceRoles);
	const membership = sources.filter((s) => s.membersOnly).map((s) => s.where);
	const roleLimit = sources.some((s) => s.access && !s.access.some((e) => e.role === EVERYONE));
	const personal = sources.flatMap((s) => s.person ? [s.person] : []);
	const audience = personal.length ? personal.join(" and ") : membership.length ? `${roleLimit ? who : "people"} in ${membership.join(" and ")}` : who;
	const label = `Only ${audience} can see this`;
	const asker = message.repliedTo;
	return {
		hidden,
		label: hidden ? `Replied to ${asker ? await nameOf(ctx, asker) : "someone"}. ${label}.` : label,
		why: hidden ? null : `Uses ${sources.map((s) => s.why).join(", ")}`,
		share: hidden || !chat || !canPost(member, chat) ? null : `Not everyone in ${chat?.kind === "channel" ? `#${chat.name}` : "this chat"} can see ${sources.map((s) => s.name).join(", ")}. Share just the answer? Tool inputs, outputs and approval reasons stay private.`,
		sharedBy: null,
	};
}

/** The server is the security boundary for every client, including those that ignore privacy metadata. */
export function maskedReply(message: Doc<"chatMessages">, label: string): Doc<"chatMessages"> {
	return { ...message, text: `🔒 ${label}`, parts: [], attachments: undefined, linkPreviews: undefined, error: undefined, stats: undefined, automation: undefined, pause: undefined, quiet: undefined, mentions: { userIds: [], agentIds: [] }, replyAuthors: [], replyCount: 0, lastReplyAt: undefined };
}
