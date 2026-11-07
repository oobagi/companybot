import { INBOX_HISTORY, gatewayCost, publicSwitches, publicToolNeeds, publicTools, publicTurnPrompt } from "@companybot/core";
import { generateText, isStepCount } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction, internalMutation } from "./_generated/server";
import { queueReply } from "./inbox";
import { notify } from "./notifications";
import { liveWorkspace } from "./lib";
import { sharedSummary } from "./publicPlaces";
import { recordUsage } from "./usage";

// An agent answering someone outside the workspace, as the Public role (core public-role.ts). This is
// not a chat turn: there's no member to act as, so it never gets a ToolContext, connectors, skills or
// memory. The model sees the agent's instructions, the conversation (what the customer wrote fenced as
// data, core `publicTurnPrompt`) and only the tools Public's abilities give, plus read and add tools for
// what owners shared with Public (core `publicTools`, backend publicPlaces.ts). Every call rechecks, as of
// now, that the workspace and agent are live, staff haven't taken the conversation, the ability is still on
// and the place is still shared, so an owner switching one off stops it mid-reply.

/** Model steps per reply: enough to take a message and answer. */
const STEPS = 4;
/** Agent replies a conversation gets per hour before it waits for staff: a safety net against reply loops. */
export const AGENT_REPLIES_PER_HOUR = 10;

/** What one reply needs, or null if it shouldn't run (staff have it, the agent or workspace went). */
export const begin = internalMutation({
	args: { conversationId: v.id("inboxConversations") },
	handler: async (ctx, { conversationId }) => {
		const c = await ctx.db.get(conversationId);
		if (!c) return null;
		const workspace = await liveWorkspace(ctx, c.workspaceId);
		const agent = await ctx.db.get(c.agentId);
		if (!workspace || !agent || agent.archived || c.mode !== "agent") {
			await ctx.db.patch(c._id, { replyingSince: undefined, replyAgain: false });
			return null;
		}
		const recent = await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(INBOX_HISTORY);
		const hourAgo = Date.now() - 60 * 60_000;
		if (recent.filter((m) => m.direction === "out" && m.authorAgentId && !m.authorUserId && m._creationTime > hourAgo).length >= AGENT_REPLIES_PER_HOUR) {
			await ctx.db.patch(c._id, { replyingSince: undefined, replyAgain: false, needsStaff: "handoff", mode: "staff" });
			await notify(ctx, c, "inbox", { kind: "handoff", text: `${agent.name} stopped answering after ${AGENT_REPLIES_PER_HOUR} replies in an hour. Someone needs to take it.`, actorAgentId: agent._id });
			return null;
		}
		await ctx.db.patch(c._id, { replyingSince: Date.now(), replyAgain: false });
		const history = recent
			.reverse()
			.flatMap((m) => (m.direction === "note" || m.status === "failed" ? [] : [{ direction: m.status === "draft" ? ("draft" as const) : m.direction === "in" ? ("in" as const) : ("out" as const), text: m.text, by: m.authorUserId ? "Someone on staff" : undefined }]));
		return {
			model: agent.model,
			abilities: publicSwitches(workspace.publicAbilities),
			shared: await sharedSummary(ctx, c.workspaceId),
			input: {
				business: workspace.name,
				agent: { name: agent.name, instructions: agent.instructions },
				channel: c.channel,
				contact: { name: c.contactName ?? null, address: c.contact },
				...(c.subject && { subject: c.subject }),
				history,
			},
		};
	},
});

export const respond = internalAction({
	args: { conversationId: v.id("inboxConversations") },
	handler: async (ctx, { conversationId }) => {
		const run = await ctx.runMutation(internal.inboxAgent.begin, { conversationId });
		if (!run) return;
		let costUsd = 0;
		try {
			const { instructions, prompt } = publicTurnPrompt({ ...run.input, abilities: run.abilities, shared: run.shared });
			const result = await generateText({
				model: run.model,
				instructions,
				prompt,
				tools: publicTools(run.abilities, run.shared, {
					act: (name, input) => ctx.runMutation(internal.inboxAgent.act, { conversationId, name, text: input.text }),
					shared: (input) => ctx.runQuery(internal.publicPlaces.shared, { conversationId, ...input }),
					readPage: (input) => ctx.runAction(internal.publicPlaces.readPage, { conversationId, ...input }),
					findRecords: (input) => ctx.runQuery(internal.publicPlaces.findRecords, { conversationId, ...input }),
					saveRecord: (input) => ctx.runMutation(internal.publicPlaces.saveRecord, { conversationId, ...input }),
				}),
				stopWhen: isStepCount(STEPS),
				providerOptions: { gateway: { caching: "auto" } },
				maxRetries: 1,
			});
			costUsd = result.steps.reduce((sum, s) => sum + gatewayCost(s.providerMetadata), 0);
		} catch (e) {
			console.error(`Inbox reply for ${conversationId} failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			await ctx.runMutation(internal.inboxAgent.end, { conversationId, model: run.model, costUsd });
		}
	},
});

/**
 * One tool call, checked as of now. Replies: at most one per run, sent at once only with `public.reply`,
 * else kept as a draft that staff send. Notes and hand-offs stay inside the workspace.
 */
export const act = internalMutation({
	args: { conversationId: v.id("inboxConversations"), name: v.union(v.literal("reply"), v.literal("take_message"), v.literal("hand_off")), text: v.string() },
	handler: async (ctx, { conversationId, name, text }): Promise<string> => {
		const c = await ctx.db.get(conversationId);
		const workspace = c && (await liveWorkspace(ctx, c.workspaceId));
		const agent = c && (await ctx.db.get(c.agentId));
		if (!c || !workspace || !agent || agent.archived) return "This conversation is gone. Stop.";
		if (c.mode !== "agent") return "Someone on staff has taken this conversation. Don't reply.";
		const abilities = publicSwitches(workspace.publicAbilities);
		const needs = publicToolNeeds[name];
		if (needs && !abilities.includes(needs)) return "That isn't allowed for customers any more.";
		const body = text.trim();
		if (!body) return "Nothing to send.";
		if (name === "reply") return replyFor(ctx, c, agent, body, abilities.includes("public.reply"));
		if (name === "take_message") {
			await note(ctx, c, agent._id, `Message for staff: ${body}`);
			await notify(ctx, c, "inbox", { kind: "note", text: `${agent.name} took a message: ${body}`, actorAgentId: agent._id });
			return "Noted for staff.";
		}
		await note(ctx, c, agent._id, `Handed off: ${body}`);
		await ctx.db.patch(c._id, { mode: "staff", needsStaff: "handoff" });
		await notify(ctx, c, "inbox", { kind: "handoff", text: `${agent.name} handed it to staff: ${body}`, actorAgentId: agent._id });
		return "Handed to staff. Don't reply again.";
	},
});

async function note(ctx: MutationCtx, c: Doc<"inboxConversations">, agentId: Id<"agents">, text: string) {
	await ctx.db.insert("inboxMessages", { workspaceId: c.workspaceId, conversationId: c._id, direction: "note", text: text.slice(0, 2_500), status: "sent", authorAgentId: agentId });
}

async function replyFor(ctx: MutationCtx, c: Doc<"inboxConversations">, agent: Doc<"agents">, text: string, onItsOwn: boolean) {
	const since = c.replyingSince ?? Date.now();
	const already = (await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(10)).some(
		(m) => m.authorAgentId === agent._id && !m.authorUserId && m.direction === "out" && m._creationTime >= since,
	);
	if (already) return "You've already replied this time. Stop.";
	const id = await ctx.db.insert("inboxMessages", { workspaceId: c.workspaceId, conversationId: c._id, direction: "out", text: text.slice(0, c.channel === "sms" ? 1_600 : 20_000), status: onItsOwn ? "sending" : "draft", authorAgentId: agent._id });
	if (onItsOwn) {
		await ctx.db.patch(c._id, { lastAt: Date.now(), preview: text.replace(/\s+/g, " ").slice(0, 140) });
		await ctx.scheduler.runAfter(0, internal.inbox.deliver, { messageId: id });
		return "Sent.";
	}
	await ctx.db.patch(c._id, { needsStaff: "draft" });
	await notify(ctx, c, "inbox", { kind: "draft", text: `${agent.name} wrote a reply for you to check`, actorAgentId: agent._id });
	return "Saved for staff to check and send. Don't say it was sent.";
}

/** Records what the reply cost (the agent's, run for nobody on the team) and runs again for messages that came meanwhile. */
export const end = internalMutation({
	args: { conversationId: v.id("inboxConversations"), model: v.string(), costUsd: v.number() },
	handler: async (ctx, { conversationId, model, costUsd }) => {
		const c = await ctx.db.get(conversationId);
		if (!c) return;
		await recordUsage(ctx, { workspaceId: c.workspaceId, agentId: c.agentId, kind: "chat", model, costUsd });
		const again = c.replyAgain && c.mode === "agent";
		await ctx.db.patch(c._id, { replyingSince: undefined, replyAgain: false });
		if (again) await queueReply(ctx, { ...c, replyingSince: undefined });
	},
});
