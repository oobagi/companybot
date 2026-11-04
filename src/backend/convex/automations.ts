import {
	type Automation,
	type AutomationAudience,
	type CustomAutomationConfig,
	canEditAutomation,
	customAutomationError,
	describeTrigger,
	isValidTimeZone,
	legacyFields,
	normalizeCustomAutomation,
} from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { canSee } from "./chatOps";
import {
	type Member,
	type Who,
	checkPermission,
	getMember,
	madeCustom,
	memberOf,
	nameOf,
	newCustomId,
	randomHex,
	requireLiveAgent,
	requireMember,
	saveMade,
} from "./lib";
import { triggerIndexes, automationName, canView, definitionOf, installOf, outcomeText, postingProblem, privateTo, requireEditable, runsForLabel, seenChannel, shownTrigger, subscribersOf, visibleInstalls, webhookUrl } from "./automationOps";
import { forgetAutomationGrants } from "./permissions";
import { startCascade } from "./cascade";
import { audience, customTrigger } from "./schema";
import { toggleTrash, trashInfo } from "./trashOps";

// An automation is a trigger (schedule, webhook, or something happening in the app), a
// prompt, an agent, and who it runs for (`AutomationAudience`): just its creator, each
// person who turned it on, or one channel. Each run posts the prompt as the person it
// runs for (or, in a channel, as whoever set it up, falling back to an owner) and queues the agent's reply,
// so the reply uses their permissions and connector accounts (wiki/chat.md).
//
// Anyone can make their own (`custom`, id "custom-…"). Retired library installs
// keep their stored definition; both run through the same code.

/** The secret in a webhook automation's URL. */
const newToken = () => randomHex(24);

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const installs = await visibleInstalls(ctx, member, true);
		const rows = (await Promise.all(installs
			.sort((a, b) => b._creationTime - a._creationTime)
			.map(async (install) => ({ automation: await definitionOf(ctx, install, member), install }))))
			.filter((row): row is { automation: Automation; install: Doc<"automationInstalls"> } => !!row.automation);
		return Promise.all(
			rows.map(async ({ automation, install }) => {
				const agent = await ctx.db.get(install.agentId);
				// Where it posts, if they can see it: one they can't see goes unnamed, without its id.
				const channel = await seenChannel(ctx, member, install.channelId);
				const scheduled = automation.trigger.type === "schedule";
				const audience = install.audience;
				const canEdit = canEditAutomation(member, privateTo(install));
				const subscribers = await subscribersOf(ctx, install._id);
				const creatorName = await nameOf(ctx, install.installedBy);
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
					/** Set for automations someone made: what can be edited, and who last did. */
					custom: install.custom
						? {
								name: automationName(install),
								prompt: install.custom.prompt,
								// COMPAT(0.1.0-alpha.10): alpha.9 apps edit a schedule as one time and days; send just the cron.
								trigger: compatTrigger(await shownTrigger(ctx, member, normalizeCustomAutomation(install.custom).trigger)),
								version: install.custom.version,
								updatedByName: await nameOf(ctx, install.custom.updatedBy),
								updatedAt: install.custom.updatedAt,
							}
						: null,
					createdByName: install.custom ? creatorName : null,
					canEdit,
					installed: true,
					enabled: install.enabled,
					audience,
					/** Audience "subscribers": whether you turned it on, and how many have. */
					subscribed: subscribers.includes(member.userId),
					subscriberCount: subscribers.length,
					agentId: install.agentId,
					agentName: agent?.name ?? null,
					agentArchived: agent?.archived ?? false,
					channelId: channel?._id ?? null,
					channelName: channel?.name ?? null,
					channelArchived: channel?.archived ?? false,
					/** Secret: only for people who can change it. */
					webhookUrl: canEdit && install.webhookToken ? webhookUrl(install.webhookToken) : null,
					timeZone: install.timeZone,
					lastRunAt: install.lastRunAt ?? null,
					/** The last run's line, its channels named only if you can see them. */
					lastResult: install.lastOutcome ? await outcomeText(ctx, install.lastOutcome, member) : null,
					/** Set while it's in Archive. */
					trash: install.archived ? await trashInfo(ctx, member, install._id) : null,
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

/**
 * Checks an automation someone wrote, including that they can see any channel its trigger
 * watches. A channel it already watched (`before`) isn't re-checked, so someone with automations.edit who isn't
 * in it can still rename it.
 */
async function checkConfig(ctx: QueryCtx, member: Member, config: CustomAutomationConfig, before?: CustomAutomationConfig["trigger"]) {
	const problem = customAutomationError(config);
	if (problem) throw new ConvexError(problem);
	const { trigger } = config;
	const watchedBefore = before?.type === "event" && before.event === "message.posted" ? before.channelId : undefined;
	if (trigger.type === "event" && trigger.event === "message.posted" && trigger.channelId !== watchedBefore) {
		const id = ctx.db.normalizeId("chats", trigger.channelId);
		if (!id) throw new ConvexError("That channel isn't available.");
		await requireVisibleChannel(ctx, member, id);
	}
}

async function checkPosting(ctx: QueryCtx, member: Member, trigger: CustomAutomationConfig["trigger"] | undefined, destination?: Id<"chats">) {
	const problem = destination && (await postingProblem(ctx, trigger, destination));
	if (problem) throw new ConvexError(await outcomeText(ctx, problem, member));
}

/** A schedule with the time and days alpha.9 apps' editor reads. */
const compatTrigger = (trigger: CustomAutomationConfig["trigger"]): CustomAutomationConfig["trigger"] =>
	trigger.type === "schedule" && "cron" in trigger && trigger.cron ? { ...trigger, ...legacyFields(trigger.cron) } : trigger;

const customConfig = v.object({ name: v.string(), prompt: v.string(), trigger: customTrigger });
const audienceArgs = { audience, channelId: v.optional(v.id("chats")) };

/**
 * Makes an automation someone wrote. Anyone can make a personal one; team ones need `automations.edit`. It starts
 * with them subscribed if it's for people who turn it on. Returns its id.
 */
export const create = mutation({
	args: { config: customConfig, agentId: v.id("agents"), ...audienceArgs, timeZone: v.string() },
	handler: async (ctx, args) => createAutomation(ctx, await requireMember(ctx), args),
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
	// One just for its maker is theirs alone, so anyone can make one; the rest are the team's.
	if (audience !== "creator") checkPermission(member, "automations.edit");
	await checkConfig(ctx, member, config);
	config = normalizeCustomAutomation(config);
	if (!timeZone || !isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
	await requireLiveAgent(ctx, member, agentId);
	if (audience === "channel") {
		if (!channelId) throw new ConvexError("Pick a channel to post in.");
		await requireVisibleChannel(ctx, member, channelId);
		await checkPosting(ctx, member, config.trigger, channelId);
	}
	const automationId = newCustomId();
	const { trigger } = config;
	const installId = await ctx.db.insert("automationInstalls", {
		workspaceId: member.workspaceId,
		automationId,
		agentId,
		enabled: true,
		...triggerIndexes({ custom: madeCustom(config, member.userId), enabled: true, timeZone }, Date.now()),
		timeZone,
		installedBy: member.userId,
		// Runs from its next time on, never one already past.
		lastScheduledAt: trigger.type === "schedule" ? Date.now() : undefined,
		webhookToken: trigger.type === "webhook" ? newToken() : undefined,
		audience,
		...(audience === "channel" && { channelId, channelSetBy: member.userId }),
		custom: madeCustom(config, member.userId),
	});
	if (audience === "subscribers") await ctx.db.insert("automationSubscriptions", { installId, userId: member.userId });
	return automationId;
}

/** Saves an automation's name, prompt, and trigger. Refused if someone saved since `expectedVersion`. */
const saveAutomationArgs = v.object({ automationId: v.string(), config: customConfig, expectedVersion: v.number() });

export const save = mutation({
	args: saveAutomationArgs.fields,
	handler: async (ctx, args) => saveAutomation(ctx, await requireMember(ctx), args),
});

export async function saveAutomation(ctx: MutationCtx, member: Member, { automationId, config, expectedVersion }: Infer<typeof saveAutomationArgs>) {
	const { install } = await requireEditable(ctx, automationId, member);
	if (!install.custom) throw new ConvexError("Library automations can't be edited.");
	const normal = normalizeCustomAutomation(config);
	const rescheduled = normal.trigger.type === "schedule" && JSON.stringify(normal.trigger) !== JSON.stringify(normalizeCustomAutomation(install.custom).trigger);
	await saveMade({
		current: install.custom,
		expectedVersion,
		config: normal,
		userId: member.userId,
		validate: async () => {
			await checkConfig(ctx, member, config, install.custom!.trigger);
			if (install.audience === "channel") await checkPosting(ctx, member, config.trigger, install.channelId);
		},
		patch: (custom) => ctx.db.patch(install._id, {
			...triggerIndexes({ ...install, custom }, rescheduled ? Date.now() : (install.lastScheduledAt ?? install._creationTime)),
			// A new schedule starts from its next time, never one already past.
			...(rescheduled && { lastScheduledAt: Date.now() }),
			custom,
			// Becoming a webhook gets a URL; leaving webhooks drops it.
			webhookToken: config.trigger.type === "webhook" ? (install.webhookToken ?? newToken()) : undefined,
		}),
	});
}

/** Moves any automation to Archive, retaining its opt-ins and grants for recovery. */
export async function removeAutomation(ctx: MutationCtx, who: Who, automationId: string) {
	const install = await installOf(ctx, who.member.workspaceId, automationId);
	if (install) await setAutomationTrashed(ctx, who, install._id, true);
}

export const remove = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => removeAutomation(ctx, { member: await requireMember(ctx) }, automationId),
});

/**
 * Moves an automation to Archive, or back: whoever can change it. In Trash nothing
 * triggers it (installOf skips it); its opt-ins and grants stay until it's deleted forever.
 */
export async function setAutomationTrashed(ctx: MutationCtx, who: Who, installId: Id<"automationInstalls">, archived: boolean) {
	const { member } = who;
	const install = await ctx.db.get(installId);
	if (!install || install.workspaceId !== member.workspaceId || !canView(member, install)) throw new ConvexError("Automation not found.");
	if (!canEditAutomation(member, privateTo(install))) checkPermission(member, "automations.edit");
	if (!!install.archived === archived) return;
	await toggleTrash(ctx, who, archived, { kind: "automation", id: installId, name: automationName(install) });
	await ctx.db.patch(installId, { archived, ...triggerIndexes({ ...install, archived }, install.lastScheduledAt ?? install._creationTime) });
}

/** Deletes an install now, so its webhook and schedule stop; its opt-ins, grants and delivery ids follow (lifecycle.ts). */
export async function removeInstall(ctx: MutationCtx, install: Doc<"automationInstalls">) {
	await ctx.db.delete(install._id);
	await startCascade(ctx, "automationInstall", { automationInstallId: install._id });
}

const updateAutomationArgs = v.object({
		automationId: v.string(),
		enabled: v.optional(v.boolean()),
		agentId: v.optional(v.id("agents")),
		audience: v.optional(audience),
		/** Needed with audience "channel". */
		channelId: v.optional(v.id("chats")),
	});

export const update = mutation({
	args: updateAutomationArgs.fields,
	handler: async (ctx, args) => updateAutomation(ctx, await requireMember(ctx), args),
});

export async function updateAutomation(ctx: MutationCtx, member: Member, { automationId, enabled, agentId, audience, channelId }: Infer<typeof updateAutomationArgs>) {
	const { install } = await requireEditable(ctx, automationId, member);
	if (agentId) await requireLiveAgent(ctx, member, agentId);
	if (audience === "creator" && !install.custom) throw new ConvexError("Library automations run for people who turn them on, or a channel.");
	if (audience === "creator" && install.installedBy !== member.userId) throw new ConvexError("Only the person who made it can make it just for them.");
	// Sharing a personal one makes it the team's.
	if (audience && audience !== "creator") checkPermission(member, "automations.edit");
	if (audience === "channel") {
		if (!channelId) throw new ConvexError("Pick a channel to post in.");
		await requireVisibleChannel(ctx, member, channelId);
		await checkPosting(ctx, member, install.custom?.trigger, channelId);
		// Ones people make run as their maker, so the maker has to be able to see it too.
		const maker = install.custom && (await memberOf(ctx, install.installedBy, install.workspaceId));
		const chat = (await ctx.db.get(channelId))!;
		if (install.custom && !(maker && (await canSee(ctx, chat, maker))))
			throw new ConvexError(`${await nameOf(ctx, install.installedBy)} made it and can't see #${chat.name}, so it can't post there.`);
	}
	await ctx.db.patch(install._id, {
		...triggerIndexes({ ...install, enabled: enabled ?? install.enabled }, enabled && !install.enabled ? Date.now() : (install.lastScheduledAt ?? install._creationTime)),
		...(enabled !== undefined && { enabled }),
		// Resuming doesn't make up the runs it missed while paused.
		...(enabled && !install.enabled && { lastScheduledAt: Date.now() }),
		...(agentId && { agentId }),
		...(audience && {
			audience,
			channelId: audience === "channel" ? (channelId ?? undefined) : undefined,
			channelSetBy: audience === "channel" ? member.userId : undefined,
		}),
	});
	// Offering it to people: its editor gets it too, so turning it on never leaves nobody.
	if (audience === "subscribers" && !(await ctx.db.query("automationSubscriptions").withIndex("by_install", q => q.eq("installId", install._id).eq("userId", member.userId)).first()))
		await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: member.userId });
}

/** Turns an automation on or off for yourself. Only automations that run for people who turn them on. */
export const subscribe = mutation({
	args: { automationId: v.string(), on: v.boolean() },
	handler: async (ctx, { automationId, on }) => {
		const problem = await setSubscription(ctx, await requireMember(ctx), automationId, on);
		if (problem) throw new ConvexError(problem);
	},
});

/** Turns an automation on or off for `member`. Returns why it can't, or null. Shared with the agents' tool. */
export async function setSubscription(ctx: MutationCtx, member: Member, automationId: string, on: boolean) {
	const install = await installOf(ctx, member.workspaceId, automationId);
	if (!install || !canView(member, install)) return "Automation not found.";
	if (install.audience !== "subscribers") return "This automation isn't one people turn on for themselves.";
	const existing = await ctx.db
		.query("automationSubscriptions")
		.withIndex("by_install", (q) => q.eq("installId", install._id).eq("userId", member.userId))
		.first();
	if (on && !existing) await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: member.userId });
	if (!on && existing) await ctx.db.delete(existing._id);
	// Turning it off takes back what you allowed for it; turning it on again asks again.
	if (!on) await forgetAutomationGrants(ctx, install._id, member.userId);
	return null;
}

/** A new webhook URL; the old one stops working. */
export const resetWebhook = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const { install } = await requireEditable(ctx, automationId);
		if (!install.webhookToken) throw new ConvexError("This automation has no webhook.");
		await ctx.db.patch(install._id, { webhookToken: newToken() });
	},
});
