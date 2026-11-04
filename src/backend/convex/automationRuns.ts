import { type AppEvent, type Automation, parseWebhookBody, sampleData, scheduleDue, triggerPrompt, webhookMismatch } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation } from "./functions";
import { addToChat, canPost, canSee, findOrCreateDm, insertMessage } from "./chatOps";
import { type Member, accessOf, liveWorkspace, memberOf, nameOf, normalizeEmail, requireMember, rolesOf, sweepExpired } from "./lib";
import { type RunOutcome, definitionOf, followsOthers, outcomeText, postingProblem, requireEditable, scheduleCursor, triggerIndexes } from "./automationOps";
import { enqueueTurn } from "./turns";

/** Runs it once now, just for you (webhooks and events use a sample), so you can see what it does. */
export const runNow = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => runNowAs(ctx, await requireMember(ctx), automationId),
});

// ---- Internal: triggers ----

/** Runs every few minutes (crons.ts): starts the scheduled automations that are due. */
export const tick = internalMutation({
	/** `now` is for tests: faking Date doesn't reach functions run by convex-test. */
	args: { now: v.optional(v.number()) },
	handler: async (ctx, { now = Date.now() }) => {
		const installs = await ctx.db.query("automationInstalls")
			.withIndex("by_due", q => q.gt("nextRunAt", undefined).lte("nextRunAt", now)).take(100);
		for (const install of installs) {
			// Lease until the next cron tick. A failed install retries without holding up other workspaces.
			await ctx.db.patch(install._id, { nextRunAt: now + 5 * 60_000 });
			await ctx.scheduler.runAfter(0, internal.automationRuns.runScheduled, { installId: install._id, now });
		}
		if (installs.length === 100) await ctx.scheduler.runAfter(0, internal.automationRuns.tick, { now });
	},
});

export const runScheduled = internalMutation({
	args: { installId: v.id("automationInstalls"), now: v.number() },
	handler: async (ctx, { installId, now }) => {
		const install = await ctx.db.get(installId);
		if (!install || !install.enabled || install.archived || !(await liveWorkspace(ctx, install.workspaceId))) return;
		const automation = await definitionOf(ctx, install, null);
		if (!automation) {
			await ctx.db.patch(installId, { nextRunAt: undefined });
			return;
		}
		await ctx.db.patch(installId, triggerIndexes(install, now));
		const due = scheduleDue(automation.trigger, now, install.timeZone, scheduleCursor(install));
		if (due === null) return;
		await ctx.db.patch(installId, { lastScheduledAt: due });
		await runFor(ctx, install, automation, automation.prompt, {});
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
		const automation = install && (await definitionOf(ctx, install, null));
		// A workspace being deleted has no webhooks, and one in Archive has none: nothing runs, and nothing new is saved behind its cascade.
		if (!install || install.archived || automation?.trigger.type !== "webhook" || !(await liveWorkspace(ctx, install.workspaceId)))
			return { status: 404, ok: false, message: "Unknown webhook URL." };
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
			if (!found && install.audience === "subscribers")
				return { status: 200, ok: true, message: (await finish(ctx, install, { text: `Didn't run: nobody here has the email ${delivery.person.email}.` })).text };
			person = found ?? undefined;
		}
		const result = await runFor(ctx, install, automation, triggerPrompt(automation, delivery.data), { person });
		// Its sender is outside the workspace: no channel names.
		return { status: 200, ok: true, message: await outcomeText(ctx, result.outcome, null) };
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
	await ctx.scheduler.runAfter(0, internal.automationRuns.dispatchEvent, { workspaceId, event, details });
}

export const dispatchEvent = internalMutation({
	args: { workspaceId: v.id("workspaces"), event: v.union(v.literal("message.posted"), v.literal("member.joined")), details: v.object({ data: v.any(), channelId: v.optional(v.id("chats")), messageId: v.optional(v.id("chatMessages")) }), cursor: v.optional(v.string()) },
	handler: async (ctx, { workspaceId, event, details, cursor }) => {
		if (!(await liveWorkspace(ctx, workspaceId))) return;
		const page = await ctx.db.query("automationInstalls").withIndex("by_event", q => q.eq("workspaceId", workspaceId).eq("eventKey", event)).paginate({ numItems: 100, cursor: cursor ?? null });
		for (const install of page.page) {
			await ctx.scheduler.runAfter(0, internal.automationRuns.runEvent, { installId: install._id, event, details });
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.automationRuns.dispatchEvent, { workspaceId, event, details, cursor: page.continueCursor });
	},
});
export const runEvent = internalMutation({
	args: { installId: v.id("automationInstalls"), event: v.string(), details: v.object({ data: v.any(), channelId: v.optional(v.id("chats")), messageId: v.optional(v.id("chatMessages")) }) },
	handler: async (ctx, { installId, event, details }) => {
		const install = await ctx.db.get(installId);
		if (!install || !install.enabled || install.archived || !(await liveWorkspace(ctx, install.workspaceId))) return;
		const automation = await definitionOf(ctx, install, null);
		const trigger = automation?.trigger;
		if (!automation || trigger?.type !== "event" || trigger.event !== event) return;
		if (trigger.event === "message.posted" && trigger.channelId !== details.channelId) return;
		await runFor(ctx, install, automation, triggerPrompt(automation, details.data), {
			thread: details.channelId && details.messageId ? { chatId: details.channelId, messageId: details.messageId } : undefined,
			visibleIn: details.channelId,
		});
	},
});

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
		const old = ctx.db.query("automationEvents").withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - WEBHOOK_MEMORY_MS));
		await sweepExpired(ctx, old, (delivery) => ctx.db.delete(delivery._id), internal.automationRuns.forgetOldWebhooks);
	},
});

// ---- Running ----

/**
 * Records what a run did, for its page, and returns it. COMPAT(0.1.0-alpha.10): clears the old line too, so
 * migrations.automationOutcomes never puts it back over a newer run; stop once `lastResult` is dropped.
 */
async function finish(ctx: MutationCtx, install: Doc<"automationInstalls">, outcome: RunOutcome) {
	await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastOutcome: outcome, lastResult: undefined });
	return outcome;
}

type Run = { ran: boolean; outcome: RunOutcome };

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
	const audience = install.audience;
	if (audience === "channel") return runInChannel(ctx, install, automation, prompt, target.thread);

	if (audience === "subscribers" && !target.person) {
		await ctx.scheduler.runAfter(0, internal.automationRuns.fanOut, { installId: install._id, prompt, visibleIn: target.visibleIn, sent: 0 });
		return { ran: true, outcome: { text: "Queued." } };
	}
	let userIds = [install.installedBy];
	if (audience === "subscribers") {
		const subscribed = await ctx.db.query("automationSubscriptions")
			.withIndex("by_install", q => q.eq("installId", install._id).eq("userId", target.person!)).first();
		userIds = subscribed ? [target.person!] : [];
	}
	if (target.person) userIds = userIds.filter((id) => id === target.person);
	const chat = target.visibleIn && (await ctx.db.get(target.visibleIn));
	const people: Id<"users">[] = [];
	for (const id of userIds) {
		const member = await memberOf(ctx, id, install.workspaceId);
		if (!member) continue;
		if (target.visibleIn && (!chat || chat.archived || !(await canSee(ctx, chat, member)))) continue;
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
		return { ran: false, outcome: await finish(ctx, install, { text: `Didn't run: ${why}.` }) };
	}
	return runInDms(ctx, install, automation, people, prompt);
}

/** Each page rechecks membership, visibility, and install/workspace liveness before delivery. */
export const fanOut = internalMutation({
	args: { installId: v.id("automationInstalls"), prompt: v.string(), visibleIn: v.optional(v.id("chats")), cursor: v.optional(v.string()), sent: v.number() },
	handler: async (ctx, args) => {
		const install = await ctx.db.get(args.installId);
		if (!install || !install.enabled || install.archived || !(await liveWorkspace(ctx, install.workspaceId))) return;
		const automation = await definitionOf(ctx, install, null);
		if (!automation || install.audience !== "subscribers") return;
		const page = await ctx.db.query("automationSubscriptions").withIndex("by_install", q => q.eq("installId", install._id)).paginate({ numItems: 100, cursor: args.cursor ?? null });
		const chat = args.visibleIn && await ctx.db.get(args.visibleIn);
		const people: Id<"users">[] = [];
		for (const sub of page.page) {
			const member = await memberOf(ctx, sub.userId, install.workspaceId);
			if (member && (!args.visibleIn || (chat && !chat.archived && await canSee(ctx, chat, member)))) people.push(sub.userId);
		}
		if (!(await activeAgent(ctx, install))) { await finish(ctx, install, noAgent); return; }
		if (people.length) await runInDms(ctx, install, automation, people, args.prompt);
		const sent = args.sent + people.length;
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.automationRuns.fanOut, { ...args, cursor: page.continueCursor, sent });
		else await finish(ctx, install, { text: sent ? `Sent to ${sent} ${sent === 1 ? "person" : "people"}.` : "Didn't run: nobody has turned it on." });
	},
});

async function activeAgent(ctx: QueryCtx, install: Doc<"automationInstalls">) {
	const agent = await ctx.db.get(install.agentId);
	return agent && !agent.archived ? agent : null;
}

const noAgent = { text: "Didn't run: its agent was deleted. Pick another agent." };

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
	if (!agent) return { ran: false, outcome: await finish(ctx, install, noAgent) };
	for (const userId of userIds) {
		const chatId = await findOrCreateDm(ctx, install.workspaceId, userId, [userId], [agent._id]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			authorUserId: userId,
			text: prompt,
			parts: [{ type: "text", text: prompt }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
			automation: { id: automation.id, name: automation.name, foreign: followsOthers(install, userId) },
		});
		await enqueueTurn(ctx, chat, { agentId: agent._id, chatId, triggerId, actorId: userId });
	}
	const sent = userIds.length;
	return { ran: true, outcome: await finish(ctx, install, { text: `Sent to ${sent} ${sent === 1 ? "person" : "people"}.` }) };
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
	if (!agent) return { ran: false, outcome: await finish(ctx, install, noAgent) };
	const chat = install.channelId && (await ctx.db.get(install.channelId));
	if (!chat || chat.archived)
		return { ran: false, outcome: await finish(ctx, install, { text: "Didn't run: its channel was deleted. Pick another." }) };
	const problem = await postingProblem(ctx, install.custom?.trigger, chat._id);
	if (problem) return { ran: false, outcome: await finish(ctx, install, { ...problem, text: `Didn't run: ${problem.text}` }) };
	const preferred = install.custom ? install.installedBy : (install.channelSetBy ?? install.installedBy);
	const roles = await rolesOf(ctx, install.workspaceId);
	const owners = install.custom
		? []
		: (
				await ctx.db
					.query("members")
					.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
					.collect()
			).filter((m) => accessOf(roles, m).owner && m.userId !== preferred);
	// Each read through memberOf, so a workspace being deleted has nobody to act as.
	let actorId: Id<"users"> | null = null;
	for (const userId of [preferred, ...owners.map((m) => m.userId)]) {
		const member = await memberOf(ctx, userId, install.workspaceId);
		// It posts there as them, so they need Post in it, not just View.
		if (member && (await canSee(ctx, chat, member)) && canPost(member, chat)) {
			actorId = userId;
			break;
		}
	}
	if (!actorId) {
		const who = install.custom ? `${await nameOf(ctx, install.installedBy)}, who made it, isn't` : "nobody who can run it is";
		return { ran: false, outcome: await finish(ctx, install, { text: `Didn't run: ${who} in {channel}. Pick another channel.`, channelId: chat._id }) };
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
		automation: { id: automation.id, name: automation.name, foreign: followsOthers(install, actorId) },
	});
	await enqueueTurn(ctx, chat, { agentId: agent._id, chatId: chat._id, threadId, triggerId, actorId });
	return { ran: true, outcome: await finish(ctx, install, { text: "Posted in {channel}.", channelId: chat._id }) };
}

export async function runNowAs(ctx: MutationCtx, acting: Member, automationId: string) {
	const { member, install } = await requireEditable(ctx, automationId, acting);
	const automation = await definitionOf(ctx, install, member);
	if (!automation) throw new ConvexError("Install it first.");
	const result = await runInDms(ctx, install, automation, [member.userId], triggerPrompt(automation, sampleData(automation.trigger)));
	if (!result.ran) throw new ConvexError(await outcomeText(ctx, result.outcome, member));
}
