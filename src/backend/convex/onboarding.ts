import { type TutorialStep, type Welcome, tutorialStepsFor, welcomeText } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { addToChat, findOrCreateDm, insertMessage } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, getMember, preferencesOf, requireMember } from "./lib";
import { memoryOn } from "./turns";

// Onboarding (wiki/chat.md): the main agent welcomes a new workspace's owner in #general and
// each person who joins in their DM with it. New people get a tutorial above the composer whose
// steps tick off as they do them.

/** A new member's tutorial: nothing done yet. People who joined before it get none. */
export const freshTutorial = (): NonNullable<Doc<"members">["tutorial"]> => ({ done: [] });

/**
 * The workspace's main agent (its oldest active one, Companybot unless renamed) speaks first: the
 * company intro in #general, where everyone gains from it; getting to know someone who joins in
 * their DM, so #general doesn't fill with one intro per person. Fixed text (core `welcomeText`),
 * so it costs nothing.
 */
export async function welcome(ctx: MutationCtx, general: Doc<"chats">, userId: Id<"users">, kind: Welcome) {
	const agent = await ctx.db
		.query("agents")
		.withIndex("by_workspace_active", (q) => q.eq("workspaceId", general.workspaceId).eq("archived", false))
		.first();
	if (!agent) return;
	await addToChat(ctx, general, { agentId: agent._id });
	const chat = kind === "joined" ? await ctx.db.get(await findOrCreateDm(ctx, general.workspaceId, userId, [userId], [agent._id])) : general;
	if (!chat) return;
	// Only a name they set: an email isn't what anyone wants to be called.
	const name = (await preferencesOf(ctx, userId))?.displayName || null;
	const text = welcomeText(kind, { agent: agent.name, name, memory: await memoryOn(ctx, general.workspaceId) });
	await insertMessage(ctx, chat, { authorAgentId: agent._id, text, parts: [{ type: "text", text }], mentions: { userIds: [], agentIds: [] }, status: "done" });
}

/** Ticks off steps someone just did (falsy entries skipped). Free for people with no tutorial, or who hid it. */
export async function completeSteps(ctx: MutationCtx, member: Member, steps: (TutorialStep | false | undefined)[]) {
	const tutorial = (await ctx.db.get(member.id))?.tutorial;
	if (!tutorial || tutorial.dismissed) return;
	const fresh = steps.filter((s): s is TutorialStep => !!s && !tutorial.done.includes(s));
	if (fresh.length > 0) await ctx.db.patch(member.id, { tutorial: { ...tutorial, done: [...tutorial.done, ...fresh] } });
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
