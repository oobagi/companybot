import {
	type InboxChannel,
	INBOX_TEXT_MAX,
	SMS_TEXT_MAX,
	channelWords,
	clipText,
	cleanSubject,
	isEmail,
	normalizeEmail,
	normalizePhone,
	referencesFor,
	replySubject,
	can,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { fireEvent } from "./automationRuns";
import { emailDomain, emailProvider, smsProvider } from "./channelProviders";
import { namer } from "./chatOps";
import { commentsOf } from "./inboxComments";
import { notify } from "./notifications";
import { mutation, query } from "./functions";
import { pointByAddress } from "./contactPoints";
import { linkCustomer } from "./customers";
import { scheduleFill } from "./fieldAi";
import { type Member, type Who, checkPermission, getMember, liveWorkspace, memberOf, nameOf, requireInWorkspace, requireLiveAgent, requirePermission } from "./lib";
import { typeVisible } from "./recordOps";

// Inbox: conversations with people outside the workspace, by email and text. The workspace's addresses
// and numbers (contactPoints.ts) take messages in through webhooks (http.ts → `receive`), one conversation
// per outside contact per address, linked to its customer's record (customers.ts). The agent
// picked on the address answers new ones as Public (inboxAgent.ts), or staff do when none is; staff with
// inbox.use watch, reply, take over and assign them to any agent. Every reply goes out from the address
// the conversation is with, under the name of whoever wrote it. wiki/architecture.md → Inbox.

const READ_MAX = 200;
/** What of a message an automation's run is handed: enough to act on, short enough for a prompt. */
const EVENT_TEXT_MAX = 4_000;
/** How long a reply may be "running" before a new message starts another one anyway (a crashed action). */
export const REPLY_STALE_MS = 10 * 60_000;
/** A short pause before the agent answers, so a burst of texts gets one reply. */
const REPLY_DELAY_MS = 2_000;

const kindOf = (channel: InboxChannel) => (channel === "email" ? "email" : "phone") as Doc<"contactPoints">["kind"];
const channelOfKind = (kind: Doc<"contactPoints">["kind"]): InboxChannel => (kind === "email" ? "email" : "sms");
const previewOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 140);
/** A conversation someone in this workspace may open. */
async function requireConversation(ctx: QueryCtx, member: Member, id: Id<"inboxConversations">) {
	checkPermission(member, "inbox.use");
	return requireInWorkspace(member, await ctx.db.get(id), "Conversation");
}

/** The record linked to a conversation, as this person may see it: its title and where it opens, or nothing. */
async function recordShown(ctx: QueryCtx, member: Member, recordId: Id<"records"> | undefined, visible = typeVisible(ctx, member)) {
	const record = recordId && (await ctx.db.get(recordId));
	if (!record || record.archived || !(await visible(record.typeId))) return null;
	const type = await ctx.db.get(record.typeId);
	return type && !type.archived ? { id: record._id, title: record.title, typeKey: type.key } : null;
}

/** The agent that answers a conversation now, if one does: assigned to it, and not deleted or in Archive. */
export async function answeringAgent(ctx: QueryCtx, c: Doc<"inboxConversations">) {
	const agent = c.mode === "agent" && c.agentId ? await ctx.db.get(c.agentId) : null;
	return agent && !agent.archived ? agent : null;
}

/** Whether replies can go out from a conversation's address: still the workspace's and working, or why not. */
async function viaOf(ctx: QueryCtx, c: Doc<"inboxConversations">) {
	const point = c.via ? await pointByAddress(ctx, c.workspaceId, kindOf(c.channel), c.via) : null;
	return { address: c.via, status: point?.status ?? ("removed" as const), error: point?.error ?? null };
}

/** Conversations, the latest first. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !can(member, "inbox.use")) return null;
		const rows = await ctx.db.query("inboxConversations").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).order("desc").take(READ_MAX);
		const visible = typeVisible(ctx, member);
		const people = namer(ctx, { images: true });
		return Promise.all(
			rows.map(async (c) => {
				return {
					/** Who answers it, with their picture: its agent, or who on staff it's assigned to. */
					assignee: c.mode === "agent" && c.agentId ? await people.agent(c.agentId) : c.takenBy ? await people.user(c.takenBy) : null,
					id: c._id,
					channel: c.channel,
					/** Our address or number it's with. */
					via: c.via,
					contact: c.contact,
					contactName: c.contactName ?? null,
					subject: c.subject ?? null,
					mode: c.mode,
					/** Assigned to you, on staff. */
					mine: c.mode === "staff" && c.takenBy === member.userId,
					needsStaff: c.needsStaff ?? null,
					lastAt: c.lastAt,
					preview: c.preview,
					record: await recordShown(ctx, member, c.recordId, visible),
				};
			}),
		);
	},
});

/** How many conversations wait for someone on staff (a reply to send, or a hand-off), for the rail. */
export const waiting = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !can(member, "inbox.use")) return 0;
		const count = async (needs: "draft" | "handoff") =>
			(await ctx.db.query("inboxConversations").withIndex("by_needs", (q) => q.eq("workspaceId", member.workspaceId).eq("needsStaff", needs)).take(100)).length;
		return (await count("draft")) + (await count("handoff"));
	},
});

/** One conversation and its messages, oldest first. */
export const get = query({
	args: { id: v.id("inboxConversations") },
	handler: async (ctx, { id }) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const c = await ctx.db.get(id);
		if (!c || c.workspaceId !== member.workspaceId || !can(member, "inbox.use")) return null;
		const messages = (await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", id)).order("desc").take(READ_MAX)).reverse();
		// People and agents as chat shows them (picture, and "for" when an agent acted for someone), so names open their card.
		const names = namer(ctx, { images: true });
		const comments = await commentsOf(ctx, { member }, id, names);
		return {
			id: c._id,
			/** The agent answering it (while `mode` is agent), or that last did (it handed off, or staff took over). */
			agent: c.agentId ? await names.agent(c.agentId) : null,
			channel: c.channel,
			contact: c.contact,
			contactName: c.contactName ?? null,
			subject: c.subject ?? null,
			mode: c.mode,
			/** Who has it, while staff do: a person, with their picture. */
			takenBy: c.takenBy ? await names.user(c.takenBy) : null,
			needsStaff: c.needsStaff ?? null,
			replying: !!c.replyingSince && Date.now() - c.replyingSince < REPLY_STALE_MS,
			/** Our address or number replies go from, and whether they can: `removed` (no longer the workspace's) or `failed` means they can't. */
			via: await viaOf(ctx, c),
			record: await recordShown(ctx, member, c.recordId),
			messages: await Promise.all(
				messages.map(async (m) => {
					const author = m.authorAgentId || m.authorUserId ? await names.of({ authorAgentId: m.authorAgentId, authorUserId: m.authorAgentId ? undefined : m.authorUserId, actingFor: m.authorAgentId ? m.authorUserId : undefined }) : null;
					return {
						id: m._id,
						at: m._creationTime,
						direction: m.direction,
						status: m.status,
						text: m.text,
						/** Theirs: the history their mail app quoted under it, shown folded. */
						quoted: m.quoted ?? null,
						/** Theirs: who else it went to. */
						cc: m.cc ?? [],
						/** Ours, once out: delivered, bounced (`error` says why) or marked as spam. */
						delivery: m.delivery ?? null,
						error: m.error ?? null,
						/** Who wrote it on our side (someone on staff, or the agent, `for` the person it acted for); null for theirs. */
						author,
						/** What staff said about it, oldest first: never sent. */
						comments: comments.get(m._id) ?? [],
						/** An assignment line: who it went to. */
						assignedTo: m.assignedTo === undefined ? null : ctx.db.normalizeId("agents", m.assignedTo) ? await names.agent(m.assignedTo as Id<"agents">) : await names.user(m.assignedTo as Id<"users">),
					};
				}),
			),
		};
	},
});

// ---- What staff do (and agents, for them: inbox.manage) ----

export const reply = mutation({
	/** `answers`: the email it replies to, when not their latest. */
	args: { id: v.id("inboxConversations"), text: v.string(), answers: v.optional(v.id("inboxMessages")) },
	handler: async (ctx, { id, text, answers }) => {
		const member = await requirePermission(ctx, "inbox.use");
		return replyAs(ctx, { member }, await requireConversation(ctx, member, id), text, answers);
	},
});

export const start = mutation({
	/** `from`: which of our addresses or numbers it goes from; left out, the first that works. */
	args: { from: v.optional(v.string()), channel: v.union(v.literal("email"), v.literal("sms")), to: v.string(), subject: v.optional(v.string()), text: v.string() },
	handler: async (ctx, args) => startAs(ctx, { member: await requirePermission(ctx, "inbox.use") }, args),
});

/** Who answers it: an agent, or someone on staff (agents stop answering). */
export const assign = mutation({
	args: { id: v.id("inboxConversations"), to: v.union(v.id("agents"), v.id("users")) },
	handler: async (ctx, { id, to }) => {
		const member = await requirePermission(ctx, "inbox.use");
		await assignTo(ctx, { member }, await requireConversation(ctx, member, id), to);
	},
});

/** Sends the agent's waiting reply, as staff left it (edited or not). */
export const sendDraft = mutation({
	args: { messageId: v.id("inboxMessages"), text: v.string() },
	handler: async (ctx, { messageId, text }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const draft = requireInWorkspace(member, await ctx.db.get(messageId), "Reply");
		if (draft.status !== "draft") throw new ConvexError("That reply was already sent or discarded.");
		const c = await requireConversation(ctx, member, draft.conversationId);
		await ctx.db.patch(draft._id, { text: checkedText(c.channel, text), status: "sending", authorUserId: member.userId });
		await ctx.scheduler.runAfter(0, internal.inbox.deliver, { messageId });
		await afterDraft(ctx, c, draft._id, text);
	},
});

export const discardDraft = mutation({
	args: { messageId: v.id("inboxMessages") },
	handler: async (ctx, { messageId }) => {
		const member = await requirePermission(ctx, "inbox.use");
		const draft = requireInWorkspace(member, await ctx.db.get(messageId), "Reply");
		if (draft.status !== "draft") return;
		const c = await requireConversation(ctx, member, draft.conversationId);
		await ctx.db.delete(draft._id);
		for (const k of await ctx.db.query("inboxComments").withIndex("by_message", (q) => q.eq("messageId", draft._id)).take(500)) await ctx.db.delete(k._id);
		await afterDraft(ctx, c, draft._id);
	},
});

/** Once a draft is handled, the conversation waits for staff only if another one is. */
async function afterDraft(ctx: MutationCtx, c: Doc<"inboxConversations">, handled: Id<"inboxMessages">, sent?: string) {
	const recent = await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(20);
	const more = recent.some((m) => m._id !== handled && m.status === "draft");
	await ctx.db.patch(c._id, { ...(c.needsStaff === "draft" && !more && { needsStaff: undefined }), ...(sent !== undefined && { lastAt: Date.now(), preview: previewOf(sent) }) });
}

const checkedText = (channel: InboxChannel, text: string) => {
	const trimmed = text.trim();
	if (!trimmed) throw new ConvexError("Write a message first.");
	const max = channel === "sms" ? SMS_TEXT_MAX : INBOX_TEXT_MAX;
	if (trimmed.length > max) throw new ConvexError(`Keep it under ${max.toLocaleString("en-US")} characters.`);
	return trimmed;
};

/** Staff (or an agent for them) answer in a conversation: it goes out at once from its address or number. */
export async function replyAs(ctx: MutationCtx, who: Who, c: Doc<"inboxConversations">, text: string, answers?: Id<"inboxMessages">) {
	checkPermission(who.member, "inbox.use");
	const body = checkedText(c.channel, text);
	const answered = answers && (await ctx.db.get(answers));
	if (answers && (c.channel !== "email" || answered?.conversationId !== c._id || answered.direction === "event")) throw new ConvexError("That email isn't in this conversation.");
	const id = await ctx.db.insert("inboxMessages", {
		workspaceId: c.workspaceId,
		conversationId: c._id,
		direction: "out",
		text: body,
		status: "sending",
		authorUserId: who.member.userId,
		...(who.agentId && { authorAgentId: who.agentId }),
		...(answers && { answers }),
	});
	await ctx.db.patch(c._id, { lastAt: Date.now(), preview: previewOf(body) });
	await ctx.scheduler.runAfter(0, internal.inbox.deliver, { messageId: id });
	return { conversationId: c._id, messageId: id };
}

/**
 * Starts (or continues) a conversation from one of our addresses or numbers (`from`, else the first that
 * works). Started by a person, it's theirs: agents stay out until someone assigns one. Started by an agent
 * for someone, that agent answers the replies.
 */
export async function startAs(ctx: MutationCtx, who: Who, args: { from?: string; channel: InboxChannel; to: string; subject?: string; text: string }) {
	const { member } = who;
	checkPermission(member, "inbox.use");
	const kind = kindOf(args.channel);
	const contact = args.channel === "email" ? (isEmail(args.to) ? normalizeEmail(args.to) : null) : normalizePhone(args.to);
	if (!contact) throw new ConvexError(args.channel === "email" ? `${args.to} isn't an email address.` : `${args.to} isn't a phone number. Include its country code, like +1.`);
	const from = args.from && (kind === "email" ? normalizeEmail(args.from) : normalizePhone(args.from));
	const point = from
		? await pointByAddress(ctx, member.workspaceId, kind, from)
		: (await ctx.db.query("contactPoints").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).take(50)).find((p) => p.kind === kind && p.status === "active");
	if (point?.status !== "active") {
		if (args.from) throw new ConvexError(`${args.from} isn't one of this workspace's ${kind === "email" ? "email addresses" : "phone numbers"}.`);
		throw new ConvexError(kind === "email" ? "There's no email address to send from yet. Add one in Settings → Email and phone." : "There's no phone number to text from yet. Add one in Settings → Email and phone.");
	}
	if (contact === point.address) throw new ConvexError("That's our own address.");
	const subject = cleanSubject(args.subject);
	if (args.channel === "email" && !subject) throw new ConvexError("Give the email a subject.");
	const existing = await conversationWith(ctx, member.workspaceId, args.channel, point.address, contact);
	const id =
		existing?._id ??
		(await ctx.db.insert("inboxConversations", {
			workspaceId: member.workspaceId,
			channel: args.channel,
			via: point.address,
			contact,
			...(subject && { subject }),
			...(who.agentId ? { mode: "agent" as const, agentId: who.agentId } : { mode: "staff" as const, takenBy: member.userId }),
			lastAt: Date.now(),
			preview: "",
		}));
	if (!existing) await linkCustomer(ctx, (await ctx.db.get(id))!, true);
	return replyAs(ctx, who, (await ctx.db.get(id))!, args.text);
}

/**
 * Gives a conversation to an agent (it answers from the next message), or to someone on staff who can
 * use Inbox (agents stop answering it). Either answers a hand-off, and says so in the conversation: a
 * line staff see ("Jaden assigned this to Maya").
 */
export async function assignTo(ctx: MutationCtx, who: Who, c: Doc<"inboxConversations">, to: Id<"agents"> | Id<"users">) {
	const { member, agentId } = who;
	checkPermission(member, "inbox.use");
	const answered = c.needsStaff === "handoff" && { needsStaff: undefined };
	const toAgent = ctx.db.normalizeId("agents", to);
	if (toAgent) {
		const agent = await requireLiveAgent(ctx, member, toAgent);
		await ctx.db.patch(c._id, { mode: "agent", agentId: agent._id, takenBy: undefined, ...answered });
	} else {
		const user = to as Id<"users">;
		const them = await memberOf(ctx, user, member.workspaceId);
		if (!them || !can(them, "inbox.use")) throw new ConvexError("They can't use Inbox. Pick someone whose role can.");
		await ctx.db.patch(c._id, { mode: "staff", takenBy: user, ...answered });
		const by = agentId ? ((await ctx.db.get(agentId))?.name ?? "An agent") : await nameOf(ctx, member.userId);
		await notify(ctx, c, [user], { kind: "assigned", text: `${by} assigned it to you`, actorUserId: member.userId, ...(agentId && { actorAgentId: agentId }), except: agentId ? undefined : member.userId });
	}
	await ctx.db.insert("inboxMessages", { workspaceId: c.workspaceId, conversationId: c._id, direction: "event", text: "", status: "sent", authorUserId: member.userId, ...(agentId && { authorAgentId: agentId }), assignedTo: toAgent ?? to });
}

const conversationWith = (ctx: QueryCtx, workspaceId: Id<"workspaces">, channel: InboxChannel, via: string, contact: string) =>
	ctx.db.query("inboxConversations").withIndex("by_contact", (q) => q.eq("workspaceId", workspaceId).eq("channel", channel).eq("via", via).eq("contact", contact)).first();

// ---- Incoming ----

/**
 * A message from outside, after its webhook's signature checked out (http.ts). Finds the workspace by the
 * address or number it was sent to, then the conversation with that contact (or starts one, answered by
 * the address's agent, else by staff), stores the message once however often it's delivered, links a
 * matching record, and has the agent answer unless staff have it. `automated`: an auto-reply or bulk mail, which the agent never answers (no loops).
 */
export const receive = internalMutation({
	args: {
		kind: v.union(v.literal("email"), v.literal("phone")),
		to: v.string(),
		from: v.string(),
		fromName: v.optional(v.string()),
		subject: v.optional(v.string()),
		text: v.string(),
		/** An email's quoted history, under `text` (core `splitQuoted`). */
		quoted: v.optional(v.string()),
		cc: v.optional(v.array(v.string())),
		providerId: v.string(),
		messageId: v.optional(v.string()),
		automated: v.optional(v.boolean()),
		/** Email whose sender didn't check out (core `senderVerified`). Texts come from the carrier, so never. */
		unverified: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<{ outcome: "stored" | "duplicate" | "unknown"; conversationId?: Id<"inboxConversations"> }> => {
		if (await ctx.db.query("inboxMessages").withIndex("by_provider", (q) => q.eq("providerId", args.providerId)).first()) return { outcome: "duplicate" };
		const to = args.kind === "email" ? normalizeEmail(args.to) : normalizePhone(args.to);
		const contact = args.kind === "email" ? normalizeEmail(args.from) : normalizePhone(args.from);
		if (!to || !contact) return { outcome: "unknown" };
		const point = await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", args.kind).eq("address", to)).first();
		if (point?.status !== "active" || !(await liveWorkspace(ctx, point.workspaceId))) return { outcome: "unknown" };
		// One agent writing to another (or to itself) would answer back and forth forever.
		const fromUs = !!(await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", args.kind).eq("address", contact)).first());
		const channel = channelOfKind(args.kind);
		const now = Date.now();
		const text = clipText(args.text.trim() || "(No text)");
		let c = await conversationWith(ctx, point.workspaceId, channel, point.address, contact);
		const isNew = !c;
		if (!c) {
			const subject = cleanSubject(args.subject);
			const answerer = point.agentId && (await ctx.db.get(point.agentId));
			const id = await ctx.db.insert("inboxConversations", {
				workspaceId: point.workspaceId,
				channel,
				via: point.address,
				contact,
				...(args.fromName && { contactName: args.fromName.slice(0, 100) }),
				...(subject && { subject }),
				...(answerer && !answerer.archived ? { mode: "agent" as const, agentId: answerer._id } : { mode: "staff" as const }),
				lastAt: now,
				preview: previewOf(text),
			});
			c = (await ctx.db.get(id))!;
		} else await ctx.db.patch(c._id, { lastAt: now, preview: previewOf(text), ...(args.fromName && !c.contactName && { contactName: args.fromName.slice(0, 100) }) });
		await ctx.db.insert("inboxMessages", {
			workspaceId: point.workspaceId,
			conversationId: c._id,
			direction: "in",
			text,
			status: "received",
			providerId: args.providerId,
			...(args.messageId && { messageId: args.messageId }),
			...(args.unverified && { unverified: true as const }),
			...(args.quoted && { quoted: clipText(args.quoted) }),
			...(args.cc?.length && { cc: args.cc.slice(0, 20) }),
		});
		await linkCustomer(ctx, c, isNew);
		if (!args.automated && !fromUs) await scheduleFill(ctx, (await ctx.db.get(c._id))!);
		const agent = await answeringAgent(ctx, c);
		if (agent && !args.automated && !fromUs) await queueReply(ctx, c);
		// Someone on staff answers this one: tell them (or, if it's nobody's, everyone who can).
		if (!agent && !args.automated && !fromUs) await notify(ctx, c, c.mode === "staff" && c.takenBy ? [c.takenBy] : "inbox", { kind: "message", text });
		// In-app events, so owners build their own steps ("when someone new texts, add a lead to Clients"). Never for
		// auto-replies or our own addresses (no loops). Runs act as the automation's person, never as Public.
		if (!args.automated && !fromUs) {
			const now = (await ctx.db.get(c._id))!;
			const data = {
				to: point.address,
				agent: agent?.name ?? null,
				by: channelWords[channel],
				from: contact,
				name: now.contactName ?? null,
				...(now.subject && { subject: now.subject }),
				text: text.slice(0, EVENT_TEXT_MAX),
				conversation: `#/inbox/${now._id}`,
				...(now.recordId && { record: now.recordId }),
				new: isNew,
			};
			if (isNew) await fireEvent(ctx, point.workspaceId, "inbox.started", { data });
			await fireEvent(ctx, point.workspaceId, "inbox.received", { data });
		}
		return { outcome: "stored", conversationId: c._id };
	},
});

/** Has the agent answer soon. One reply at a time per conversation: a message while one runs makes it go again after. */
export async function queueReply(ctx: MutationCtx, c: Doc<"inboxConversations">) {
	const now = Date.now();
	if (c.replyingSince && now - c.replyingSince < REPLY_STALE_MS) return void (await ctx.db.patch(c._id, { replyAgain: true }));
	await ctx.db.patch(c._id, { replyingSince: now, replyAgain: false });
	await ctx.scheduler.runAfter(REPLY_DELAY_MS, internal.inboxAgent.respond, { conversationId: c._id });
}

// ---- Outgoing ----

/** What sending one message needs: its conversation, our address or number, who wrote it, and the thread so far. */
export const outgoing = internalQuery({
	args: { messageId: v.id("inboxMessages") },
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "sending") return null;
		const c = await ctx.db.get(message.conversationId);
		if (!c || !(await liveWorkspace(ctx, c.workspaceId))) return null;
		const point = c.via ? await pointByAddress(ctx, c.workspaceId, kindOf(c.channel), c.via) : null;
		// Who wrote it: the agent (even when staff approved its draft), else the person.
		const writer = message.authorAgentId ? ((await ctx.db.get(message.authorAgentId))?.name ?? "Agent") : message.authorUserId ? await nameOf(ctx, message.authorUserId) : null;
		const business = (await ctx.db.get(c.workspaceId))?.name ?? "";
		const earlier = (await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(20)).filter((m) => m._id !== messageId);
		const ids = earlier.flatMap((m) => (m.messageId ? [m.messageId] : [])).reverse();
		// The email staff picked to answer, else their latest.
		const picked = message.answers && (await ctx.db.get(message.answers));
		const answering = picked?.messageId ?? earlier.find((m) => m.direction === "in" && m.messageId)?.messageId;
		return {
			text: message.text,
			channel: c.channel,
			to: c.contact,
			from: point?.status === "active" ? point.address : null,
			/** The From name: "Jaden from Acme", or the business alone. */
			fromName: writer && business ? `${writer} from ${business}` : writer || business,
			subject: earlier.some((m) => m.direction === "in") ? replySubject(c.subject) : cleanSubject(c.subject) || "Hello",
			references: referencesFor(ids, answering),
			answering,
		};
	},
});

/** A display name safe in a From header. */
const headerName = (name: string) => name.replace(/["\r\n<>\\]/g, "").trim().slice(0, 60) || "Companybot";

export const deliver = internalAction({
	args: { messageId: v.id("inboxMessages") },
	handler: async (ctx, { messageId }) => {
		const out = await ctx.runQuery(internal.inbox.outgoing, { messageId });
		if (!out) return;
		const fail = (error: string) => ctx.runMutation(internal.inbox.settle, { messageId, error });
		if (!out.from) return void (await fail(out.channel === "email" ? "This conversation's email address isn't the workspace's anymore." : "This conversation's phone number isn't the workspace's anymore."));
		try {
			if (out.channel === "email") {
				const provider = emailProvider();
				const domain = emailDomain();
				if (!provider || !domain) return void (await fail("Email isn't set up on this server."));
				const ownId = `<${crypto.randomUUID()}@${domain}>`;
				const sent = await provider.send({
					from: `"${headerName(out.fromName)}" <${out.from}>`,
					to: out.to,
					subject: out.subject,
					text: out.text,
					headers: { "Message-ID": ownId, ...(out.answering && { "In-Reply-To": out.answering }), ...(out.references.length && { References: out.references.join(" ") }) },
				});
				await ctx.runMutation(internal.inbox.settle, { messageId, providerId: sent.id, sentMessageId: ownId });
			} else {
				const provider = smsProvider();
				if (!provider) return void (await fail("Texting isn't set up on this server."));
				const sent = await provider.send({ from: out.from, to: out.to, text: out.text });
				await ctx.runMutation(internal.inbox.settle, { messageId, providerId: sent.id });
			}
		} catch (e) {
			await fail(e instanceof Error ? e.message.slice(0, 300) : String(e));
		}
	},
});

/** What the provider saw after a sent email left (Resend's delivery events, http.ts): delivered, bounced (with why), or marked as spam by them. */
export const delivered = internalMutation({
	args: { providerId: v.string(), event: v.union(v.literal("delivered"), v.literal("bounced"), v.literal("spam")), reason: v.optional(v.string()) },
	handler: async (ctx, { providerId, event, reason }) => {
		const message = await ctx.db.query("inboxMessages").withIndex("by_provider", (q) => q.eq("providerId", providerId)).first();
		if (!message || message.direction !== "out" || message.status !== "sent") return;
		const why = reason?.trim().replace(/\.$/, "").slice(0, 300);
		if (event === "bounced") await ctx.db.patch(message._id, { delivery: "bounced", error: `Their mail server didn't take it${why ? ` (${why})` : ""}. Check the address.` });
		else if (event === "spam") await ctx.db.patch(message._id, { delivery: "spam" });
		else if (!message.delivery) await ctx.db.patch(message._id, { delivery: "delivered" });
	},
});

/** Marks a message sent (with the provider's ids) or failed. */
export const settle = internalMutation({
	args: { messageId: v.id("inboxMessages"), providerId: v.optional(v.string()), sentMessageId: v.optional(v.string()), error: v.optional(v.string()) },
	handler: async (ctx, { messageId, providerId, sentMessageId, error }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "sending") return;
		await ctx.db.patch(messageId, error ? { status: "failed", error } : { status: "sent", ...(providerId && { providerId }), ...(sentMessageId && { messageId: sentMessageId }) });
	},
});
