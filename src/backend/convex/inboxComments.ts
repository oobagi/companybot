import { can } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Namer } from "./chatOps";
import { mutation } from "./functions";
import { type Who, checkPermission, memberOf, nameOf, requireInWorkspace, requirePermission } from "./lib";
import { notify } from "./notifications";

// Comments: what staff (and agents, for them) say about a message in an Inbox conversation, never sent
// to the customer. Each message has its own thread: comments in the order written. One rule decides who
// may do what: anyone who can use Inbox comments; only a comment's author edits or deletes it (an agent,
// its own). @mentions tell those people (notifications.ts); so does a comment on a conversation assigned
// to someone. They go with their conversation (lifecycle.ts), and with a discarded draft.

export const COMMENT_MAX = 5_000;
const MENTIONS_MAX = 10;
/** Comments read back per conversation: plenty for any one screen. */
const READ_MAX = 500;

/** Adds one, on a message, as a person (or an agent for them). */
export async function commentAs(ctx: MutationCtx, who: Who, message: Doc<"inboxMessages">, text: string, mentions: Id<"users">[] = []) {
	checkPermission(who.member, "inbox.use");
	requireInWorkspace(who.member, message, "Message");
	const body = checkedText(text);
	const tagged = await checkedMentions(ctx, who, mentions);
	const id = await ctx.db.insert("inboxComments", {
		workspaceId: message.workspaceId,
		conversationId: message.conversationId,
		messageId: message._id,
		text: body,
		authorUserId: who.member.userId,
		...(who.agentId && { authorAgentId: who.agentId }),
		...(tagged.length && { mentions: tagged }),
	});
	await tell(ctx, who, message.conversationId, body, tagged);
	return id;
}

/** An agent's own comment, with no person behind it: what it noted for staff while answering a customer. */
export async function commentByAgent(ctx: MutationCtx, message: Doc<"inboxMessages">, agentId: Id<"agents">, text: string) {
	return ctx.db.insert("inboxComments", { workspaceId: message.workspaceId, conversationId: message.conversationId, messageId: message._id, text: checkedText(text), authorAgentId: agentId });
}

export async function editAs(ctx: MutationCtx, who: Who, id: Id<"inboxComments">, text: string, mentions: Id<"users">[] = []) {
	const comment = await ownComment(ctx, who, id);
	const body = checkedText(text);
	const tagged = await checkedMentions(ctx, who, mentions);
	await ctx.db.patch(id, { text: body, mentions: tagged.length ? tagged : undefined, editedAt: Date.now() });
	// Only someone newly mentioned hears about it.
	const fresh = tagged.filter((u) => !comment.mentions?.includes(u));
	if (fresh.length) await tell(ctx, who, comment.conversationId, body, fresh, false);
}

export async function removeAs(ctx: MutationCtx, who: Who, id: Id<"inboxComments">) {
	await ctx.db.delete((await ownComment(ctx, who, id))._id);
}

export const add = mutation({
	args: { messageId: v.id("inboxMessages"), text: v.string(), mentions: v.optional(v.array(v.id("users"))) },
	handler: async (ctx, { messageId, text, mentions }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const message = requireInWorkspace(member, await ctx.db.get(messageId), "Message");
		return commentAs(ctx, { member }, message, text, mentions);
	},
});

export const edit = mutation({
	args: { id: v.id("inboxComments"), text: v.string(), mentions: v.optional(v.array(v.id("users"))) },
	handler: async (ctx, { id, text, mentions }) => editAs(ctx, { member: await requirePermission(ctx, "inbox.use") }, id, text, mentions),
});

export const remove = mutation({
	args: { id: v.id("inboxComments") },
	handler: async (ctx, { id }) => removeAs(ctx, { member: await requirePermission(ctx, "inbox.use") }, id),
});

/** A conversation's comments, by message, oldest first: who wrote each, who it mentions, and whether it's yours to change. */
export async function commentsOf(ctx: QueryCtx, who: Who, conversationId: Id<"inboxConversations">, names: Namer) {
	const rows = await ctx.db.query("inboxComments").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).take(READ_MAX);
	const byMessage = new Map<Id<"inboxMessages">, Awaited<ReturnType<typeof shown>>[]>();
	const shown = async (c: Doc<"inboxComments">) => ({
		id: c._id,
		at: c._creationTime,
		text: c.text,
		edited: !!c.editedAt,
		/** Who wrote it: a person, an agent for one (`for`), or an agent on its own. */
		author: await names.of({ authorAgentId: c.authorAgentId, authorUserId: c.authorAgentId ? undefined : c.authorUserId, actingFor: c.authorAgentId ? c.authorUserId : undefined }),
		mentions: await Promise.all((c.mentions ?? []).map((u) => names.user(u))),
		mine: isAuthor(c, who),
	});
	for (const c of rows) byMessage.set(c.messageId, [...(byMessage.get(c.messageId) ?? []), await shown(c)]);
	return byMessage;
}

const isAuthor = (c: Doc<"inboxComments">, { member, agentId }: Who) => (agentId ? c.authorAgentId === agentId : !c.authorAgentId && c.authorUserId === member.userId);

async function ownComment(ctx: QueryCtx, who: Who, id: Id<"inboxComments">) {
	checkPermission(who.member, "inbox.use");
	const comment = requireInWorkspace(who.member, await ctx.db.get(id), "Comment");
	if (!isAuthor(comment, who)) throw new ConvexError("Only whoever wrote a comment can change or delete it.");
	return comment;
}

function checkedText(text: string) {
	const body = text.trim();
	if (!body) throw new ConvexError("Write something first.");
	if (body.length > COMMENT_MAX) throw new ConvexError(`Comments can be up to ${COMMENT_MAX.toLocaleString()} characters.`);
	return body;
}

/** Who a comment may mention: teammates whose role can use Inbox, at most ten, each once. */
async function checkedMentions(ctx: QueryCtx, { member }: Who, mentions: Id<"users">[]) {
	const unique = [...new Set(mentions)];
	if (unique.length > MENTIONS_MAX) throw new ConvexError(`A comment can mention up to ${MENTIONS_MAX} people.`);
	for (const userId of unique) {
		const them = await memberOf(ctx, userId, member.workspaceId);
		if (!them || !can(them, "inbox.use")) throw new ConvexError("You can only mention teammates who can use Inbox.");
	}
	return unique;
}

/** Tells who's mentioned, and whoever the conversation is assigned to (`withAssignee`); never the author. */
async function tell(ctx: MutationCtx, who: Who, conversationId: Id<"inboxConversations">, text: string, mentions: Id<"users">[], withAssignee = true) {
	const c = await ctx.db.get(conversationId);
	if (!c) return;
	const by = who.agentId ? ((await ctx.db.get(who.agentId))?.name ?? "An agent") : await nameOf(ctx, who.member.userId);
	const actor = { actorUserId: who.member.userId, ...(who.agentId && { actorAgentId: who.agentId }), except: who.agentId ? undefined : who.member.userId };
	if (mentions.length) await notify(ctx, c, mentions, { kind: "comment", text: `${by} mentioned you: ${text}`, ...actor });
	const assignee = c.mode === "staff" ? c.takenBy : undefined;
	if (withAssignee && assignee && !mentions.includes(assignee)) await notify(ctx, c, [assignee], { kind: "comment", text: `${by} commented: ${text}`, ...actor });
}
