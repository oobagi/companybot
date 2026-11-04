import { INVITE_EMAILS_PER_DAY, INVITE_RESEND_MS, inviteEmail, isLocalBackend } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { Resend } from "resend";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction, internalQuery } from "./_generated/server";
import { liveWorkspace, nameOf } from "./lib";

// Invite emails. Sent through the same Resend account as sign-in codes (auth.ts).

const DAY_MS = 24 * 60 * 60_000;

/**
 * Queues the email for an invite. Each address gets at most one per 10 minutes from a
 * workspace, however its invites come and go: a resend inside that window is refused, a new
 * invite is saved without an email. Over the workspace's daily cap, it throws.
 * Returns whether an email went out.
 */
export async function sendInviteEmail(ctx: MutationCtx, invite: Doc<"invites">, inviter: Id<"users">, { resend = false } = {}) {
	const now = Date.now();
	const last = await ctx.db
		.query("inviteEmails")
		.withIndex("by_email", (q) => q.eq("workspaceId", invite.workspaceId).eq("email", invite.email))
		.order("desc")
		.first();
	if (last && now - last._creationTime < INVITE_RESEND_MS) {
		if (resend) throw new ConvexError("Email sent a moment ago. Try again in a few minutes.");
		return false;
	}
	const today = await ctx.db
		.query("inviteEmails")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", invite.workspaceId).gt("_creationTime", now - DAY_MS))
		.take(INVITE_EMAILS_PER_DAY);
	if (today.length >= INVITE_EMAILS_PER_DAY) throw new ConvexError(`You've sent ${INVITE_EMAILS_PER_DAY} invite emails today. Try again tomorrow.`);
	// Older rows only ever served the limits above.
	for (const old of await ctx.db
		.query("inviteEmails")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", invite.workspaceId).lt("_creationTime", now - DAY_MS))
		.take(50))
		await ctx.db.delete(old._id);
	await ctx.db.insert("inviteEmails", { workspaceId: invite.workspaceId, email: invite.email });

	const workspace = await ctx.db.get(invite.workspaceId);
	const content = inviteEmail({ inviter: await nameOf(ctx, inviter), workspace: workspace?.name ?? "a workspace", email: invite.email });
	await ctx.scheduler.runAfter(0, internal.invites.deliver, { inviteId: invite._id, to: invite.email, ...content });
	return true;
}

/** Whether an invite can still be used: not cancelled, accepted or declined, and its workspace not being deleted. */
export const stillOpen = internalQuery({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }) => {
		const invite = await ctx.db.get(id);
		return !!invite && !!(await liveWorkspace(ctx, invite.workspaceId));
	},
});

export const deliver = internalAction({
	args: { inviteId: v.id("invites"), to: v.string(), subject: v.string(), text: v.string(), html: v.string() },
	handler: async (ctx, { inviteId, to, subject, text, html }) => {
		if (!(await ctx.runQuery(internal.invites.stillOpen, { id: inviteId }))) return;
		// Local backends (`pnpm dev`) and tests send no email; the log shows what would have gone out.
		if (isLocalBackend(process.env.CONVEX_CLOUD_URL) || !process.env.AUTH_RESEND_KEY) return void console.log(`Invite email to ${to}: ${subject}\n\n${text}`);
		await sendEmail(process.env.AUTH_RESEND_KEY, { to, subject, text, html });
	},
});

/** Sends one email through Resend, from AUTH_EMAIL_FROM. */
export async function sendEmail(apiKey: string | undefined, email: { to: string; subject: string; text: string; html?: string }) {
	const { error } = await new Resend(apiKey).emails.send({ from: process.env.AUTH_EMAIL_FROM ?? "Companybot <onboarding@resend.dev>", ...email, to: [email.to] });
	if (error) throw new Error(JSON.stringify(error));
}
