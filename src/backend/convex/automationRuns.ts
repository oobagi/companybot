import { type AppEvent, type Automation, parseWebhookBody, sampleData, scheduleDue, triggerPrompt, webhookMismatch } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation } from "./functions";
import { addToChat, canPost, canSee, findOrCreateDm, insertMessage } from "./chatOps";
import { type Member, accessOf, liveWorkspace, memberOf, nameOf, normalizeEmail, requireMember, rolesOf, sweepExpired } from "./lib";
import { type RunOutcome, definitionOf, followsOthers, outcomeText, postingProblem, privateTo, requireEditable, scheduleCursor, triggerIndexes, eventKeyFor } from "./automationOps";
import { blockedSource, type Source } from "./replyPrivacy";
import { artifactSources, chatSources, type UsedPlace } from "./replySources";
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

/** The nested mutation rolls back a failed attempt before we persist its failure. */
export const runScheduled = internalMutation({
	args: { installId: v.id("automationInstalls"), now: v.number() },
	handler: async (ctx, args): Promise<void> => {
		try { await ctx.runMutation(internal.automationRuns.runScheduledBatch, args); }
		catch (error) { await failedRun(ctx, args.installId, error); }
	},
});

export const runScheduledBatch = internalMutation({
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
	const key = eventKeyFor(event, details.channelId);
	if (!key) return;
	const matching = await ctx.db.query("automationInstalls").withIndex("by_event", q => q.eq("workspaceId", workspaceId).eq("eventKey", key)).first();
	if (matching) await ctx.scheduler.runAfter(0, internal.automationRuns.dispatchEvent, { workspaceId, event, details, key });
}

export const dispatchEvent = internalMutation({
	args: { workspaceId: v.id("workspaces"), event: v.union(v.literal("message.posted"), v.literal("member.joined")), details: v.object({ data: v.any(), channelId: v.optional(v.id("chats")), messageId: v.optional(v.id("chatMessages")) }), cursor: v.optional(v.string()), key: v.string() },
	handler: async (ctx, { workspaceId, event, details, cursor, key }) => {
		if (!(await liveWorkspace(ctx, workspaceId))) return;
		const page = await ctx.db.query("automationInstalls").withIndex("by_event", q => q.eq("workspaceId", workspaceId).eq("eventKey", key)).paginate({ numItems: 100, cursor: cursor ?? null });
		for (const install of page.page) {
			await ctx.scheduler.runAfter(0, internal.automationRuns.runEvent, { installId: install._id, event, details });
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.automationRuns.dispatchEvent, { workspaceId, event, details, key, cursor: page.continueCursor });
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
		if (trigger.event === "message.posted" && (!trigger.channelId || trigger.channelId !== details.channelId)) return;
		if (details.messageId && !(await liveTrigger(ctx, details.messageId))) return;
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

/** Records what a run did and returns it. */
async function finish(ctx: MutationCtx, install: Doc<"automationInstalls">, outcome: RunOutcome, success = true) {
	await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastOutcome: outcome, ...(success && { consecutiveFailures: 0 }) });
	return outcome;
}

type Run = { ran: boolean; outcome: RunOutcome };

/** Record the failure; a metadata-only notice stays readable even when its maker cannot open the automation. */
async function sourceFailure(ctx: MutationCtx, install: Doc<"automationInstalls">, member: Member, policy: Source, record = true): Promise<Run> {
	const text = policy.deletedConnector
		? `Didn't run: saved data from ${policy.name} is Owners-only after uninstall. Ask a workspace Owner to restore access.`
		: "Didn't run: the person running this automation no longer has access to its saved sources.";
	const outcome = record ? await finish(ctx, install, { text, failed: true }) : { text, failed: true };
	if (policy.deletedConnector && await activeAgent(ctx, install)) {
		const chatId = await findOrCreateDm(ctx, member.workspaceId, member.userId, [member.userId], [install.agentId]);
		const chat = (await ctx.db.get(chatId))!;
		await insertMessage(ctx, chat, { authorAgentId: install.agentId, text, parts: [{ type: "text", text }], status: "done", mentions: { userIds: [], agentIds: [] } });
	}
	return { ran: false, outcome };
}

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
	if (audience === "channel") {
		const sourceChat = target.visibleIn && await ctx.db.get(target.visibleIn);
		return runInChannel(ctx, install, automation, prompt, target.thread, sourceChat ? chatSources(sourceChat) : []);
	}

	if (audience === "subscribers" && !target.person) {
		const sourceChat = target.visibleIn && await ctx.db.get(target.visibleIn);
		const sources = [...new Set([...artifactSources(install, privateTo(install)), ...(sourceChat ? chatSources(sourceChat) : [])])];
		await ctx.scheduler.runAfter(0, internal.automationRuns.fanOut, { installId: install._id, prompt, visibleIn: target.visibleIn, messageId: target.thread?.messageId, sources, sent: 0, failed: 0 });
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
	let denied: { member: Member; policy: Source } | undefined;
	for (const id of userIds) {
		const member = await memberOf(ctx, id, install.workspaceId);
		if (!member) continue;
		const policy = await blockedSource(ctx, member, install.usedPlaces);
		if (policy) { denied = { member, policy }; continue; }
		if (target.visibleIn && (!chat || chat.archived || !(await canSee(ctx, chat, member)))) continue;
		people.push(id);
	}
	if (people.length === 0) {
		if (denied) return sourceFailure(ctx, install, denied.member, denied.policy);
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
	return runInDms(ctx, install, automation, people, prompt, chat ? chatSources(chat) : []);
}

/** Each page rechecks membership, visibility, and install/workspace liveness before delivery. */
const fanOutArgs = { sources: v.array(v.union(v.id("recordTypes"), v.id("pages"), v.id("driveFiles"), v.id("chats"), v.id("users"), v.id("connectorInstalls"))), installId: v.id("automationInstalls"), prompt: v.string(), visibleIn: v.optional(v.id("chats")), messageId: v.optional(v.id("chatMessages")), cursor: v.optional(v.string()), sent: v.number(), failed: v.number(), retry: v.optional(v.number()) };
export const fanOut = internalMutation({
	args: fanOutArgs,
	handler: async (ctx, args): Promise<void> => {
		try { await ctx.runMutation(internal.automationRuns.fanOutBatch, args); }
		catch (error) {
			const retry = args.retry ?? 0;
			if (transientError(error) && retry < 2) {
				await ctx.scheduler.runAfter(1_000 * 2 ** retry, internal.automationRuns.fanOut, { ...args, retry: retry + 1 });
			} else await failedRun(ctx, args.installId, error, args.sent);
		}
	},
});
export const fanOutBatch = internalMutation({
	args: fanOutArgs,
	handler: async (ctx, args) => {
		const install = await ctx.db.get(args.installId);
		if (!install || !(await liveWorkspace(ctx, install.workspaceId))) return;
		if (!install.enabled || install.archived) {
			await finish(ctx, install, { text: `Stopped after ${args.sent} ${args.sent === 1 ? "person" : "people"}: ${install.archived ? "archived" : "turned off"}.${args.failed ? ` ${args.failed} failed.` : ""}` }, false);
			return;
		}
		if (args.messageId && !(await liveTrigger(ctx, args.messageId))) return;
		const automation = await definitionOf(ctx, install, null);
		if (!automation || install.audience !== "subscribers") return;
		const page = await ctx.db.query("automationSubscriptions").withIndex("by_install", q => q.eq("installId", install._id)).paginate({ numItems: 100, cursor: args.cursor ?? null });
		const chat = args.visibleIn && await ctx.db.get(args.visibleIn);
		const people: Id<"users">[] = [];
		let sent = args.sent;
		let failed = args.failed;
		for (const sub of page.page) {
			const member = await memberOf(ctx, sub.userId, install.workspaceId);
			if (!member) continue;
			const policy = await blockedSource(ctx, member, [...(install.usedPlaces ?? []), ...args.sources]);
			if (policy) {
				await sourceFailure(ctx, install, member, policy, false);
				failed++;
				continue;
			}
			if (!args.visibleIn || (chat && !chat.archived && await canSee(ctx, chat, member))) people.push(sub.userId);
		}
		const agent = await activeAgent(ctx, install);
		if (!agent) { await finish(ctx, install, noAgent); return; }
		for (const userId of people) {
			try {
				// A recipient failure rolls back only their delivery, including a partially queued turn.
				await ctx.runMutation(internal.automationRuns.deliverRecipient, { installId: install._id, userId, prompt: args.prompt, sources: [...args.sources, ...(chat ? chatSources(chat) : [])] });
				sent++;
			} catch (error) {
				if (transientError(error)) throw error;
				console.error("Automation recipient delivery failed", install._id, userId, error);
				failed++;
			}
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.automationRuns.fanOut, { ...args, cursor: page.continueCursor, sent, failed, retry: 0 });
		else if (!sent && failed) await failedRun(ctx, install._id, new Error("Every recipient delivery failed"), sent, `Sent to 0 people, ${failed} failed`);
		else await finish(ctx, install, { text: sent || failed ? `Sent to ${sent} ${sent === 1 ? "person" : "people"}${failed ? `, ${failed} failed` : ""}.` : "Didn't run: nobody has turned it on." });
	},
});

/** Isolate each recipient's writes so one bad delivery cannot stop the audience. */
export const deliverRecipient = internalMutation({
	args: { installId: v.id("automationInstalls"), userId: v.id("users"), prompt: v.string(), sources: fanOutArgs.sources },
	handler: async (ctx, { installId, userId, prompt, sources }) => {
		const install = (await ctx.db.get(installId))!;
		const automation = (await definitionOf(ctx, install, null))!;
		const agent = (await activeAgent(ctx, install))!;
		await deliverInDms(ctx, install, automation, agent, [userId], prompt, sources);
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
	sources: UsedPlace[] = [],
): Promise<Run> {
	const agent = await activeAgent(ctx, install);
	if (!agent) return { ran: false, outcome: await finish(ctx, install, noAgent) };
	await deliverInDms(ctx, install, automation, agent, userIds, prompt, sources);
	const sent = userIds.length;
	return { ran: true, outcome: await finish(ctx, install, { text: `Sent to ${sent} ${sent === 1 ? "person" : "people"}.` }) };
}

/** Delivers a page without publishing a partial run result. */
async function deliverInDms(ctx: MutationCtx, install: Doc<"automationInstalls">, automation: Automation, agent: Doc<"agents">, userIds: Id<"users">[], prompt: string, sources: UsedPlace[]) {
	for (const userId of userIds) {
		const chatId = await findOrCreateDm(ctx, install.workspaceId, userId, [userId], [agent._id]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			usedPlaces: [...new Set([...artifactSources(install, privateTo(install)), ...sources])],
			authorUserId: userId,
			text: prompt,
			parts: [{ type: "text", text: prompt }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
			automation: { id: automation.id, name: automation.name, foreign: followsOthers(install, userId) },
		});
		await enqueueTurn(ctx, chat, { agentId: agent._id, chatId, triggerId, actorId: userId });
	}
}

async function liveTrigger(ctx: QueryCtx, id: Id<"chatMessages">) {
	const message = await ctx.db.get(id);
	return message && !message.deleted;
}

const transientError = (error: unknown) => /conflict|temporar|timeout|timed out|overloaded|rate limit|ECONNRESET|unavailable/i.test(error instanceof Error ? error.message : String(error));

/** Keep failures visible, but only pause an install after three consecutive whole-run failures. */
async function failedRun(ctx: MutationCtx, installId: Id<"automationInstalls">, error: unknown, sent?: number, summary?: string) {
	const install = await ctx.db.get(installId);
	if (!install || !(await liveWorkspace(ctx, install.workspaceId))) return;
	const failures = (install.consecutiveFailures ?? 0) + 1;
	console.error("Automation run failed", installId, error);
	await ctx.db.patch(installId, {
		consecutiveFailures: failures,
		...(failures >= 3 && { enabled: false, nextRunAt: undefined, eventKey: undefined }),
	});
	await finish(ctx, install, { text: `${summary ?? `Failed: could not complete the run${sent === undefined ? "" : ` after sending to ${sent} ${sent === 1 ? "person" : "people"}`}`}.${failures >= 3 ? " Paused after 3 consecutive failures." : summary ? "" : " Try again or check its settings."}` }, false);
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
	sources: UsedPlace[] = [],
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
	let denied: { member: Member; policy: Source } | undefined;
	for (const userId of [preferred, ...owners.map((m) => m.userId)]) {
		const member = await memberOf(ctx, userId, install.workspaceId);
		if (!member) continue;
		const policy = await blockedSource(ctx, member, [...(install.usedPlaces ?? []), ...sources]);
		if (policy) { denied = { member, policy }; continue; }
		// It posts there as them, so they need Post in it, not just View.
		if ((await canSee(ctx, chat, member)) && canPost(member, chat)) {
			actorId = userId;
			break;
		}
	}
	if (!actorId) {
		if (denied) return sourceFailure(ctx, install, denied.member, denied.policy);
		const who = install.custom ? `${await nameOf(ctx, install.installedBy)}, who made it, isn't` : "nobody who can run it is";
		return { ran: false, outcome: await finish(ctx, install, { text: `Didn't run: ${who} in {channel}. Pick another channel.`, channelId: chat._id }) };
	}
	const threadId = thread?.chatId === chat._id ? thread.messageId : undefined;
	await addToChat(ctx, chat, { agentId: agent._id });
	const triggerId = await insertMessage(ctx, chat, {
		threadId,
		usedPlaces: [...new Set([...artifactSources(install, privateTo(install)), ...sources])],
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
