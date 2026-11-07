import {
	type Field,
	type InboxChannel,
	INBOX_TEXT_MAX,
	SMS_TEXT_MAX,
	channelWords,
	clipText,
	cleanSubject,
	formatPhone,
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
import { emailDomain, emailProvider, smsProvider } from "./channelProviders";
import { insertMessage, namer } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, type Who, checkPermission, getMember, liveWorkspace, memberOf, requireInWorkspace, requireLiveAgent, requirePermission } from "./lib";
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
/** Someone outside's name, safe to put in a chat line: one line, no Markdown that could make a link. */
const plain = (text: string) => text.replace(/[[\]()*_`<>#\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const contactWords = (c: Pick<Doc<"inboxConversations">, "channel" | "contact" | "contactName">) =>
	c.contactName ? `${plain(c.contactName)} (${c.channel === "sms" ? formatPhone(c.contact) : c.contact})` : c.channel === "sms" ? formatPhone(c.contact) : c.contact;

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
		return Promise.all(
			rows.map(async (c) => {
				if (!names.has(c.agentId)) names.set(c.agentId, await agentName(ctx, c.agentId));
				return {
					id: c._id,
					agentId: c.agentId,
					agentName: names.get(c.agentId)!,
					channel: c.channel,
					contact: c.contact,
					contactName: c.contactName ?? null,
					subject: c.subject ?? null,
					mode: c.mode,
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
		const point = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", c.agentId).eq("kind", kindOf(c.channel))).first();
		return {
			id: c._id,
			agentId: c.agentId,
			agentName: await agentName(ctx, c.agentId),
			agent: await names.agent(c.agentId),
			channel: c.channel,
			contact: c.contact,
			contactName: c.contactName ?? null,
			subject: c.subject ?? null,
			mode: c.mode,
			/** Who has it, while staff do: a person, with their picture. */
			takenBy: c.takenBy ? await names.user(c.takenBy) : null,
			needsStaff: c.needsStaff ?? null,
			replying: !!c.replyingSince && Date.now() - c.replyingSince < REPLY_STALE_MS,
			/** The agent's address or number it goes from; null once removed (replies can't go out). */
			from: point?.status === "active" ? point.address : null,
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
						error: m.error ?? null,
						/** Who wrote it on our side (someone on staff, or the agent, `for` the person it acted for); null for theirs. */
						author,
					};
				}),
			),
		};
	},
});

// ---- What staff do (and agents, for them: inbox.manage) ----

export const reply = mutation({
	args: { id: v.id("inboxConversations"), text: v.string() },
	handler: async (ctx, { id, text }) => {
		const member = await requirePermission(ctx, "inbox.use");
		return replyAs(ctx, { member }, await requireConversation(ctx, member, id), text);
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
		await assignTo(ctx, member, await requireConversation(ctx, member, id), to);
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

/** Staff (or an agent for them) answer in a conversation: it goes out at once from the agent's address or number. */
export async function replyAs(ctx: MutationCtx, who: Who, c: Doc<"inboxConversations">, text: string) {
	checkPermission(who.member, "inbox.use");
	const body = checkedText(c.channel, text);
	const id = await ctx.db.insert("inboxMessages", {
		workspaceId: c.workspaceId,
		conversationId: c._id,
		direction: "out",
		text: body,
		status: "sending",
		authorUserId: who.member.userId,
		...(who.agentId && { authorAgentId: who.agentId }),
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
export async function assignTo(ctx: MutationCtx, member: Member, c: Doc<"inboxConversations">, to: "agent" | Id<"users">) {
	checkPermission(member, "inbox.use");
	const answered = c.needsStaff === "handoff" && { needsStaff: undefined };
	if (to === "agent") {
		if (!(await ctx.db.get(c.agentId))) throw new ConvexError("Its agent was deleted. Someone on staff answers this one.");
		await ctx.db.patch(c._id, { mode: "agent", takenBy: undefined, ...answered });
		return;
	}
	const them = await memberOf(ctx, to, member.workspaceId);
	if (!them || !can(them, "inbox.use")) throw new ConvexError("They can't use Inbox. Pick someone whose role can.");
	await ctx.db.patch(c._id, { mode: "staff", takenBy: to, ...answered });
}

const conversationWith = (ctx: QueryCtx, workspaceId: Id<"workspaces">, agentId: Id<"agents">, channel: InboxChannel, contact: string) =>
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

async function linkRecord(ctx: MutationCtx, c: Doc<"inboxConversations">) {
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
		});
		await linkRecord(ctx, c);
		if (isNew) await announce(ctx, agent, c, `New conversation from ${contactWords(c)} by ${channelWords[channel]}.`);
		if (c.mode === "agent" && !agent.archived && !args.automated && !fromUs) await queueReply(ctx, c);
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

/** A line in the agent's announcement channel, as the agent, linking to the conversation. Nothing if none is picked or it's gone. */
export async function announce(ctx: MutationCtx, agent: Doc<"agents">, c: Doc<"inboxConversations">, line: string) {
	if (!agent.announceChatId || agent.archived) return;
	const chat = await ctx.db.get(agent.announceChatId);
	if (!chat || chat.archived || chat.workspaceId !== c.workspaceId) return;
	const text = `${line} [Open in Inbox](#/inbox/${c._id})`;
	await insertMessage(ctx, chat, { authorAgentId: agent._id, text, parts: [{ type: "text", text }], mentions: { userIds: [], agentIds: [] }, status: "done" });
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
		const answering = earlier.find((m) => m.direction === "in" && m.messageId)?.messageId;
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

/** Marks a message sent (with the provider's ids) or failed. */
export const settle = internalMutation({
	args: { messageId: v.id("inboxMessages"), providerId: v.optional(v.string()), sentMessageId: v.optional(v.string()), error: v.optional(v.string()) },
	handler: async (ctx, { messageId, providerId, sentMessageId, error }) => {
		const message = await ctx.db.get(messageId);
		if (message?.status !== "sending") return;
		await ctx.db.patch(messageId, error ? { status: "failed", error } : { status: "sent", ...(providerId && { providerId }), ...(sentMessageId && { messageId: sentMessageId }) });
	},
});
