import {
	type Automation,
	type AutomationEvent,
	automationCatalog,
	describeTrigger,
	findAutomation,
	findPlugin,
	grantedPluginIds,
	isValidTimeZone,
	localTime,
	scheduleDue,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { findOrCreateDm, insertMessage } from "./chatOps";
import { getMember, requireAgent, requirePermission } from "./lib";
import { enqueueTurn } from "./turns";

// Install → pick the agent → it runs on its trigger. Each run posts the automation's
// prompt in the agent's DM with each person it runs for and queues a turn acting as
// them, so the reply uses their permissions and plugin accounts (wiki/chat.md).

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

async function installedPluginIds(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("pluginInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	return new Set(installs.map((i) => i.pluginId));
}

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const plugins = await installedPluginIds(ctx, member.workspaceId);
		return Promise.all(
			automationCatalog.map(async (automation) => {
				const install = await installOf(ctx, member.workspaceId, automation.id);
				const agent = install && (await ctx.db.get(install.agentId));
				const granted = agent ? grantedPluginIds(agent) : [];
				return {
					id: automation.id,
					name: automation.name,
					description: automation.description,
					details: automation.details,
					version: automation.version,
					publisher: automation.publisher,
					trigger: describeTrigger(automation.trigger),
					scheduled: automation.trigger.type === "schedule",
					runsFor: automation.trigger.type === "schedule" ? "Everyone in the workspace" : "The person the event is about",
					prompt: automation.prompt,
					needs: automation.plugins.map((id) => ({
						id,
						name: findPlugin(id)?.name ?? id,
						installed: plugins.has(id),
						granted: granted.includes(id),
					})),
					installed: !!install,
					enabled: install?.enabled ?? false,
					agentId: install?.agentId ?? null,
					agentName: agent?.name ?? null,
					agentArchived: agent?.archived ?? false,
					timeZone: install?.timeZone ?? null,
					lastRunAt: install?.lastRunAt ?? null,
					lastResult: install?.lastResult ?? null,
				};
			}),
		);
	},
});

export const setInstalled = mutation({
	args: { automationId: v.string(), installed: v.boolean(), timeZone: v.string() },
	handler: async (ctx, { automationId, installed, timeZone }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const automation = requireAutomation(automationId);
		const existing = await installOf(ctx, owner.workspaceId, automationId);
		if (!installed) {
			if (existing) await ctx.db.delete(existing._id);
			return;
		}
		if (existing) return;
		if (!isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
		const plugins = await installedPluginIds(ctx, owner.workspaceId);
		const missing = automation.plugins.filter((id) => !plugins.has(id)).map((id) => findPlugin(id)?.name ?? id);
		if (missing.length > 0) throw new ConvexError(`Install the ${missing.join(", ")} plugin first.`);
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", owner.workspaceId))
			.filter((q) => q.eq(q.field("archived"), false))
			.first();
		if (!agent) throw new ConvexError("Create an agent first.");
		// Installed after today's time: start tomorrow rather than firing right away.
		const now = localTime(Date.now(), timeZone);
		const startsTomorrow = automation.trigger.type === "schedule" && now.time >= automation.trigger.time;
		await ctx.db.insert("automationInstalls", {
			workspaceId: owner.workspaceId,
			automationId,
			agentId: agent._id,
			enabled: true,
			timeZone,
			installedBy: owner.userId,
			lastRunDate: startsTomorrow ? now.date : undefined,
		});
	},
});

export const update = mutation({
	args: { automationId: v.string(), enabled: v.optional(v.boolean()), agentId: v.optional(v.id("agents")) },
	handler: async (ctx, { automationId, enabled, agentId }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const install = await installOf(ctx, owner.workspaceId, automationId);
		if (!install) throw new ConvexError("Install it first.");
		if (agentId) {
			const agent = await requireAgent(ctx, owner, agentId);
			if (agent.archived) throw new ConvexError("That agent is archived.");
		}
		await ctx.db.patch(install._id, { ...(enabled !== undefined && { enabled }), ...(agentId && { agentId }) });
	},
});

/** Runs it once now, for the owner alone, so they can see what it does. */
export const runNow = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const automation = requireAutomation(automationId);
		const install = await installOf(ctx, owner.workspaceId, automationId);
		if (!install) throw new ConvexError("Install it first.");
		const result = await run(ctx, install, automation, [owner.userId]);
		if (result.sent === 0) throw new ConvexError(result.summary);
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
			const automation = findAutomation(install.automationId);
			if (!automation) continue;
			const due = scheduleDue(automation.trigger, Date.now(), install.timeZone, install.lastRunDate);
			if (!due) continue;
			const members = await ctx.db
				.query("members")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
				.collect();
			await ctx.db.patch(install._id, { lastRunDate: due });
			await run(
				ctx,
				install,
				automation,
				members.map((m) => m.userId),
			);
		}
	},
});

/**
 * Something happened for a person (a call ended, …): runs the workspace's enabled
 * automations for that event, for them. Event sources call this; none are wired yet.
 */
export const fire = internalMutation({
	args: { workspaceId: v.id("workspaces"), userId: v.id("users"), event: v.literal("call.ended") },
	handler: async (ctx, { workspaceId, userId, event }) => {
		for (const automation of automationCatalog) {
			if (automation.trigger.type !== "event" || automation.trigger.event !== (event satisfies AutomationEvent)) continue;
			const install = await installOf(ctx, workspaceId, automation.id);
			if (install?.enabled) await run(ctx, install, automation, [userId]);
		}
	},
});

/**
 * Posts the prompt in each person's DM with the agent, as them, and queues the agent's
 * reply there. The turn queue handles a reply already running, so nobody is skipped.
 */
async function run(ctx: MutationCtx, install: Doc<"automationInstalls">, automation: Automation, userIds: Id<"users">[]) {
	const agent = await ctx.db.get(install.agentId);
	if (!agent || agent.archived) {
		const summary = "Didn't run: its agent is archived or deleted. Pick another agent.";
		await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastResult: summary });
		return { sent: 0, summary };
	}
	for (const userId of userIds) {
		const chatId = await findOrCreateDm(ctx, install.workspaceId, userId, [userId], [agent._id]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			authorUserId: userId,
			text: automation.prompt,
			parts: [{ type: "text", text: automation.prompt }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
			automation: { id: automation.id, name: automation.name },
		});
		await enqueueTurn(ctx, chat, { agentId: agent._id, chatId, triggerId, actorId: userId });
	}
	const sent = userIds.length;
	const summary = `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`;
	await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastResult: summary });
	return { sent, summary };
}
