import { type AutomationAudience, type AutomationSummary, type AutomationToolInput, type CustomAutomationConfig, describeTrigger } from "@companybot/core";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalMutation } from "./_generated/server";
import { definitionOf, installOf, runsForLabel, seenChannel, subscribersOf, visibleInstalls, webhookUrl } from "./automationOps";
import { createAutomation, setSubscription } from "./automations";
import { chatByRef } from "./chatOps";
import { type Member, asToolResult, nameOf, timeZoneOf } from "./lib";
import { withReceipt } from "./approvals";
import { runningTurn } from "./turns";

// ---- Agent tools (core's AutomationStore), acting as the turn's person ----

export const listFor = internalMutation({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }): Promise<AutomationSummary[]> => {
		const { member } = await runningTurn(ctx, turnId);
		const installs = await visibleInstalls(ctx, member);
		const rows = await Promise.all(
			installs.map(async (install) => {
				const automation = await definitionOf(ctx, install, member);
				if (!automation) return null; // its library entry was removed
				const audience = install.audience;
				const channel = await seenChannel(ctx, member, install.channelId);
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

/**
 * A channel by id, or "here" (the turn's chat), that the person can see: never by #name, so a held call
 * posts or watches where it was approved even if a rename hands the name to another channel.
 */
async function channelById(ctx: QueryCtx, member: Member, ref: string, here: Id<"chats">) {
	const id = ref === "here" ? here : ctx.db.normalizeId("chats", ref.trim());
	const chat = id && (await chatByRef(ctx, member, id));
	return chat && chat.kind === "channel" && !chat.archived ? chat : null;
}

export const createFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(v.id("approvals")), input: v.any() },
	handler: (ctx, { turnId, op, input }) => withReceipt(ctx, op, turnId, async () => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const { name, prompt, trigger: t, runsFor } = input as AutomationToolInput;
		return asToolResult(async () => {
			let trigger: CustomAutomationConfig["trigger"];
			if (t.type === "schedule") trigger = { type: "schedule", cron: t.cron };
			else if (t.type === "webhook") trigger = { type: "webhook" };
			else if (t.type === "member_joined") trigger = { type: "event", event: "member.joined" };
			else {
				const chat = await channelById(ctx, member, t.channel, turn.chatId);
				if (!chat) return { error: `There's no channel ${t.channel} they can see. Name it by its id, from channels list.` };
				trigger = { type: "event", event: "message.posted", channelId: chat._id };
			}
			const who = (runsFor ?? "me").trim();
			let audience: AutomationAudience = "creator";
			let channelId: Id<"chats"> | undefined;
			if (who.toLowerCase() === "anyone") audience = "subscribers";
			else if (who.toLowerCase() !== "me" && who !== "") {
				const chat = await channelById(ctx, member, who, turn.chatId);
				if (!chat) return { error: 'runsFor must be "me", "anyone", or a channel\'s id (from channels list) or "here".' };
				audience = "channel";
				channelId = chat._id;
			}
			const timeZone = await timeZoneOf(ctx, member.userId);
			const id = await createAutomation(ctx, member, {
				config: { name, prompt, trigger },
				agentId: turn.agentId,
				audience,
				channelId,
				timeZone,
			});
			const install = (await installOf(ctx, member.workspaceId, id))!;
			const automation = (await definitionOf(ctx, install, member))!;
			const channel = channelId ? await ctx.db.get(channelId) : null;
			return {
				created: id,
				name: automation.name,
				when: describeTrigger(automation.trigger) + (trigger.type === "schedule" ? ` (${timeZone})` : ""),
				runsFor: runsForLabel(audience, channel, trigger.type === "schedule", await nameOf(ctx, member.userId)),
				...(install.webhookToken && { webhookUrl: webhookUrl(install.webhookToken) }),
			};
		});
	}),
});

export const setMineFor = internalMutation({
	args: { turnId: v.id("agentTurns"), op: v.optional(v.id("approvals")), id: v.string(), on: v.boolean() },
	handler: (ctx, { turnId, op, id, on }) => withReceipt(ctx, op, turnId, async () => {
		const { member } = await runningTurn(ctx, turnId);
		const problem = await setSubscription(ctx, member, id, on);
		return problem ? { error: problem } : { id, on };
	}),
});
