import { type AppEvent, type Automation, parseWebhookBody, sampleData, scheduleDue, triggerPrompt, webhookMismatch } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation } from "./functions";
import { addToChat, canSee, findOrCreateDm, insertMessage } from "./chatOps";
import { memberOf, nameOf, normalizeEmail } from "./lib";
import { audienceOf, definitionOf, postingProblem, requireEditable, subscribersOf } from "./automationOps";
import { enqueueTurn } from "./turns";

/** Runs it once now, just for you (webhooks and events use a sample), so you can see what it does. */
export const runNow = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const { member, install } = await requireEditable(ctx, automationId);
		const automation = await definitionOf(ctx, install);
		if (!automation) throw new ConvexError("Install it first.");
		const result = await runInDms(ctx, install, automation, [member.userId], triggerPrompt(automation, sampleData(automation.trigger)));
		if (!result.ran) throw new ConvexError(result.summary);
	},
});

// ---- Internal: triggers ----

/** Runs every few minutes (crons.ts): starts the scheduled automations that are due. */
export const tick = internalMutation({
	/** `now` is for tests: faking Date doesn't reach functions run by convex-test. */
	args: { now: v.optional(v.number()) },
	handler: async (ctx, { now = Date.now() }) => {
		const installs = await ctx.db
			.query("automationInstalls")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.collect();
		for (const install of installs) {
			const automation = await definitionOf(ctx, install);
			if (!automation) continue;
			const due = scheduleDue(automation.trigger, now, install.timeZone, install.lastRunDate);
			if (!due) continue;
			await ctx.db.patch(install._id, { lastRunDate: due });
			await runFor(ctx, install, automation, automation.prompt, {});
		}
	},
});

/**
 * A webhook delivery (http.ts): runs the automation whose URL this is. Repeats of an
 * event id are ignored, so senders can retry safely. Returns the HTTP reply.
 */
export const receive = internalMutation({
	args: { token: v.string(), body: v.string() },
	handler: async (ctx, { token, body }): Promise<{ status: number; ok: boolean; message: string }> => {
		const install = token
			? await ctx.db
					.query("automationInstalls")
					.withIndex("by_webhook", (q) => q.eq("webhookToken", token))
					.first()
			: null;
		const automation = install && (await definitionOf(ctx, install));
		if (!install || automation?.trigger.type !== "webhook") return { status: 404, ok: false, message: "Unknown webhook URL." };
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			return { status: 400, ok: false, message: "Body isn't JSON." };
		}
		const delivery = parseWebhookBody(json);
		if (typeof delivery === "string") return { status: 400, ok: false, message: delivery };
		const mismatch = webhookMismatch(automation.trigger, delivery.event);
		if (mismatch) return { status: 400, ok: false, message: mismatch };
		if (!install.enabled) return { status: 200, ok: true, message: "Not run: the automation is off." };

		const seen = await ctx.db
			.query("automationEvents")
			.withIndex("by_install", (q) => q.eq("installId", install._id).eq("eventId", delivery.id))
			.first();
		if (seen) return { status: 200, ok: true, message: "Already received." };
		await ctx.db.insert("automationEvents", { installId: install._id, eventId: delivery.id });

		let person: Id<"users"> | undefined;
		if (delivery.person) {
			const found = await workspaceUserByEmail(ctx, install.workspaceId, delivery.person.email);
			if (!found && audienceOf(install) === "subscribers")
				return { status: 200, ok: true, message: await finish(ctx, install, `Didn't run: nobody here has the email ${delivery.person.email}.`) };
			person = found ?? undefined;
		}
		const result = await runFor(ctx, install, automation, triggerPrompt(automation, delivery.data), { person });
		return { status: 200, ok: true, message: result.summary };
	},
});

/**
 * Something happened in the app: runs the workspace's enabled automations that watch for
 * it. Called from where it happens (messages.send, workspace joins). `data` reaches the
 * agent fenced as data; `channelId` and `messageId` say where a message was posted.
 */
export async function fireEvent(
	ctx: MutationCtx,
	workspaceId: Id<"workspaces">,
	event: AppEvent,
	details: { data: Record<string, unknown>; channelId?: Id<"chats">; messageId?: Id<"chatMessages"> },
) {
	const installs = await ctx.db
		.query("automationInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	for (const install of installs) {
		if (!install.enabled) continue;
		const automation = await definitionOf(ctx, install);
		const trigger = automation?.trigger;
		if (!automation || trigger?.type !== "event" || trigger.event !== event) continue;
		if (trigger.event === "message.posted" && trigger.channelId !== details.channelId) continue;
		await runFor(ctx, install, automation, triggerPrompt(automation, details.data), {
			// Reply under the message when posting back into the channel it came from.
			thread: details.channelId && details.messageId ? { chatId: details.channelId, messageId: details.messageId } : undefined,
			// Only people who can see where it happened get it.
			visibleIn: details.channelId,
		});
	}
}

async function workspaceUserByEmail(ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) {
	const user = await ctx.db
		.query("users")
		.withIndex("email", (q) => q.eq("email", normalizeEmail(email)))
		.first();
	if (!user) return null;
	return (await memberOf(ctx, user._id, workspaceId)) ? user._id : null;
}

/** Webhook delivery ids outlive sender retries. */
export const WEBHOOK_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs hourly (crons.ts): deletes webhook delivery ids older than WEBHOOK_MEMORY_MS, in batches. */
export const forgetOldWebhooks = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = await ctx.db
			.query("automationEvents")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - WEBHOOK_MEMORY_MS))
			.take(500);
		for (const delivery of old) await ctx.db.delete(delivery._id);
		if (old.length === 500) await ctx.scheduler.runAfter(0, internal.automationRuns.forgetOldWebhooks);
	},
});

/** Deletes a removed install's delivery ids, a bounded batch per run, so a busy webhook can't block removal. */
export const forgetUninstalled = internalMutation({
	args: { installId: v.id("automationInstalls") },
	handler: async (ctx, { installId }) => {
		const batch = await ctx.db
			.query("automationEvents")
			.withIndex("by_install", (q) => q.eq("installId", installId))
			.take(1_000);
		for (const delivery of batch) await ctx.db.delete(delivery._id);
		if (batch.length === 1_000) await ctx.scheduler.runAfter(0, internal.automationRuns.forgetUninstalled, { installId });
	},
});

// ---- Running ----

/** Records what a run did, for its page, and returns the line. */
async function finish(ctx: MutationCtx, install: Doc<"automationInstalls">, summary: string) {
	await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastResult: summary });
	return summary;
}

type Run = { ran: boolean; summary: string };

/**
 * One run, for the automation's audience. `person` narrows "subscribers" to one person
 * (a webhook naming them); `visibleIn` drops anyone who can't see that chat; `thread`
 * replies under a message when the run posts into that message's channel.
 */
async function runFor(
	ctx: MutationCtx,
	install: Doc<"automationInstalls">,
	automation: Automation,
	prompt: string,
	target: { person?: Id<"users">; visibleIn?: Id<"chats">; thread?: { chatId: Id<"chats">; messageId: Id<"chatMessages"> } },
): Promise<Run> {
	const audience = audienceOf(install);
	if (audience === "channel") return runInChannel(ctx, install, automation, prompt, target.thread);

	let userIds = audience === "creator" ? [install.installedBy] : await subscribersOf(ctx, install._id);
	if (target.person) userIds = userIds.filter((id) => id === target.person);
	const chat = target.visibleIn && (await ctx.db.get(target.visibleIn));
	const people: Id<"users">[] = [];
	for (const id of userIds) {
		const member = await memberOf(ctx, id, install.workspaceId);
		if (!member) continue;
		if (chat && !(await canSee(ctx, chat, member))) continue;
		people.push(id);
	}
	if (people.length === 0) {
		const why =
			audience === "creator"
				? target.person && target.person !== install.installedBy
					? "it's only for the person who made it"
					: "its creator has left the workspace"
				: target.person
					? "the person it's for hasn't turned it on"
					: "nobody has turned it on";
		return { ran: false, summary: await finish(ctx, install, `Didn't run: ${why}.`) };
	}
	return runInDms(ctx, install, automation, people, prompt);
}

async function activeAgent(ctx: QueryCtx, install: Doc<"automationInstalls">) {
	const agent = await ctx.db.get(install.agentId);
	return agent && !agent.archived ? agent : null;
}

const noAgent = "Didn't run: its agent is archived or deleted. Pick another agent.";

/**
 * Posts the prompt in each person's DM with the agent, as them, and queues the agent's
 * reply there. The turn queue handles a reply already running, so nobody is skipped.
 */
async function runInDms(
	ctx: MutationCtx,
	install: Doc<"automationInstalls">,
	automation: Automation,
	userIds: Id<"users">[],
	prompt: string,
): Promise<Run> {
	const agent = await activeAgent(ctx, install);
	if (!agent) return { ran: false, summary: await finish(ctx, install, noAgent) };
	for (const userId of userIds) {
		const chatId = await findOrCreateDm(ctx, install.workspaceId, userId, [userId], [agent._id]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			authorUserId: userId,
			text: prompt,
			parts: [{ type: "text", text: prompt }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
			automation: { id: automation.id, name: automation.name },
		});
		await enqueueTurn(ctx, chat, { agentId: agent._id, chatId, triggerId, actorId: userId });
	}
	const sent = userIds.length;
	return { ran: true, summary: await finish(ctx, install, `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`) };
}

/**
 * Posts the prompt once in the install's channel (under `thread`'s message if it's in
 * that channel) and queues the agent's reply there. Ones people make act as their maker,
 * who must still see the channel: falling back to anyone else would run the maker's
 * prompt with someone else's access. Library ones act as whoever picked the channel, or
 * an owner who can see it if they've left, so a run never depends on one person staying.
 */
async function runInChannel(
	ctx: MutationCtx,
	install: Doc<"automationInstalls">,
	automation: Automation,
	prompt: string,
	thread?: { chatId: Id<"chats">; messageId: Id<"chatMessages"> },
): Promise<Run> {
	const agent = await activeAgent(ctx, install);
	if (!agent) return { ran: false, summary: await finish(ctx, install, noAgent) };
	const chat = install.channelId && (await ctx.db.get(install.channelId));
	if (!chat || chat.archived)
		return { ran: false, summary: await finish(ctx, install, "Didn't run: its channel was archived or deleted. Pick another.") };
	const problem = await postingProblem(ctx, install.custom?.trigger, chat._id);
	if (problem) return { ran: false, summary: await finish(ctx, install, `Didn't run: ${problem}`) };
	const preferred = install.custom ? install.installedBy : (install.channelSetBy ?? install.installedBy);
	const candidates = [
		await memberOf(ctx, preferred, install.workspaceId),
		...(install.custom
			? []
			: (
					await ctx.db
						.query("members")
						.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
						.collect()
				).filter((m) => m.role === "owner" && m.userId !== preferred)),
	];
	let actorId: Id<"users"> | null = null;
	for (const m of candidates) {
		if (m?.workspaceId === install.workspaceId && (await canSee(ctx, chat, m))) {
			actorId = m.userId;
			break;
		}
	}
	if (!actorId) {
		const who = install.custom ? `${await nameOf(ctx, install.installedBy)}, who made it, isn't` : "nobody who can run it is";
		return { ran: false, summary: await finish(ctx, install, `Didn't run: ${who} in #${chat.name}. Pick another channel.`) };
	}
	const threadId = thread?.chatId === chat._id ? thread.messageId : undefined;
	await addToChat(ctx, chat, { agentId: agent._id });
	const triggerId = await insertMessage(ctx, chat, {
		threadId,
		authorUserId: actorId,
		text: prompt,
		parts: [{ type: "text", text: prompt }],
		mentions: { userIds: [], agentIds: [agent._id] },
		status: "done",
		automation: { id: automation.id, name: automation.name },
	});
	await enqueueTurn(ctx, chat, { agentId: agent._id, chatId: chat._id, threadId, triggerId, actorId });
	return { ran: true, summary: await finish(ctx, install, `Posted in #${chat.name}.`) };
}
