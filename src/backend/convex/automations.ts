import {
	type AppEvent,
	type Automation,
	type AutomationAudience,
	type CustomAutomationConfig,
	automationCatalog,
	can,
	canEditAutomation,
	customAutomation,
	customAutomationError,
	describeTrigger,
	eventMismatch,
	eventPrompt,
	findAutomation,
	findConnector,
	grantedConnectorIds,
	isValidTimeZone,
	localTime,
	parseEventBody,
	sampleData,
	scheduleDue,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { addToChat, canSee, findOrCreateDm, insertMessage } from "./chatOps";
import {
	type Member,
	checkVersion,
	getMember,
	memberOf,
	nameOf,
	normalizeEmail,
	requireAgent,
	requireMember,
	requirePermission,
} from "./lib";
import { audience, customTrigger } from "./schema";
import { enqueueTurn } from "./turns";

// An automation is a trigger (schedule, webhook, or something happening in the app), a
// prompt, an agent, and who it runs for (`AutomationAudience`): just its creator, each
// person who turned it on, or one channel. Each run posts the prompt as the person it
// runs for (or, in a channel, as its creator or an owner) and queues the agent's reply,
// so the reply uses their permissions and connector accounts (wiki/chat.md).
//
// Library automations come from core's catalog; owners install them. Anyone can make
// their own (`custom`, id "custom-…"); both run through the same code.

function requireAutomation(automationId: string): Automation {
	const automation = findAutomation(automationId);
	if (!automation) throw new ConvexError("Unknown automation.");
	return automation;
}

const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, automationId: string) =>
	ctx.db
		.query("automationInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", automationId))
		.first();

/** What an install runs: its own definition if someone made it, else the catalog's. */
async function definitionOf(ctx: QueryCtx, install: Doc<"automationInstalls">): Promise<Automation | undefined> {
	if (!install.custom) return findAutomation(install.automationId);
	const { trigger } = install.custom;
	const channel = trigger.type === "event" && trigger.event === "message.posted" ? await ctx.db.get(trigger.channelId as Id<"chats">) : null;
	return customAutomation(install.automationId, install.custom, install.custom.version, channel?.name);
}

/** Installs from before audiences: a channel if one was picked, else people who turn it on. */
export const audienceOf = (install: Doc<"automationInstalls">): AutomationAudience =>
	install.audience ?? (install.channelId ? "channel" : "subscribers");

const forEdit = (install: Doc<"automationInstalls">) => ({ createdBy: install.installedBy, custom: !!install.custom });

/** Automations that run just for their creator are theirs alone; the rest are visible to the workspace. */
const canView = (member: Member, install: Doc<"automationInstalls">) =>
	!install.custom || audienceOf(install) !== "creator" || install.installedBy === member.userId;

/** An installed automation the signed-in person may change: theirs, or any if they manage automations. */
async function requireEditable(ctx: QueryCtx, automationId: string) {
	const member = await requireMember(ctx);
	const install = await installOf(ctx, member.workspaceId, automationId);
	if (!install || !canView(member, install)) throw new ConvexError("Automation not found.");
	if (!canEditAutomation(member, forEdit(install)))
		throw new ConvexError("You don't have permission to change this automation. Ask its creator or a workspace owner.");
	return { member, install };
}

async function installedConnectorIds(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("connectorInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	return new Set(installs.map((i) => i.connectorId));
}

const subscribersOf = async (ctx: QueryCtx, installId: Id<"automationInstalls">) =>
	(
		await ctx.db
			.query("automationSubscriptions")
			.withIndex("by_install", (q) => q.eq("installId", installId))
			.collect()
	).map((s) => s.userId);

/** The secret in a webhook automation's URL. */
function newToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const webhookUrl = (token: string) => `${process.env.CONVEX_SITE_URL ?? ""}/automations/${token}`;

const runsForLabel = (audience: AutomationAudience, channel: Doc<"chats"> | null, scheduled: boolean, creatorName: string) =>
	audience === "channel"
		? `Posts once in #${channel?.name ?? "a channel"}`
		: audience === "creator"
			? `Just ${creatorName}, in their chat with the agent`
			: scheduled
				? "Each person who turns it on, in their chat with the agent"
				: "Each person who turns it on (or just the person a webhook names), in their chat with the agent";

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const connectors = await installedConnectorIds(ctx, member.workspaceId);
		const installs = (
			await ctx.db
				.query("automationInstalls")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
				.collect()
		).filter((i) => canView(member, i));
		const custom = installs.filter((i) => i.custom).sort((a, b) => b._creationTime - a._creationTime);
		const library = automationCatalog.map((automation) => ({
			automation,
			install: installs.find((i) => i.automationId === automation.id && !i.custom) ?? null,
		}));
		const rows = [
			...(await Promise.all(custom.map(async (install) => ({ automation: (await definitionOf(ctx, install))!, install })))),
			...library,
		];
		return Promise.all(
			rows.map(async ({ automation, install }) => {
				const agent = install && (await ctx.db.get(install.agentId));
				const granted = agent ? grantedConnectorIds(agent) : [];
				const channel = (install?.channelId && (await ctx.db.get(install.channelId))) || null;
				const scheduled = automation.trigger.type === "schedule";
				const audience = install ? audienceOf(install) : null;
				const canEdit = install ? canEditAutomation(member, forEdit(install)) : can(member, "automations.manage");
				const subscribers = install ? await subscribersOf(ctx, install._id) : [];
				const creatorName = install ? await nameOf(ctx, install.installedBy) : "";
				return {
					id: automation.id,
					name: automation.name,
					description: automation.description,
					details: automation.details,
					version: automation.version,
					publisher: automation.publisher,
					trigger: describeTrigger(automation.trigger),
					triggerType: automation.trigger.type,
					scheduled,
					runsFor: audience ? runsForLabel(audience, channel, scheduled, creatorName) : null,
					prompt: automation.prompt,
					needs: automation.connectors.map((id) => ({
						id,
						name: findConnector(id)?.name ?? id,
						installed: connectors.has(id),
						granted: granted.includes(id),
					})),
					/** Set for automations someone made: what can be edited, and who last did. */
					custom: install?.custom
						? {
								name: install.custom.name,
								prompt: install.custom.prompt,
								trigger: install.custom.trigger,
								version: install.custom.version,
								updatedByName: await nameOf(ctx, install.custom.updatedBy),
								updatedAt: install.custom.updatedAt,
							}
						: null,
					createdByName: install?.custom ? creatorName : null,
					canEdit,
					installed: !!install,
					enabled: install?.enabled ?? false,
					audience,
					/** Audience "subscribers": whether you turned it on, and how many have. */
					subscribed: subscribers.includes(member.userId),
					subscriberCount: subscribers.length,
					agentId: install?.agentId ?? null,
					agentName: agent?.name ?? null,
					agentArchived: agent?.archived ?? false,
					channelId: install?.channelId ?? null,
					channelName: channel?.name ?? null,
					channelArchived: channel?.archived ?? false,
					/** Secret: only for people who can change it. */
					webhookUrl: canEdit && install?.webhookToken ? webhookUrl(install.webhookToken) : null,
					timeZone: install?.timeZone ?? null,
					lastRunAt: install?.lastRunAt ?? null,
					lastResult: install?.lastResult ?? null,
				};
			}),
		);
	},
});

/** A channel the person can see, to post in or to watch. */
async function requireVisibleChannel(ctx: QueryCtx, member: Member, channelId: Id<"chats">) {
	const chat = await ctx.db.get(channelId);
	if (!chat || chat.kind !== "channel" || chat.archived || !(await canSee(ctx, chat, member)))
		throw new ConvexError("That channel isn't available.");
	return chat;
}

/** Checks an automation someone wrote, including that they can see any channel its trigger watches. */
async function checkConfig(ctx: QueryCtx, member: Member, config: CustomAutomationConfig) {
	const problem = customAutomationError(config);
	if (problem) throw new ConvexError(problem);
	const { trigger } = config;
	if (trigger.type === "event" && trigger.event === "message.posted") {
		const id = ctx.db.normalizeId("chats", trigger.channelId);
		if (!id) throw new ConvexError("That channel isn't available.");
		await requireVisibleChannel(ctx, member, id);
	}
}

const trimmed = (config: CustomAutomationConfig): CustomAutomationConfig => ({
	name: config.name.trim(),
	prompt: config.prompt.trim(),
	trigger:
		config.trigger.type === "schedule"
			? { ...config.trigger, weekdays: [...config.trigger.weekdays].sort((a, b) => a - b) }
			: config.trigger,
});

const customConfig = v.object({ name: v.string(), prompt: v.string(), trigger: customTrigger });
const audienceArgs = { audience, channelId: v.optional(v.id("chats")) };

/**
 * Makes an automation someone wrote. Anyone with `automations.create` can; it starts
 * with them subscribed if it's for people who turn it on. Returns its id.
 */
export const create = mutation({
	args: { config: customConfig, agentId: v.id("agents"), ...audienceArgs, timeZone: v.string() },
	handler: async (ctx, args) => createAutomation(ctx, await requirePermission(ctx, "automations.create"), args),
});

/** Shared by `create` and the agents' `automations.create` tool, so both follow the same rules. */
export async function createAutomation(
	ctx: MutationCtx,
	member: Member,
	{
		config,
		agentId,
		audience,
		channelId,
		timeZone,
	}: { config: CustomAutomationConfig; agentId: Id<"agents">; audience: AutomationAudience; channelId?: Id<"chats">; timeZone: string },
) {
	if (!can(member, "automations.create")) throw new ConvexError("You don't have permission to make automations.");
	await checkConfig(ctx, member, config);
	if (!isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
	const agent = await requireAgent(ctx, member, agentId);
	if (agent.archived) throw new ConvexError("That agent is archived.");
	if (audience === "channel") {
		if (!channelId) throw new ConvexError("Pick a channel to post in.");
		await requireVisibleChannel(ctx, member, channelId);
	}
	const automationId = `custom-${newToken().slice(0, 12)}`;
	const now = localTime(Date.now(), timeZone);
	const { trigger } = config;
	const installId = await ctx.db.insert("automationInstalls", {
		workspaceId: member.workspaceId,
		automationId,
		agentId,
		enabled: true,
		timeZone,
		installedBy: member.userId,
		// Made after today's time: start tomorrow rather than firing right away.
		lastRunDate: trigger.type === "schedule" && now.time >= trigger.time ? now.date : undefined,
		webhookToken: trigger.type === "webhook" ? newToken() : undefined,
		audience,
		...(audience === "channel" && { channelId, channelSetBy: member.userId }),
		custom: { ...trimmed(config), version: 1, updatedBy: member.userId, updatedAt: Date.now() },
	});
	if (audience === "subscribers") await ctx.db.insert("automationSubscriptions", { installId, userId: member.userId });
	return automationId;
}

/** Saves an automation's name, prompt, and trigger. Refused if someone saved since `expectedVersion`. */
export const save = mutation({
	args: { automationId: v.string(), config: customConfig, expectedVersion: v.number() },
	handler: async (ctx, { automationId, config, expectedVersion }) => {
		const { member, install } = await requireEditable(ctx, automationId);
		if (!install.custom) throw new ConvexError("Library automations can't be edited.");
		checkVersion(install.custom.version, expectedVersion);
		await checkConfig(ctx, member, config);
		const webhook = config.trigger.type === "webhook";
		await ctx.db.patch(install._id, {
			custom: { ...trimmed(config), version: install.custom.version + 1, updatedBy: member.userId, updatedAt: Date.now() },
			// Becoming a webhook gets a URL; leaving webhooks drops it, so the old URL stops working.
			webhookToken: webhook ? (install.webhookToken ?? newToken()) : undefined,
		});
	},
});

/** Installs or removes a library automation (owners), or deletes one someone made (its creator or owners). */
export const setInstalled = mutation({
	args: { automationId: v.string(), installed: v.boolean(), timeZone: v.string() },
	handler: async (ctx, { automationId, installed, timeZone }) => {
		const member = await requireMember(ctx);
		const existing = await installOf(ctx, member.workspaceId, automationId);
		if (!installed) {
			if (!existing) return;
			await requireEditable(ctx, automationId);
			await removeInstall(ctx, existing);
			return;
		}
		const owner = await requirePermission(ctx, "automations.manage");
		if (existing) return;
		const automation = requireAutomation(automationId);
		if (!isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
		const connectors = await installedConnectorIds(ctx, owner.workspaceId);
		const missing = automation.connectors.filter((id) => !connectors.has(id)).map((id) => findConnector(id)?.name ?? id);
		if (missing.length > 0) throw new ConvexError(`Install the ${missing.join(", ")} connector first.`);
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", owner.workspaceId))
			.filter((q) => q.eq(q.field("archived"), false))
			.first();
		if (!agent) throw new ConvexError("Create an agent first.");
		// Installed after today's time: start tomorrow rather than firing right away.
		const now = localTime(Date.now(), timeZone);
		const startsTomorrow = automation.trigger.type === "schedule" && now.time >= automation.trigger.time;
		const installId = await ctx.db.insert("automationInstalls", {
			workspaceId: owner.workspaceId,
			automationId,
			agentId: agent._id,
			enabled: true,
			timeZone,
			installedBy: owner.userId,
			lastRunDate: startsTomorrow ? now.date : undefined,
			webhookToken: automation.trigger.type === "webhook" ? newToken() : undefined,
			audience: "subscribers",
		});
		// The owner who installs it gets it; everyone else turns it on for themselves.
		await ctx.db.insert("automationSubscriptions", { installId, userId: owner.userId });
	},
});

async function removeInstall(ctx: MutationCtx, install: Doc<"automationInstalls">) {
	await ctx.db.delete(install._id);
	const subs = ctx.db.query("automationSubscriptions").withIndex("by_install", (q) => q.eq("installId", install._id));
	for await (const sub of subs) await ctx.db.delete(sub._id);
	const events = ctx.db.query("automationEvents").withIndex("by_install", (q) => q.eq("installId", install._id));
	for await (const event of events) await ctx.db.delete(event._id);
}

export const update = mutation({
	args: {
		automationId: v.string(),
		enabled: v.optional(v.boolean()),
		agentId: v.optional(v.id("agents")),
		audience: v.optional(audience),
		/** Needed with audience "channel". */
		channelId: v.optional(v.id("chats")),
	},
	handler: async (ctx, { automationId, enabled, agentId, audience, channelId }) => {
		const { member, install } = await requireEditable(ctx, automationId);
		if (agentId) {
			const agent = await requireAgent(ctx, member, agentId);
			if (agent.archived) throw new ConvexError("That agent is archived.");
		}
		if (audience === "creator" && !install.custom) throw new ConvexError("Library automations run for people who turn them on, or a channel.");
		if (audience === "channel") {
			if (!channelId) throw new ConvexError("Pick a channel to post in.");
			await requireVisibleChannel(ctx, member, channelId);
		}
		await ctx.db.patch(install._id, {
			...(enabled !== undefined && { enabled }),
			...(agentId && { agentId }),
			...(audience && {
				audience,
				channelId: audience === "channel" ? channelId : undefined,
				channelSetBy: audience === "channel" ? member.userId : undefined,
			}),
		});
		// Offering it to people: its editor gets it too, so turning it on never leaves nobody.
		if (audience === "subscribers" && !(await subscribersOf(ctx, install._id)).includes(member.userId))
			await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: member.userId });
	},
});

/** Turns an automation on or off for yourself. Only automations that run for people who turn them on. */
export const subscribe = mutation({
	args: { automationId: v.string(), on: v.boolean() },
	handler: async (ctx, { automationId, on }) => {
		const member = await requireMember(ctx);
		const install = await installOf(ctx, member.workspaceId, automationId);
		if (!install || !canView(member, install)) throw new ConvexError("Automation not found.");
		if (audienceOf(install) !== "subscribers") throw new ConvexError("This automation isn't one people turn on for themselves.");
		const existing = await ctx.db
			.query("automationSubscriptions")
			.withIndex("by_install", (q) => q.eq("installId", install._id).eq("userId", member.userId))
			.first();
		if (on && !existing) await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: member.userId });
		if (!on && existing) await ctx.db.delete(existing._id);
	},
});

/** A new webhook URL; the old one stops working. */
export const resetWebhook = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const { install } = await requireEditable(ctx, automationId);
		if (!install.webhookToken) throw new ConvexError("This automation has no webhook.");
		await ctx.db.patch(install._id, { webhookToken: newToken() });
	},
});

/** Runs it once now, just for you (webhooks and events use a sample), so you can see what it does. */
export const runNow = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const { member, install } = await requireEditable(ctx, automationId);
		const automation = await definitionOf(ctx, install);
		if (!automation) throw new ConvexError("Install it first.");
		const result = await runInDms(ctx, install, automation, [member.userId], eventPrompt(automation, sampleData(automation.trigger)));
		if (!result.ran) throw new ConvexError(result.summary);
	},
});

// ---- Internal: triggers ----

/** Runs every few minutes (crons.ts): starts the scheduled automations that are due. */
export const tick = internalMutation({
	args: {},
	handler: async (ctx) => {
		const installs = await ctx.db
			.query("automationInstalls")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.collect();
		for (const install of installs) {
			const automation = await definitionOf(ctx, install);
			if (!automation) continue;
			const due = scheduleDue(automation.trigger, Date.now(), install.timeZone, install.lastRunDate);
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
		const event = parseEventBody(json);
		if (typeof event === "string") return { status: 400, ok: false, message: event };
		const mismatch = eventMismatch(automation.trigger, event.event);
		if (mismatch) return { status: 400, ok: false, message: mismatch };
		if (!install.enabled) return { status: 200, ok: true, message: "Not run: the automation is off." };

		const seen = await ctx.db
			.query("automationEvents")
			.withIndex("by_install", (q) => q.eq("installId", install._id).eq("eventId", event.id))
			.first();
		if (seen) return { status: 200, ok: true, message: "Already received." };
		await ctx.db.insert("automationEvents", { installId: install._id, eventId: event.id });

		let person: Id<"users"> | undefined;
		if (event.person) {
			const found = await workspaceUserByEmail(ctx, install.workspaceId, event.person.email);
			if (!found && audienceOf(install) === "subscribers")
				return { status: 200, ok: true, message: await finish(ctx, install, `Didn't run: nobody here has the email ${event.person.email}.`) };
			person = found ?? undefined;
		}
		const result = await runFor(ctx, install, automation, eventPrompt(automation, event.data), { person });
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
		const trigger = install.custom?.trigger;
		if (!install.enabled || trigger?.type !== "event" || trigger.event !== event) continue;
		if (trigger.event === "message.posted" && trigger.channelId !== details.channelId) continue;
		const automation = (await definitionOf(ctx, install))!;
		await runFor(ctx, install, automation, eventPrompt(automation, details.data), {
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
	const member = await memberOf(ctx, user._id);
	return member?.workspaceId === workspaceId ? user._id : null;
}

/** Event ids are kept this long: far past any sender's retries. */
export const EVENT_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs hourly (crons.ts): deletes event ids older than EVENT_MEMORY_MS, in batches. */
export const forgetOldEvents = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = await ctx.db
			.query("automationEvents")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - EVENT_MEMORY_MS))
			.take(500);
		for (const event of old) await ctx.db.delete(event._id);
		if (old.length === 500) await ctx.scheduler.runAfter(0, internal.automations.forgetOldEvents);
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
		const member = await memberOf(ctx, id);
		if (member?.workspaceId !== install.workspaceId) continue;
		if (chat && !(await canSee(ctx, chat, member))) continue;
		people.push(id);
	}
	if (people.length === 0) {
		const why =
			audience === "creator"
				? "its creator has left the workspace"
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
 * that channel) and queues the agent's reply there, acting as whoever picked the
 * channel, or an owner who can see it if they've left, so a run never depends on one
 * person staying.
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
	const preferred = install.channelSetBy ?? install.installedBy;
	const candidates = [
		await memberOf(ctx, preferred),
		...(
			await ctx.db
				.query("members")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
				.collect()
		).filter((m) => m.role === "owner" && m.userId !== preferred),
	];
	let actorId: Id<"users"> | null = null;
	for (const m of candidates) {
		if (m?.workspaceId === install.workspaceId && (await canSee(ctx, chat, m))) {
			actorId = m.userId;
			break;
		}
	}
	if (!actorId)
		return { ran: false, summary: await finish(ctx, install, `Didn't run: nobody who can run it is in #${chat.name}. Pick another channel.`) };
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
