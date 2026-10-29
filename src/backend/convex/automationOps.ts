import { type Automation, type AutomationAudience, type CustomAutomationConfig, canEditMade, customAutomation, deniedMessage, madeEditDenied } from "@companybot/core";
import { ConvexError } from "convex/values";
import { legacyAutomation } from "./legacyCatalogs";
import type { Doc, Id } from "./_generated/dataModel";
import { type Member, requireMember } from "./lib";
import type { QueryCtx } from "./_generated/server";

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
/** A retained library automation's definition: stored on its row, or (COMPAT, until `storedAutomations` ran) from the old catalog. */
const storedDefinition = (install: Doc<"automationInstalls">) => install.definition ?? legacyAutomation(install.automationId);

export function followsOthers(install: Doc<"automationInstalls">, userId: Id<"users">) {
	const trigger = install.custom?.trigger ?? storedDefinition(install)?.trigger;
	return (!!install.custom && (install.installedBy !== userId || install.custom.updatedBy !== userId)) || trigger?.type !== "schedule";
}

/** Live automation scope plus immutable provenance from the server-written trigger. */
export async function automationScope(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const trigger = turn.triggerId && (await ctx.db.get(turn.triggerId));
	const automation = trigger?.automation ? await installOf(ctx, turn.workspaceId, trigger.automation.id) : null;
	// Legacy triggers without a provenance snapshot and removed installs stay foreign.
	const foreign = !!trigger?.automation && ((trigger.automation.foreign ?? true) || !automation || followsOthers(automation, turn.actorId));
	return { trigger, automation, foreign };
}

export function automationName(install: Doc<"automationInstalls">) {
	return install.custom?.name ?? storedDefinition(install)?.name ?? install.automationId;
}

/** An automation's install, unless it's in Trash: one there is gone to everything but Trash. */
export const installOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, automationId: string) => {
	const install = await ctx.db
		.query("automationInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", automationId))
		.first();
	return install?.archived ? null : install;
};

/** A live install this person can see, by automation id. */
export const visibleInstall = async (ctx: QueryCtx, member: Member, automationId: string) => {
	const install = await installOf(ctx, member.workspaceId, automationId);
	return install && canView(member, install) ? install : null;
};

/** The workspace's installs this person can see; ones in Trash only if `trashed`. */
export const visibleInstalls = async (ctx: QueryCtx, member: Member, trashed = false) =>
	(
		await ctx.db
			.query("automationInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect()
	).filter((i) => canView(member, i) && (trashed || !i.archived));

/** What an install runs: its custom config or its retained stored definition. */
export async function definitionOf(ctx: QueryCtx, install: Doc<"automationInstalls">): Promise<Automation | undefined> {
	if (!install.custom) return storedDefinition(install);
	const { trigger } = install.custom;
	const channel = trigger.type === "event" && trigger.event === "message.posted" ? await ctx.db.get(trigger.channelId as Id<"chats">) : null;
	return customAutomation(install.automationId, install.custom, install.custom.version, channel?.name);
}

/** An installed automation the signed-in person may change: theirs, or any if they manage automations. */
export async function requireEditable(ctx: QueryCtx, automationId: string, acting?: Member) {
	const member = acting ?? await requireMember(ctx);
	const install = await visibleInstall(ctx, member, automationId);
	if (!install) throw new ConvexError("Automation not found.");
	if (!canEditMade(member, "automations.manage", install.custom ? install.installedBy : undefined))
		throw new ConvexError(install.custom ? madeEditDenied : deniedMessage("automations.manage"));
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
		? `Posts once in #${channel?.name ?? "a channel"}`
		: audience === "creator"
			? `Just ${creatorName}, in their chat with the agent`
			: scheduled
				? "Each person who turns it on, in their chat with the agent"
				: "Each person who turns it on (or just the person a webhook names), in their chat with the agent";

/**
 * Why an automation can't post in `destination`, or null. One that watches a private
 * channel posts only back into it: anywhere else would show its messages to people
 * who can't see that channel.
 */
export async function postingProblem(ctx: QueryCtx, trigger: CustomAutomationConfig["trigger"] | undefined, destination: Id<"chats">) {
	if (trigger?.type !== "event" || trigger.event !== "message.posted" || trigger.channelId === destination) return null;
	const source = await ctx.db.get(trigger.channelId as Id<"chats">);
	return source?.private ? `It watches #${source.name}, which is private, so it can only post there or to people who turn it on.` : null;
}
