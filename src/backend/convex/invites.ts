import { INVITE_EMAILS_PER_DAY, INVITE_RESEND_MS, inviteEmail, isLocalBackend } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { Resend } from "resend";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction } from "./_generated/server";
import { nameOf } from "./lib";

// Invite emails. Sent through the same Resend account as sign-in codes (auth.ts).

const DAY_MS = 24 * 60 * 60_000;

/**
 * Queues the email for an invite, unless the workspace has sent too many today, or (`resend`)
 * this address got one a moment ago. Throws why not.
 */
export async function sendInviteEmail(ctx: MutationCtx, invite: Doc<"invites">, inviter: Id<"users">, { resend = false } = {}) {
	const now = Date.now();
	const last = resend && (await ctx.db
		.query("inviteEmails")
		.withIndex("by_email", (q) => q.eq("workspaceId", invite.workspaceId).eq("email", invite.email))
		.order("desc")
		.first());
	if (last && now - last._creationTime < INVITE_RESEND_MS) throw new ConvexError("Email sent a moment ago. Try again in a few minutes.");
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
	await ctx.scheduler.runAfter(0, internal.invites.deliver, { to: invite.email, ...content });
}

export const deliver = internalAction({
	args: { to: v.string(), subject: v.string(), text: v.string(), html: v.string() },
	handler: async (_ctx, { to, subject, text, html }) => {
		// Local backends (`pnpm dev`) and tests send no email; the log shows what would have gone out.
		if (isLocalBackend(process.env.CONVEX_CLOUD_URL) || !process.env.AUTH_RESEND_KEY) return void console.log(`Invite email to ${to}: ${subject}\n\n${text}`);
		const { error } = await new Resend(process.env.AUTH_RESEND_KEY).emails.send({
			from: process.env.AUTH_EMAIL_FROM ?? "Companybot <onboarding@resend.dev>",
			to: [to],
			subject,
			text,
			html,
		});
		if (error) throw new Error(JSON.stringify(error));
	},
});
