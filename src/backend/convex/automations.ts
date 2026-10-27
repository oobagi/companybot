import {
	type Automation,
	type AutomationAudience,
	type CustomAutomationConfig,
	automationCatalog,
	can,
	canEditMade,
	customAutomationError,
	deniedMessage,
	describeTrigger,
	findAutomation,
	findConnector,
	grantedConnectorIds,
	isValidTimeZone,
	localTime,
	normalizeCustomAutomation,
} from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { canSee } from "./chatOps";
import {
	type Member,
	checkPermission,
	getMember,
	madeCustom,
	memberOf,
	nameOf,
	newCustomId,
	randomHex,
	requireAgent,
	requireMember,
	requirePermission,
	saveMade,
} from "./lib";
import { canView, definitionOf, installOf, postingProblem, requireEditable, runsForLabel, subscribersOf, visibleInstalls, webhookUrl } from "./automationOps";
import { forgetAutomationGrants } from "./permissions";
import { startCascade } from "./cascade";
import { audience, customTrigger } from "./schema";

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

async function installedConnectorIds(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("connectorInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.take(100);
	return new Set(installs.map((i) => i.connectorId));
}

/** The secret in a webhook automation's URL. */
const newToken = () => randomHex(24);

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const connectors = await installedConnectorIds(ctx, member.workspaceId);
		const installs = await visibleInstalls(ctx, member);
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
				const audience = install ? install.audience : null;
				const canEdit = install ? canEditMade(member, "automations.manage", install.custom ? install.installedBy : undefined) : can(member, "automations.manage");
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

/**
 * Checks an automation someone wrote, including that they can see any channel its trigger
 * watches. A channel it already watched (`before`) isn't re-checked, so an owner who isn't
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

async function checkPosting(ctx: QueryCtx, trigger: CustomAutomationConfig["trigger"] | undefined, destination?: Id<"chats">) {
	const problem = destination && (await postingProblem(ctx, trigger, destination));
	if (problem) throw new ConvexError(problem);
}

/** A schedule set after today's time starts tomorrow rather than firing on the next tick. */
function firstRunDate(trigger: Automation["trigger"] | CustomAutomationConfig["trigger"], timeZone: string) {
	if (trigger.type !== "schedule") return undefined;
	const now = localTime(Date.now(), timeZone);
	return now.time >= trigger.time ? now.date : undefined;
}

const customConfig = v.object({ name: v.string(), prompt: v.string(), trigger: customTrigger });
const audienceArgs = { audience, channelId: v.optional(v.id("chats")) };

/**
 * Makes an automation someone wrote. Anyone with `automations.create` can; it starts
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
	if (!can(member, "automations.create")) throw new ConvexError(deniedMessage("automations.create"));
	config = normalizeCustomAutomation(config);
	await checkConfig(ctx, member, config);
	if (!timeZone || !isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
	const agent = await requireAgent(ctx, member, agentId);
	if (agent.archived) throw new ConvexError("That agent is archived.");
	if (audience === "channel") {
		if (!channelId) throw new ConvexError("Pick a channel to post in.");
		await requireVisibleChannel(ctx, member, channelId);
		await checkPosting(ctx, config.trigger, channelId);
	}
	const automationId = newCustomId();
	const { trigger } = config;
	const installId = await ctx.db.insert("automationInstalls", {
		workspaceId: member.workspaceId,
		automationId,
		agentId,
		enabled: true,
		timeZone,
		installedBy: member.userId,
		lastRunDate: firstRunDate(trigger, timeZone),
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
	await saveMade({
		current: install.custom,
		expectedVersion,
		config: normalizeCustomAutomation(config),
		userId: member.userId,
		validate: async () => {
			await checkConfig(ctx, member, config, install.custom!.trigger);
			if (install.audience === "channel") await checkPosting(ctx, config.trigger, install.channelId);
		},
		patch: (custom) => ctx.db.patch(install._id, {
			...(config.trigger.type === "schedule" && { lastRunDate: firstRunDate(config.trigger, install.timeZone) ?? install.lastRunDate }),
			custom,
			// Becoming a webhook gets a URL; leaving webhooks drops it.
			webhookToken: config.trigger.type === "webhook" ? (install.webhookToken ?? newToken()) : undefined,
		}),
	});
}

export async function removeAutomation(ctx: MutationCtx, member: Member, automationId: string) {
	const install = await installOf(ctx, member.workspaceId, automationId);
	if (!install) return;
	await requireEditable(ctx, automationId, member);
	await removeInstall(ctx, install);
}

export const remove = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => removeAutomation(ctx, await requireMember(ctx), automationId),
});

/** Installs a library automation (owners). */
export const setInstalled = mutation({
	args: { automationId: v.string(), installed: v.literal(true), timeZone: v.optional(v.string()) },
	handler: async (ctx, { automationId, timeZone }) => {
		return installAutomation(ctx, await requireMember(ctx), { automationId, timeZone });
	},
});

/** Deletes an install now, so its webhook and schedule stop; its opt-ins, grants and delivery ids follow (lifecycle.ts). */
async function removeInstall(ctx: MutationCtx, install: Doc<"automationInstalls">) {
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
	if (agentId) {
		const agent = await requireAgent(ctx, member, agentId);
		if (agent.archived) throw new ConvexError("That agent is archived.");
	}
	if (audience === "creator" && !install.custom) throw new ConvexError("Library automations run for people who turn them on, or a channel.");
	if (audience === "creator" && install.installedBy !== member.userId) throw new ConvexError("Only the person who made it can make it just for them.");
	if (audience === "channel") {
		if (!channelId) throw new ConvexError("Pick a channel to post in.");
		await requireVisibleChannel(ctx, member, channelId);
		await checkPosting(ctx, install.custom?.trigger, channelId);
		// Ones people make run as their maker, so the maker has to be able to see it too.
		const maker = install.custom && (await memberOf(ctx, install.installedBy, install.workspaceId));
		const chat = (await ctx.db.get(channelId))!;
		if (install.custom && !(maker && (await canSee(ctx, chat, maker))))
			throw new ConvexError(`${await nameOf(ctx, install.installedBy)} made it and can't see #${chat.name}, so it can't post there.`);
	}
	await ctx.db.patch(install._id, {
		...(enabled !== undefined && { enabled }),
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

export async function installAutomation(ctx: MutationCtx, member: Member, { automationId, timeZone }: { automationId: string; timeZone?: string }) {
	const existing = await installOf(ctx, member.workspaceId, automationId);
	checkPermission(member, "automations.manage");
	const owner = member;
	if (existing) return;
	const automation = requireAutomation(automationId);
	if (!timeZone || !isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
	const connectors = await installedConnectorIds(ctx, owner.workspaceId);
	const missing = automation.connectors.filter((id) => !connectors.has(id)).map((id) => findConnector(id)?.name ?? id);
	if (missing.length > 0) throw new ConvexError(`Install the ${missing.join(", ")} connector first.`);
	const agent = await ctx.db
		.query("agents")
		.withIndex("by_workspace_active", (q) => q.eq("workspaceId", owner.workspaceId).eq("archived", false))
		.first();
	if (!agent) throw new ConvexError("Create an agent first.");
	const installId = await ctx.db.insert("automationInstalls", {
		workspaceId: owner.workspaceId,
		automationId,
		agentId: agent._id,
		enabled: true,
		timeZone,
		installedBy: owner.userId,
		lastRunDate: firstRunDate(automation.trigger, timeZone),
		webhookToken: automation.trigger.type === "webhook" ? newToken() : undefined,
		audience: "subscribers",
	});
	// The owner who installs it gets it; everyone else turns it on for themselves.
	await ctx.db.insert("automationSubscriptions", { installId, userId: owner.userId });
}
