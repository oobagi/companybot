import { type Automation, type AutomationAudience, type CustomAutomationConfig, canEditAutomation, customAutomation, isRestricted, normalizeTrigger, nextRuns, scheduleCron } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type Member, checkPermission, requireMember } from "./lib";
import type { QueryCtx } from "./_generated/server";
import { canSee } from "./chatOps";

/** Automations that run just for their creator are theirs alone (their id here); the rest are visible to the workspace (null). */
export const privateTo = (install: Doc<"automationInstalls">) => (install.custom && install.audience === "creator" ? install.installedBy : null);

export const canView = (member: Member, install: Doc<"automationInstalls">) => {
	const only = privateTo(install);
	return !only || only === member.userId;
};

/**
 * Whether a run of this automation as `userId` follows words they didn't write: someone else
 * made or last edited it, or its trigger brings in others' text (webhooks and in-app events).
 * Those runs ask before acting as them in the workspace (core `Risk` "inside").
 */
export function followsOthers(install: Doc<"automationInstalls">, userId: Id<"users">) {
	const trigger = install.custom?.trigger ?? install.definition?.trigger;
	return (!!install.custom && (install.installedBy !== userId || install.custom.updatedBy !== userId)) || trigger?.type !== "schedule";
}

/**
 * Live automation scope plus immutable provenance from the server-written trigger. A wake turn
 * (wakeups.ts) has no trigger: its wakeup says whether it was made in a run following others' words.
 */
export async function automationScope(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const trigger = turn.triggerId && (await ctx.db.get(turn.triggerId));
	const automation = trigger?.automation ? await installOf(ctx, turn.workspaceId, trigger.automation.id) : null;
	const wakeup = turn.wakeupId ? await ctx.db.get(turn.wakeupId) : null;
	// Legacy triggers without a provenance snapshot, removed installs, and wakeups already forgotten stay foreign.
	const foreign =
		(!!trigger?.automation && ((trigger.automation.foreign ?? true) || !automation || followsOthers(automation, turn.actorId))) ||
		(!!turn.wakeupId && (wakeup?.foreign ?? true));
	return { trigger, automation, foreign, wakeup };
}

export function automationName(install: Doc<"automationInstalls">) {
	if (install.custom) return install.custom.name;
	return install.definition?.name ?? install.automationId;
}

/** An automation's install, unless it's in Archive: one there is gone to everything but Trash. */
export const installOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, automationId: string) => {
	const install = await ctx.db
		.query("automationInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", automationId))
		.first();
	return install?.archived ? null : install;
};

/** The workspace's installs this person can see; ones in Archive only if `trashed`. */
export const visibleInstalls = async (ctx: QueryCtx, member: Member, trashed = false) =>
	(
		await ctx.db
			.query("automationInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect()
	).filter((i) => canView(member, i) && (trashed || !i.archived));

/** What an install runs: its custom config or its retained stored definition. */
/**
 * An install's definition. `viewer`: whoever it's shown to, so a watched channel they can't see goes unnamed
 * ("When someone posts in #a channel"); null for the runner, which shows it to no one.
 */
export async function definitionOf(ctx: QueryCtx, install: Doc<"automationInstalls">, viewer: Member | null): Promise<Automation | undefined> {
	if (!install.custom) return install.definition && { ...install.definition, trigger: normalizeTrigger(install.definition.trigger) };
	const { trigger } = install.custom;
	const watched = trigger.type === "event" && trigger.event === "message.posted" ? trigger.channelId : undefined;
	const channel = watched && (viewer ? await seenChannel(ctx, viewer, watched) : await ctx.db.get(watched as Id<"chats">));
	const config = watched && !channel ? { ...install.custom, trigger: { ...trigger, channelId: "" } } : install.custom;
	return customAutomation(install.automationId, config, install.custom.version, channel ? channel.name : undefined);
}

/** A channel by id, if `member` can see it: listings name, and give the ids of, only channels their reader can see. */
export async function seenChannel(ctx: QueryCtx, member: Member, id: string | undefined) {
	const chatId = id ? ctx.db.normalizeId("chats", id) : null;
	const chat = chatId && (await ctx.db.get(chatId));
	return chat && chat.workspaceId === member.workspaceId && (await canSee(ctx, chat, member)) ? chat : null;
}

/** A custom trigger as `member` may read it: one watching a channel they can't see, without its id. */
export async function shownTrigger<T extends CustomAutomationConfig["trigger"]>(ctx: QueryCtx, member: Member, trigger: T): Promise<T> {
	if (trigger.type !== "event" || trigger.event !== "message.posted" || (await seenChannel(ctx, member, trigger.channelId))) return trigger;
	return { ...trigger, channelId: "" };
}

/**
 * Schedule runs after this are due (core `scheduleDue`). COMPAT(0.1.0-alpha.10): installs from
 * before cron have no `lastScheduledAt` until migrations.cronSchedules, so their last run stands in.
 */
export const scheduleCursor = (install: Doc<"automationInstalls">) => install.lastScheduledAt ?? install.lastRunAt ?? install._creationTime;

/** An installed automation the signed-in person may change: their personal one, or a team one with `automations.edit`. */
export async function requireEditable(ctx: QueryCtx, automationId: string, acting?: Member) {
	const member = acting ?? await requireMember(ctx);
	const install = await installOf(ctx, member.workspaceId, automationId);
	if (!install || !canView(member, install)) throw new ConvexError("Automation not found.");
	if (!canEditAutomation(member, privateTo(install))) checkPermission(member, "automations.edit");
	return { member, install };
}

export const subscribersOf = async (ctx: QueryCtx, installId: Id<"automationInstalls">) =>
	(
		await ctx.db
			.query("automationSubscriptions")
			.withIndex("by_install", (q) => q.eq("installId", installId))
			.collect()
	).map((s) => s.userId);

export const webhookUrl = (token: string) => `${process.env.CONVEX_SITE_URL ?? ""}/automations/${token}`;

export const runsForLabel = (audience: AutomationAudience, channel: Doc<"chats"> | null, scheduled: boolean, creatorName: string) =>
	audience === "channel"
		? (channel ? `Posts once in #${channel.name}` : "Posts once in a channel")
		: audience === "creator"
			? `Just ${creatorName}, in their chat with the agent`
			: scheduled
				? "Each person who turns it on, in their chat with the agent"
				: "Each person who turns it on (or just the person a webhook names), in their chat with the agent";

/**
 * What a run did, as stored: its line, with `{channel}` (where it posted) and `{watched}` (the channel
 * its trigger watches) for `outcomeText` to name to each reader. Never a channel's name: the last run's
 * line shows to everyone who can see the automation, and not all of them can see its channels.
 */
export type RunOutcome = { text: string; channelId?: Id<"chats">; watchedId?: Id<"chats"> };

/** A run's line for `viewer` (null: someone outside, like a webhook's sender): a channel by name only to someone who can see it. */
export async function outcomeText(ctx: QueryCtx, outcome: RunOutcome, viewer: Member | null) {
	const name = async (id: Id<"chats"> | undefined) => {
		const chat = viewer && (await seenChannel(ctx, viewer, id));
		return chat ? `#${chat.name}` : "a channel";
	};
	return outcome.text.replace("{channel}", await name(outcome.channelId)).replace("{watched}", await name(outcome.watchedId));
}

/**
 * Why an automation can't post in `destination`, or null (an outcome: `outcomeText` names its channel).
 * One that watches a private channel posts only back into it: anywhere else would show its messages
 * to people who can't see that channel.
 */
export async function postingProblem(ctx: QueryCtx, trigger: CustomAutomationConfig["trigger"] | undefined, destination: Id<"chats">): Promise<RunOutcome | null> {
	if (trigger?.type !== "event" || trigger.event !== "message.posted" || trigger.channelId === destination) return null;
	const source = await ctx.db.get(trigger.channelId as Id<"chats">);
	if (source?.private) return { text: "It watches {watched}, which is private, so it can only post there or to people who turn it on.", watchedId: source._id };
	// Same for one only some roles can see: posting elsewhere would show its messages to people they're kept from.
	return source && isRestricted(source.access) ? { text: "It watches {watched}, which only some roles can see, so it can only post there or to people who turn it on.", watchedId: source._id } : null;
}

/** Derived trigger indexes. All install writes and the backfill use this same calculation. */
export function triggerIndexes(install: Pick<Doc<"automationInstalls">, "custom" | "definition" | "enabled" | "archived" | "timeZone">, after: number) {
	const trigger = install.custom?.trigger ?? install.definition?.trigger;
	return {
		nextRunAt: install.enabled && !install.archived && trigger?.type === "schedule" ? nextRuns(scheduleCron(trigger), install.timeZone, after, 1)[0] : undefined,
		eventKey: install.enabled && !install.archived && trigger?.type === "event" ? trigger.event : undefined,
	};
}
