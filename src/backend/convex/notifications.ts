import { can } from "@companybot/core/permissions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { namer } from "./chatOps";
import { mutation, query } from "./functions";
import { accessOf, getMember, preferencesOf, requireMember, rolesOf } from "./lib";

// Notifications: what needs you in Inbox, in the tray (the bell in the title bar) and as desktop pop-ups.
// One per person per conversation: a newer one replaces it. Clearing one deletes it; opening its
// conversation clears it too. Unread DMs and mentions show in the same tray, from chats.alerts.

export type NotificationKind = Doc<"notifications">["kind"];

/** Everyone told about a conversation that's nobody's yet (a hand-off, a reply to check): at most this many. */
const BROADCAST_MAX = 100;
const TRAY_MAX = 50;

/**
 * Tells people about a conversation. `to`: chosen people, or "inbox" for everyone whose role can use
 * Inbox (`broad`: it pops up only for those with notifications on All). `except` (whoever did it) isn't told.
 */
export async function notify(
	ctx: MutationCtx,
	c: Doc<"inboxConversations">,
	to: Id<"users">[] | "inbox",
	n: { kind: NotificationKind; text: string; actorUserId?: Id<"users">; actorAgentId?: Id<"agents">; except?: Id<"users"> },
) {
	const broad = to === "inbox";
	const people = broad ? await inboxPeople(ctx, c.workspaceId) : to;
	for (const userId of new Set(people)) {
		if (userId === n.except) continue;
		const old = await ctx.db.query("notifications").withIndex("by_conversation", (q) => q.eq("conversationId", c._id).eq("userId", userId)).first();
		// A hand-off or a direct ask outranks "new message" for a broad one: never downgrade a personal one to broad.
		const keepPersonal = old && !old.broad && broad;
		if (old) await ctx.db.delete(old._id);
		await ctx.db.insert("notifications", {
			workspaceId: c.workspaceId,
			userId,
			conversationId: c._id,
			kind: n.kind,
			text: n.text.slice(0, 200),
			...(n.actorUserId && { actorUserId: n.actorUserId }),
			...(n.actorAgentId && { actorAgentId: n.actorAgentId }),
			...(broad && !keepPersonal && { broad: true as const }),
		});
	}
}

/** Members whose role can use Inbox. */
async function inboxPeople(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	const roles = await rolesOf(ctx, workspaceId);
	const rows = await ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(BROADCAST_MAX * 2);
	return rows.filter((r) => can(accessOf(roles, r), "inbox.use")).slice(0, BROADCAST_MAX).map((r) => r.userId);
}

/** Your notifications in this workspace, the newest first, with who did it and which conversation. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const notify = (await preferencesOf(ctx, member.userId))?.notify ?? "all";
		const rows = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId)).order("desc").take(TRAY_MAX);
		const names = namer(ctx, { images: true });
		const items = await Promise.all(
			rows.map(async (n) => {
				const c = await ctx.db.get(n.conversationId);
				if (!c || !can(member, "inbox.use")) return null;
				return {
					id: n._id,
					at: n._creationTime,
					kind: n.kind,
					text: n.text,
					conversationId: n.conversationId,
					channel: c.channel,
					contact: c.contact,
					contactName: c.contactName ?? null,
					actor: n.actorAgentId ? await names.agent(n.actorAgentId) : n.actorUserId ? await names.user(n.actorUserId) : null,
					/** Pops up on your desktop: per your notification setting, broad ones only on All. */
					popUp: notify === "all" || (notify === "mentions" && !n.broad),
				};
			}),
		);
		return items.filter((n) => n !== null);
	},
});

/** Clears one of yours. */
export const clear = mutation({
	args: { id: v.id("notifications") },
	handler: async (ctx, { id }) => {
		const member = await requireMember(ctx);
		const n = await ctx.db.get(id);
		if (n && n.userId === member.userId) await ctx.db.delete(id);
	},
});

/** Clears yours about a conversation: you opened it. */
export const clearConversation = mutation({
	args: { conversationId: v.id("inboxConversations") },
	handler: async (ctx, { conversationId }) => {
		const member = await requireMember(ctx);
		const n = await ctx.db.query("notifications").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId).eq("userId", member.userId)).first();
		if (n) await ctx.db.delete(n._id);
	},
});

/** Clears all of yours in this workspace. */
export const clearAll = mutation({
	args: {},
	handler: async (ctx) => {
		const member = await requireMember(ctx);
		const rows = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId)).take(500);
		for (const n of rows) await ctx.db.delete(n._id);
	},
});
