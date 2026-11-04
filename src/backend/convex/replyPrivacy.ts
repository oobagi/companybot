import { EVERYONE, whoCan } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canPost, reachOf } from "./chatOps";
import { type Member, nameOf } from "./lib";
import { pageState } from "./pageTree";
import { type AccessList, chatAccess, reach } from "./placeAccess";
import { inheritPlaces, type UsedPlace } from "./replySources";

export async function source(ctx: QueryCtx, member: Member, id: UsedPlace, audience = false): Promise<{ membersOnly: boolean; users?: Id<"users">[]; where: string; access: AccessList; visible: boolean; name: string; why: string }> {
	const databaseId = ctx.db.normalizeId("recordTypes", id);
	if (databaseId) {
		const db = await ctx.db.get(databaseId);
		return { membersOnly: false, where: "", access: db ? db.access : [], visible: !!db && db.workspaceId === member.workspaceId && !!reach(member, db.access), name: db?.plural ?? "a deleted database", why: `the ${db?.plural ?? "deleted"} database` };
	}
	const pageId = ctx.db.normalizeId("pages", id);
	if (pageId) {
		const page = await ctx.db.get(pageId);
		const access = page ? (await pageState(ctx, page)).access : [];
		return { membersOnly: false, where: "", access, visible: !!page && page.workspaceId === member.workspaceId && !!reach(member, access), name: page?.title ?? "a deleted page", why: `the ${page?.title ?? "deleted"} page` };
	}
	const chatId = ctx.db.normalizeId("chats", id);
	const chat = chatId && (await ctx.db.get(chatId));
	const visible = !!chat && (await reachOf(ctx, chat, member)) === "ok";
	const named = chat?.kind === "channel" ? `#${chat.name}` : "a private conversation";
	const users = audience && chat && (chat.private || chat.kind !== "channel") ? (await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).collect()).flatMap((m) => m.userId ? [m.userId] : []) : undefined;
	return { users, access: chat ? chatAccess(chat) : [], visible, membersOnly: !!chat && (chat.private || chat.kind === "dm"), where: visible ? named : chat?.kind === "channel" ? "a private channel" : "a private conversation", name: chat ? named : "a deleted channel", why: chat ? chat.kind === "channel" ? `the #${chat.name} channel` : "a private conversation" : "a deleted channel" };
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
	const audience = membership.length ? `${roleLimit ? who : "people"} in ${membership.join(" and ")}` : who;
	const label = `Only ${audience} can see this`;
	const asker = message.repliedTo;
	return {
		hidden,
		label: hidden ? `Replied to ${asker ? await nameOf(ctx, asker) : "someone"}. ${label}.` : label,
		why: hidden ? null : `Uses ${sources.map((s) => s.why).join(", ")}`,
		share: hidden || !chat || !canPost(member, chat) ? null : `Not everyone in ${chat?.kind === "channel" ? `#${chat.name}` : "this chat"} can see ${sources.map((s) => s.name).join(", ")}. Share anyway?`,
		sharedBy: null,
	};
}

/** The server is the security boundary for every client, including those that ignore privacy metadata. */
export function maskedReply(message: Doc<"chatMessages">, label: string): Doc<"chatMessages"> {
	return { ...message, text: `🔒 ${label}`, parts: [], attachments: undefined, linkPreviews: undefined, error: undefined, stats: undefined, automation: undefined, pause: undefined, quiet: undefined, mentions: { userIds: [], agentIds: [] }, replyAuthors: [], replyCount: 0, lastReplyAt: undefined };
}
