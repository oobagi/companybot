import { type TutorialStep, type Welcome, tutorialStepsFor } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { addToChat, ensureGeneral } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, getMember, requireMember } from "./lib";
import { enqueueTurn } from "./turns";

// Onboarding (wiki/chat.md): the main agent welcomes each new person in #general, and new
// people get a tutorial above the composer whose steps tick off as they do them.

/** A new member's tutorial: nothing done yet. People who joined before it get none. */
export const freshTutorial = (): NonNullable<Doc<"members">["tutorial"]> => ({ done: [] });

/** The workspace's main agent (its oldest active one, Companybot unless renamed) speaks first in #general. */
export async function welcome(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">, kind: Welcome) {
	const agent = await ctx.db
		.query("agents")
		.withIndex("by_workspace_active", (q) => q.eq("workspaceId", workspaceId).eq("archived", false))
		.first();
	if (!agent) return;
	const general = await ensureGeneral(ctx, workspaceId, userId);
	await addToChat(ctx, general, { agentId: agent._id });
	await enqueueTurn(ctx, general, { agentId: agent._id, chatId: general._id, actorId: userId, welcome: kind });
}

/** Ticks off a step someone just did. Free for people with no tutorial, or who finished or hid it. */
export async function completeStep(ctx: MutationCtx, member: Member, step: TutorialStep) {
	const tutorial = (await ctx.db.get(member.id))?.tutorial;
	if (!tutorial || tutorial.dismissed || tutorial.done.includes(step)) return;
	await ctx.db.patch(member.id, { tutorial: { ...tutorial, done: [...tutorial.done, step] } });
}

/** Your tutorial's steps for your role, or null once it's done, hidden, or you never had one. */
export const tutorial = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		const tutorial = member && (await ctx.db.get(member.id))?.tutorial;
		if (!member || !tutorial || tutorial.dismissed) return null;
		const steps = tutorialStepsFor(member.role).map((id) => ({ id, done: tutorial.done.includes(id) }));
		return steps.every((s) => s.done) ? null : steps;
	},
});

export const dismissTutorial = mutation({
	args: {},
	handler: async (ctx) => {
		const { id } = await requireMember(ctx);
		const tutorial = (await ctx.db.get(id))?.tutorial;
		if (tutorial) await ctx.db.patch(id, { tutorial: { ...tutorial, dismissed: true } });
	},
});
