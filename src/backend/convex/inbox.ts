import {
	type Field,
	type InboxChannel,
	INBOX_TEXT_MAX,
	SMS_TEXT_MAX,
	channelWords,
	clipText,
	cleanSubject,
	indexEntries,
	isEmail,
	normalizeEmail,
	normalizePhone,
	phoneKeys,
	referencesFor,
	replySubject,
	can,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { fireEvent } from "./automationRuns";
import { emailDomain, emailProvider, SmsRejectedError, smsProvider, smsStatusUrl } from "./channelProviders";
import { namer } from "./chatOps";
import { callContact, callData, callPreview } from "./callData";
import { commentsOf } from "./inboxComments";
import { notify } from "./notifications";
import { mutation, query } from "./functions";
import { type Member, type Who, checkPermission, getMember, liveWorkspace, memberOf, nameOf, requireInWorkspace, requireLiveAgent, requirePermission } from "./lib";
import { typeVisible } from "./recordOps";

// Inbox: conversations with people outside the workspace, by email and text. Each agent's address and
// number (contactPoints.ts) take messages in through webhooks (http.ts → `receive`), one conversation per
// outside contact per channel per agent, linked to the record whose email or phone field matches. The
// agent answers as Public (inboxAgent.ts); staff with inbox.use watch, reply, take over and hand back.
// A short "New conversation from …" can go to a channel picked on the agent; the conversation stays here.
// wiki/architecture.md → Inbox.

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
export async function recordShown(ctx: QueryCtx, member: Member, recordId: Id<"records"> | undefined, visible = typeVisible(ctx, member)) {
	const record = recordId && (await ctx.db.get(recordId));
	if (!record || record.workspaceId !== member.workspaceId || record.archived || !(await visible(record.typeId))) return null;
	const type = await ctx.db.get(record.typeId);
	return type && !type.archived ? { id: record._id, title: record.title, typeKey: type.key } : null;
}

const agentName = async (ctx: QueryCtx, agentId: Id<"agents">) => (await ctx.db.get(agentId))?.name ?? "Agent";

/** Conversations, the latest first. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !can(member, "inbox.use")) return null;
		const rows = await ctx.db.query("inboxConversations").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).order("desc").take(READ_MAX);
		const visible = typeVisible(ctx, member);
		const names = new Map<Id<"agents">, string>();
		const people = namer(ctx, { images: true });
		return Promise.all(
			rows.map(async (c) => {
				if (!names.has(c.agentId)) names.set(c.agentId, await agentName(ctx, c.agentId));
				const record = await recordShown(ctx, member, c.recordId, visible);
				const contact = c.channel === "call" ? callContact(c, record) : null;
				const latestCall = contact ? await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").first() : null;
				return {
					/** Who answers it, with their picture: its agent, or who on staff it's assigned to. */
					assignee: c.mode === "agent" ? await people.agent(c.agentId) : c.takenBy ? await people.user(c.takenBy) : null,
					id: c._id,
					agentId: c.agentId,
					agentName: names.get(c.agentId)!,
					channel: c.channel,
					contact: c.contact,
					contactName: contact?.displayName ?? c.contactName ?? null,
					...(contact && { displayName: contact.displayName, number: contact.number, formattedNumber: contact.formattedNumber, recordName: contact.recordName }),
					subject: c.subject ?? null,
					mode: c.mode,
					/** Assigned to you, on staff. */
					mine: c.mode === "staff" && c.takenBy === member.userId,
					needsStaff: c.needsStaff ?? null,
					lastAt: c.lastAt,
					preview: latestCall?.call ? callPreview(latestCall) : c.preview,
					record,
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
		const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", c.agentId).eq("kind", kindOf(c.channel))).first();
		const record = await recordShown(ctx, member, c.recordId);
		const contact = c.channel === "call" ? callContact(c, record) : null;
		return {
			id: c._id,
			agentId: c.agentId,
			agentName: await agentName(ctx, c.agentId),
			agent: await names.agent(c.agentId),
			channel: c.channel,
			contact: c.contact,
			contactName: contact?.displayName ?? c.contactName ?? null,
			...(contact && { displayName: contact.displayName, number: contact.number, formattedNumber: contact.formattedNumber, recordName: contact.recordName }),
			subject: c.subject ?? null,
			mode: c.mode,
			/** Who has it, while staff do: a person, with their picture. */
			takenBy: c.takenBy ? await names.user(c.takenBy) : null,
			needsStaff: c.needsStaff ?? null,
			replying: !!c.replyingSince && Date.now() - c.replyingSince < REPLY_STALE_MS,
			/** The agent's address or number it goes from; null once removed (replies can't go out). */
			from: point?.status === "active" ? point.address : null,
			record,
			messages: await Promise.all(
				messages.map(async (m) => {
					const author = m.authorAgentId || m.authorUserId ? await names.of({ authorAgentId: m.authorAgentId, authorUserId: m.authorAgentId ? undefined : m.authorUserId, actingFor: m.authorAgentId ? m.authorUserId : undefined }) : null;
					return {
						id: m._id,
						at: m._creationTime,
						direction: m.direction,
						status: m.status,
						call: m.call ? { ...callData(m), ...callContact(c, record) } : null,
						sms: m.sms?.state ?? null,
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
						assignedTo: m.assignedTo === undefined ? null : m.assignedTo === "agent" ? await names.agent(c.agentId) : await names.user(m.assignedTo),
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
	args: { agentId: v.id("agents"), channel: v.union(v.literal("email"), v.literal("sms")), to: v.string(), subject: v.optional(v.string()), text: v.string() },
	handler: async (ctx, args) => startAs(ctx, { member: await requirePermission(ctx, "inbox.use") }, args),
});

/** Who answers it: its agent, or someone on staff (the agent stops answering). */
export const assign = mutation({
	args: { id: v.id("inboxConversations"), to: v.union(v.literal("agent"), v.id("users")) },
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
		await ctx.db.patch(draft._id, { text: checkedText(c.channel, text), status: "sending", authorUserId: member.userId, ...(await smsSender(ctx, c)) });
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

/** Freeze the approved sender. Removing and replacing a number must never reroute a queued text. */
export async function smsSender(ctx: MutationCtx, c: Doc<"inboxConversations">) {
	if (c.channel !== "sms") return {};
	const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", c.agentId).eq("kind", "phone")).first();
	if (point?.status !== "active") throw new ConvexError("The agent no longer has a phone number.");
	return { sms: { contactPointId: point._id, from: point.address, token: crypto.randomUUID() } };
}

/** Staff (or an agent for them) answer in a conversation: it goes out at once from the agent's address or number. */
export async function replyAs(ctx: MutationCtx, who: Who, c: Doc<"inboxConversations">, text: string, answers?: Id<"inboxMessages">) {
	checkPermission(who.member, "inbox.use");
	if (c.channel === "call") throw new ConvexError("Use the dialer to call this person.");
	const body = checkedText(c.channel, text);
	const answered = answers && (await ctx.db.get(answers));
	if (answers && (c.channel !== "email" || answered?.conversationId !== c._id || answered.direction === "event")) throw new ConvexError("That email isn't in this conversation.");
	const id = await ctx.db.insert("inboxMessages", {
		workspaceId: c.workspaceId,
		conversationId: c._id,
		direction: "out",
		text: body,
		status: "sending",
		...(await smsSender(ctx, c)),
		authorUserId: who.member.userId,
		...(who.agentId && { authorAgentId: who.agentId }),
		...(answers && { answers }),
	});
	await ctx.db.patch(c._id, { lastAt: Date.now(), preview: previewOf(body) });
	await ctx.scheduler.runAfter(0, internal.inbox.deliver, { messageId: id });
	return { conversationId: c._id, messageId: id };
}

/**
 * Starts (or continues) a conversation from an agent's address or number. Started by a person, it's theirs:
 * the agent stays out until someone hands it back. Started by an agent for someone, the agent answers replies.
 */
export async function startAs(ctx: MutationCtx, who: Who, args: { agentId: Id<"agents">; channel: InboxChannel; to: string; subject?: string; text: string }) {
	const { member } = who;
	checkPermission(member, "inbox.use");
	const agent = await requireLiveAgent(ctx, member, args.agentId);
	const contact = args.channel === "email" ? (isEmail(args.to) ? normalizeEmail(args.to) : null) : normalizePhone(args.to);
	if (!contact) throw new ConvexError(args.channel === "email" ? `${args.to} isn't an email address.` : `${args.to} isn't a phone number. Include its country code, like +1.`);
	const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", agent._id).eq("kind", kindOf(args.channel))).first();
	if (point?.status !== "active") throw new ConvexError(args.channel === "email" ? `${agent.name} has no email address yet. Add one on its page.` : `${agent.name} has no phone number yet. Add one on its page.`);
	if (contact === point.address) throw new ConvexError("That's the agent's own address.");
	const subject = cleanSubject(args.subject);
	if (args.channel === "email" && !subject) throw new ConvexError("Give the email a subject.");
	const existing = await conversationWith(ctx, member.workspaceId, agent._id, args.channel, contact);
	const id =
		existing?._id ??
		(await ctx.db.insert("inboxConversations", {
			workspaceId: member.workspaceId,
			agentId: agent._id,
			channel: args.channel,
			contact,
			...(subject && { subject }),
			mode: who.agentId ? "agent" : "staff",
			...(!who.agentId && { takenBy: member.userId }),
			lastAt: Date.now(),
			preview: "",
		}));
	if (!existing) await linkRecord(ctx, (await ctx.db.get(id))!);
	return replyAs(ctx, who, (await ctx.db.get(id))!, args.text);
}

/**
 * Gives a conversation to its agent, or to someone on staff who can use Inbox (the agent stops
 * answering it). Either answers a hand-off.
 */
/** Assigns it, and says so in the conversation: a line staff see ("Jaden assigned this to Maya"). */
export async function assignTo(ctx: MutationCtx, who: Who, c: Doc<"inboxConversations">, to: "agent" | Id<"users">) {
	const { member, agentId } = who;
	checkPermission(member, "inbox.use");
	const answered = c.needsStaff === "handoff" && { needsStaff: undefined };
	if (to === "agent") {
		if (c.channel === "call") throw new ConvexError("Agent voice is coming soon. Assign calls to staff.");
		if (!(await ctx.db.get(c.agentId))) throw new ConvexError("Its agent was deleted. Someone on staff answers this one.");
		await ctx.db.patch(c._id, { mode: "agent", takenBy: undefined, ...answered });
	} else {
		const them = await memberOf(ctx, to, member.workspaceId);
		if (!them || !can(them, "inbox.use")) throw new ConvexError("They can't use Inbox. Pick someone whose role can.");
		await ctx.db.patch(c._id, { mode: "staff", takenBy: to, ...answered });
		const by = agentId ? ((await ctx.db.get(agentId))?.name ?? "An agent") : await nameOf(ctx, member.userId);
		await notify(ctx, c, [to], { kind: "assigned", text: `${by} assigned it to you`, actorUserId: member.userId, ...(agentId && { actorAgentId: agentId }), except: agentId ? undefined : member.userId });
	}
	await ctx.db.insert("inboxMessages", { workspaceId: c.workspaceId, conversationId: c._id, direction: "event", text: "", status: "sent", authorUserId: member.userId, ...(agentId && { authorAgentId: agentId }), assignedTo: to });
}

export const conversationWith = (ctx: QueryCtx, workspaceId: Id<"workspaces">, agentId: Id<"agents">, channel: InboxChannel, contact: string) =>
	ctx.db.query("inboxConversations").withIndex("by_contact", (q) => q.eq("workspaceId", workspaceId).eq("agentId", agentId).eq("channel", channel).eq("contact", contact)).first();

// ---- Record matching ----

/**
 * The live record whose email field (for email) or phone field (for texts) holds this contact, if any: the
 * first found across the workspace's databases. One indexed lookup per field of that kind, so it stays small
 * however many records there are. Records index emails case-insensitively and phones as digits
 * (core records.ts `indexEntries`); a US number matches with or without its country code.
 */
export async function matchRecord(ctx: QueryCtx, workspaceId: Id<"workspaces">, channel: InboxChannel, contact: string) {
	const kind = channel === "email" ? "email" : "phone";
	const keys = kind === "email" ? indexEntries({ kind } as Field, contact).flatMap((e) => ("str" in e && e.str ? [e.str] : [])) : phoneKeys(contact);
	const types = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(200);
	for (const type of types) {
		if (type.archived) continue;
		const fields = await ctx.db.query("recordFields").withIndex("by_type_kind", (q) => q.eq("typeId", type._id).eq("kind", kind)).take(20);
		for (const field of fields) {
			if (field.archived) continue;
			for (const key of keys) {
				const values = await ctx.db.query("recordValues").withIndex("by_field_str", (q) => q.eq("fieldId", field._id).eq("str", key)).take(5);
				for (const value of values) {
					const record = await ctx.db.get(value.recordId);
					if (record && !record.archived) return record._id;
				}
			}
		}
	}
	return null;
}

export async function linkRecord(ctx: MutationCtx, c: Doc<"inboxConversations">) {
	if (c.recordId) return;
	const recordId = await matchRecord(ctx, c.workspaceId, c.channel, c.contact);
	if (recordId) await ctx.db.patch(c._id, { recordId });
}

// ---- Incoming ----

/**
 * A message from outside, after its webhook's signature checked out (http.ts). Finds the agent by the
 * address or number it was sent to, then the conversation with that contact (or starts one, announcing it),
 * stores the message once however often it's delivered, links a matching record, and has the agent answer
 * unless staff have it. `automated`: an auto-reply or bulk mail, which the agent never answers (no loops).
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
		const agent = point && (await ctx.db.get(point.agentId));
		if (point?.status !== "active" || !agent || !(await liveWorkspace(ctx, point.workspaceId))) return { outcome: "unknown" };
		// One agent writing to another (or to itself) would answer back and forth forever.
		const fromUs = !!(await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", args.kind).eq("address", contact)).first());
		const channel = channelOfKind(args.kind);
		const now = Date.now();
		const text = clipText(args.text.trim() || "(No text)");
		let c = await conversationWith(ctx, point.workspaceId, agent._id, channel, contact);
		const isNew = !c;
		if (!c) {
			const subject = cleanSubject(args.subject);
			const id = await ctx.db.insert("inboxConversations", {
				workspaceId: point.workspaceId,
				agentId: agent._id,
				channel,
				contact,
				...(args.fromName && { contactName: args.fromName.slice(0, 100) }),
				...(subject && { subject }),
				mode: "agent",
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
		await linkRecord(ctx, c);
		if (c.mode === "agent" && !agent.archived && !args.automated && !fromUs) await queueReply(ctx, c);
		// Someone on staff answers this one: tell them (or, if it's nobody's, everyone who can).
		if (c.mode === "staff" && !args.automated && !fromUs) await notify(ctx, c, c.takenBy ? [c.takenBy] : "inbox", { kind: "message", text });
		// In-app events, so owners build their own steps ("when someone new texts, add a lead to Clients"). Never for
		// auto-replies or our own addresses (no loops). Runs act as the automation's person, never as Public.
		if (!args.automated && !fromUs) {
			const now = (await ctx.db.get(c._id))!;
			const data = {
				agent: agent.name,
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

/** What sending one message needs: its conversation, the agent's address or number, and the thread so far. */
export const outgoing = internalQuery({
	args: { messageId: v.id("inboxMessages") },
	handler: async (ctx, { messageId }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "sending") return null;
		const c = await ctx.db.get(message.conversationId);
		if (!c || !(await liveWorkspace(ctx, c.workspaceId))) return null;
		const agent = await ctx.db.get(c.agentId);
		const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", c.agentId).eq("kind", kindOf(c.channel))).first();
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
			agentName: agent?.name ?? "Companybot",
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
		if (out.channel === "sms") {
			const text = await ctx.runMutation(internal.inbox.claimSms, { messageId });
			if (!text) return;
			const provider = smsProvider();
			if (!provider) return void (await ctx.runMutation(internal.inbox.smsSettled, { messageId, state: "failed", error: "Texting isn't set up on this server." }));
			try {
				const sent = await provider.send({ from: text.from, to: text.to, text: text.text, statusUrl: smsStatusUrl(messageId, text.token) });
				await ctx.runMutation(internal.inbox.smsSettled, { messageId, providerId: sent.id, state: sent.status });
			} catch (e) {
				await ctx.runMutation(internal.inbox.smsSettled, { messageId, state: e instanceof SmsRejectedError ? "failed" : "unknown", ...(e instanceof SmsRejectedError && { error: e.message }) });
			}
			return;
		}
		const fail = (error: string) => ctx.runMutation(internal.inbox.settle, { messageId, error });
		if (!out.from) return void (await fail(out.channel === "email" ? "The agent no longer has an email address." : "The agent no longer has a phone number."));
		try {
			if (out.channel === "email") {
				const provider = emailProvider();
				const domain = emailDomain();
				if (!provider || !domain) return void (await fail("Email isn't set up on this server."));
				const ownId = `<${crypto.randomUUID()}@${domain}>`;
				const sent = await provider.send({
					from: `"${headerName(out.agentName)}" <${out.from}>`,
					to: out.to,
					subject: out.subject,
					text: out.text,
					headers: { "Message-ID": ownId, ...(out.answering && { "In-Reply-To": out.answering }), ...(out.references.length && { References: out.references.join(" ") }) },
				});
				await ctx.runMutation(internal.inbox.settle, { messageId, providerId: sent.id, sentMessageId: ownId });
			}
		} catch (e) {
			await fail(e instanceof Error ? e.message.slice(0, 300) : String(e));
		}
	},
});

/** Claim before the paid POST. Concurrent workers and crashed actions never repeat a text. */
export const claimSms = internalMutation({
	args: { messageId: v.id("inboxMessages") },
	handler: async (ctx, { messageId }): Promise<{ from: string; to: string; text: string; token: string } | null> => {
		const m = await ctx.db.get(messageId);
		if (!m || m.direction !== "out" || m.status !== "sending" || m.sms?.dispatchedAt !== undefined) return null;
		const c = await ctx.db.get(m.conversationId);
		if (!c || c.channel !== "sms" || c.workspaceId !== m.workspaceId || !(await liveWorkspace(ctx, c.workspaceId))) return null;
		const agent = await ctx.db.get(c.agentId);
		const point = m.sms && await ctx.db.get(m.sms.contactPointId);
		const member = m.authorUserId && await memberOf(ctx, m.authorUserId, c.workspaceId);
		const author = m.authorAgentId && await ctx.db.get(m.authorAgentId);
		let error: string | undefined;
		if (!agent || agent.archived || (m.authorAgentId && (!author || author.archived))) error = "The agent is no longer available.";
		else if (m.authorUserId && (!member || !can(member, "inbox.use"))) error = "The sender no longer has permission to use Inbox.";
		else if (!m.authorUserId && (c.mode !== "agent" || agent.customerReplies !== "send")) error = "Staff must check this reply before it can be sent.";
		else if (!point || point.status !== "active" || point.kind !== "phone" || point.agentId !== c.agentId || point.workspaceId !== c.workspaceId || point.address !== m.sms?.from) error = "The phone number changed or was released. Review and send a new text.";
		if (error || !m.sms) {
			await ctx.db.patch(m._id, { status: "failed", error: error ?? "Review and send a new text from the agent's current number." });
			return null;
		}
		await ctx.db.patch(m._id, { sms: { ...m.sms, dispatchedAt: Date.now() } });
		await ctx.scheduler.runAfter(60_000, internal.inbox.smsSettled, { messageId, state: "unknown" });
		return { from: m.sms.from, to: c.contact, text: m.text, token: m.sms.token };
	},
});

type SmsState = NonNullable<NonNullable<Doc<"inboxMessages">["sms"]>["state"]>;
const smsState = (value: string): SmsState | null => {
	if (["accepted", "sending", "sent"].includes(value)) return "queued";
	if (value === "undelivered") return "failed";
	return ["queued", "delivered", "failed", "unknown"].includes(value) ? value as SmsState : null;
};

/** Both REST responses and signed receipts use this path. Early callbacks win over late REST responses. */
async function settleSms(ctx: MutationCtx, m: Doc<"inboxMessages">, state: SmsState, providerId?: string, error?: string) {
	if (!m.sms || m.sms.dispatchedAt === undefined || m.direction !== "out") return;
	const c = await ctx.db.get(m.conversationId);
	if (!c || c.channel !== "sms" || c.workspaceId !== m.workspaceId || !(await liveWorkspace(ctx, m.workspaceId))) return;
	if (m.providerId && providerId && m.providerId !== providerId) return;
	const old = m.sms.state;
	if ((old === "delivered" || old === "failed") || old === state || (old && old !== "unknown" && state === "unknown")) return;
	await ctx.db.patch(m._id, {
		sms: { ...m.sms, state },
		status: ["failed", "unknown"].includes(state) ? "failed" : "sent",
		...(providerId && { providerId }),
		error: state === "unknown" ? "Delivery is unknown. Check the phone company's message log before sending again." : state === "failed" ? error ?? "The phone company couldn't deliver this text." : undefined,
	});
}

export const smsSettled = internalMutation({
	args: { messageId: v.id("inboxMessages"), state: v.string(), providerId: v.optional(v.string()), error: v.optional(v.string()) },
	handler: async (ctx, { messageId, state, providerId, error }) => {
		const m = await ctx.db.get(messageId);
		if (m) await settleSms(ctx, m, smsState(state) ?? "unknown", providerId, error);
	},
});

/** A signed callback names this exact attempt, account and pair of numbers, even before REST returns. */
export const smsReceipt = internalMutation({
	args: { messageId: v.string(), token: v.string(), providerId: v.string(), from: v.string(), to: v.string(), state: v.string(), errorCode: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const id = ctx.db.normalizeId("inboxMessages", args.messageId);
		const m = id && await ctx.db.get(id);
		const c = m && await ctx.db.get(m.conversationId);
		const state = smsState(args.state);
		if (!m?.sms || !c || m.sms.token !== args.token || m.sms.from !== args.from || c.contact !== args.to || !state || state === "unknown") return;
		const error = args.errorCode && /^\d{3,6}$/.test(args.errorCode) ? `The phone company couldn't deliver this text (Twilio ${args.errorCode}). Check its message log before sending again.` : undefined;
		await settleSms(ctx, m, state, args.providerId, error);
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
