import { type AutomationAudience, type AutomationSummary, type AutomationToolInput, type CustomAutomationConfig, describeTrigger, weekdayIndex } from "@companybot/core";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { channelNamed } from "./chatOps";
import { asToolResult, nameOf, timeZoneOf } from "./lib";
import { definitionOf, installOf, runsForLabel, subscribersOf, visibleInstalls, webhookUrl } from "./automationOps";
import { createAutomation, setSubscription } from "./automations";
import { runningTurn } from "./turns";

// ---- Agent tools (core's AutomationStore), acting as the turn's person ----

export const listFor = internalQuery({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }): Promise<AutomationSummary[]> => {
		const { member } = await runningTurn(ctx, turnId);
		const installs = await visibleInstalls(ctx, member);
		const rows = await Promise.all(
			installs.map(async (install) => {
				const automation = await definitionOf(ctx, install);
				if (!automation) return null; // its library entry was removed
				const audience = install.audience;
				const channel = (install.channelId && (await ctx.db.get(install.channelId))) || null;
				return {
					id: install.automationId,
					name: automation.name,
					when: describeTrigger(automation.trigger),
					runsFor: runsForLabel(audience, channel, automation.trigger.type === "schedule", await nameOf(ctx, install.installedBy)),
					onForYou: audience === "subscribers" ? (await subscribersOf(ctx, install._id)).includes(member.userId) : null,
					madeByYou: !!install.custom && install.installedBy === member.userId,
				};
			}),
		);
		return rows.filter((row) => row !== null);
	},
});

export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), input: v.any() },
	handler: async (ctx, { turnId, input }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const { name, prompt, trigger: t, runsFor } = input as AutomationToolInput;
		return asToolResult(async () => {
			let trigger: CustomAutomationConfig["trigger"];
			if (t.type === "schedule") trigger = { type: "schedule", time: t.time, weekdays: [...new Set(t.days.map(weekdayIndex))] };
			else if (t.type === "webhook") trigger = { type: "webhook" };
			else if (t.type === "member_joined") trigger = { type: "event", event: "member.joined" };
			else {
				const chat = await channelNamed(ctx, member, t.channel);
				if (!chat) return { error: `There's no channel ${t.channel} they can see.` };
				trigger = { type: "event", event: "message.posted", channelId: chat._id };
			}
			const who = (runsFor ?? "me").trim().toLowerCase();
			let audience: AutomationAudience = "creator";
			let channelId: Id<"chats"> | undefined;
			if (who === "anyone") audience = "subscribers";
			else if (who.startsWith("#")) {
				const chat = await channelNamed(ctx, member, who);
				if (!chat) return { error: `There's no channel ${runsFor} they can see.` };
				audience = "channel";
				channelId = chat._id;
			} else if (who !== "me" && who !== "") return { error: 'runsFor must be "me", "anyone", or a channel like "#sales".' };
			const timeZone = await timeZoneOf(ctx, member.userId);
			const id = await createAutomation(ctx, member, {
				config: { name, prompt, trigger },
				agentId: turn.agentId,
				audience,
				channelId,
				timeZone,
			});
			const install = (await installOf(ctx, member.workspaceId, id))!;
			const automation = (await definitionOf(ctx, install))!;
			const channel = channelId ? await ctx.db.get(channelId) : null;
			return {
				created: id,
				name: automation.name,
				when: describeTrigger(automation.trigger) + (trigger.type === "schedule" ? ` (${timeZone})` : ""),
				runsFor: runsForLabel(audience, channel, trigger.type === "schedule", await nameOf(ctx, member.userId)),
				...(install.webhookToken && { webhookUrl: webhookUrl(install.webhookToken) }),
			};
		});
	},
});

export const setMineFor = internalMutation({
	args: { turnId: v.id("agentTurns"), id: v.string(), on: v.boolean() },
	handler: async (ctx, { turnId, id, on }) => {
		const { member } = await runningTurn(ctx, turnId);
		const problem = await setSubscription(ctx, member, id, on);
		return problem ? { error: problem } : { id, on };
	},
});
