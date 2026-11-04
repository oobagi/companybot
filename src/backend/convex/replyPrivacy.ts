import { whoCan } from "@companybot/core";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canSee } from "./chatOps";
import { type Member, nameOf } from "./lib";
import { pageState } from "./pageTree";
import { type AccessList, chatAccess, reach } from "./placeAccess";
import { inheritPlaces, type UsedPlace } from "./replySources";

async function source(ctx: QueryCtx, member: Member, id: UsedPlace) {
	const databaseId = ctx.db.normalizeId("recordTypes", id);
	if (databaseId) {
		const db = await ctx.db.get(databaseId);
		return { access: db ? db.access : [], visible: !!db && db.workspaceId === member.workspaceId && !!reach(member, db.access), name: db?.plural ?? "a deleted database", why: `the ${db?.plural ?? "deleted"} database` };
	}
	const pageId = ctx.db.normalizeId("pages", id);
	if (pageId) {
		const page = await ctx.db.get(pageId);
		const access = page ? (await pageState(ctx, page)).access : [];
		return { access, visible: !!page && page.workspaceId === member.workspaceId && !!reach(member, access), name: page?.title ?? "a deleted page", why: `the ${page?.title ?? "deleted"} page` };
	}
	const chatId = ctx.db.normalizeId("chats", id);
	const chat = chatId && (await ctx.db.get(chatId));
	return { access: chat ? chatAccess(chat) : [], visible: !!chat && await canSee(ctx, chat, { ...member, replyId: undefined }), name: chat ? chat.kind === "channel" ? `#${chat.name}` : "a private conversation" : "a deleted channel", why: chat ? chat.kind === "channel" ? `the #${chat.name} channel` : "a private conversation" : "a deleted channel" };
}

/** Current access, never a saved audience: gaining a role makes old replies readable too. */
export async function canReadSources(ctx: QueryCtx, member: Member, sources: UsedPlace[] = []) {
	for (const id of sources) if (!(await source(ctx, member, id)).visible) return false;
	return true;
}

/** Agent reads propagate provenance as well as filtering, so quoting a reply cannot widen its audience. */
export async function canReadReply(ctx: QueryCtx, member: Member, message: Doc<"chatMessages"> | null) {
	if (!message) return false;
	if (message.workspaceId !== member.workspaceId) return false;
	if (message.sharedBy) return true;
	if (!(await canReadSources(ctx, member, message.usedPlaces))) return false;
	await inheritPlaces(ctx, member, message.usedPlaces);
	return true;
}

export type ReplyPrivacy = { hidden: boolean; label: string; why: string | null; share: string | null; sharedBy: string | null };

export async function replyPrivacy(ctx: QueryCtx, member: Member, message: Doc<"chatMessages">): Promise<ReplyPrivacy | null> {
	if (message.sharedBy) return { hidden: false, label: `Shared by ${await nameOf(ctx, message.sharedBy)}`, why: null, share: null, sharedBy: await nameOf(ctx, message.sharedBy) };
	if (!message.usedPlaces?.length) return null;
	const place = await ctx.db.get(message.chatId);
	if (place?.kind === "dm" && !place.parentId && place.dmKey?.split(",").filter((k) => k.startsWith("u:")).length === 1) return null;
	const sources = await Promise.all(message.usedPlaces.map((id) => source(ctx, member, id)));
	const hidden = sources.some((s) => !s.visible);
	// A role belongs in the label only when that role alone can view every source. Owners always do.
	const roles = member.workspaceRoles.filter((r) => !r.owner && sources.every((s) => !!reach({ ...member, owner: false, roles: [r.id] }, s.access)));
	const list: AccessList = roles.map((r) => ({ role: r.id, level: "view" }));
	const who = whoCan(list, member.workspaceRoles);
	const label = `Only ${who} can see this`;
	const asker = message.repliedTo;
	const chat = await ctx.db.get(message.chatId);
	return {
		hidden,
		label: hidden ? `Replied to ${asker ? await nameOf(ctx, asker) : "someone"}. ${label}.` : label,
		why: hidden ? null : `Uses ${sources.map((s) => s.why).join(", ")}`,
		share: hidden ? null : `Not everyone in ${chat?.kind === "channel" ? `#${chat.name}` : "this chat"} can see ${sources.map((s) => s.name).join(", ")}. Share anyway?`,
		sharedBy: null,
	};
}

/** COMPAT(0.1.0-alpha.10): alpha.9 apps ignore privacy metadata. Mask all content on the server. */
export function maskedReply(message: Doc<"chatMessages">, label: string): Doc<"chatMessages"> {
	return { ...message, text: `🔒 ${label}`, parts: [], attachments: undefined, linkPreviews: undefined, error: undefined, stats: undefined, automation: undefined, pause: undefined, quiet: undefined, mentions: { userIds: [], agentIds: [] }, replyAuthors: [], replyCount: 0, lastReplyAt: undefined };
}
