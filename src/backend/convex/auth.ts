import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { isLocalBackend } from "@companybot/core";
import { internal } from "./_generated/api";
import { type ActionCtx, internalMutation, query } from "./_generated/server";
import { sendEmail } from "./invites";

// Sign in with a 6-digit code sent by email. No passwords.
const EmailCode = Email({
	id: "email-code",
	apiKey: process.env.AUTH_RESEND_KEY,
	maxAge: 60 * 15,
	async generateVerificationToken() {
		return randomDigits(6);
	},
	// Convex Auth passes ctx too; the Auth.js type it also satisfies doesn't, hence optional.
	async sendVerificationRequest(
		{ identifier: email, provider, token }: { identifier: string; provider: { apiKey?: string }; token: string },
		ctx?: ActionCtx,
	) {
		if (isLocal() && ctx) return void (await ctx.runMutation(internal.auth.saveLocalCode, { email, code: token }));
		await sendEmail(provider.apiKey, {
			to: email,
			subject: `Your Companybot code: ${token}`,
			text: `Your Companybot sign-in code is ${token}. It expires in 15 minutes.`,
		});
	},
});

/** Uniform random digits. Rejection sampling avoids the bias of `byte % 10`. */
function randomDigits(length: number) {
	let code = "";
	while (code.length < length) {
		const [byte] = crypto.getRandomValues(new Uint8Array(1));
		if (byte !== undefined && byte < 250) code += String(byte % 10);
	}
	return code;
}

const isLocal = () => isLocalBackend(process.env.CONVEX_CLOUD_URL);

// ---- Local backends only (`pnpm dev`): no email; the app reads the code and signs in. ----

export const saveLocalCode = internalMutation({
	args: { email: v.string(), code: v.string() },
	handler: async (ctx, { email, code }) => {
		if (!isLocal()) return;
		const existing = await ctx.db
			.query("localSignInCodes")
			.withIndex("by_email", (q) => q.eq("email", email))
			.first();
		if (existing) await ctx.db.patch(existing._id, { code });
		else await ctx.db.insert("localSignInCodes", { email, code });
	},
});

export const localCode = query({
	args: { email: v.string() },
	handler: async (ctx, { email }) => {
		if (!isLocal()) return null;
		const row = await ctx.db
			.query("localSignInCodes")
			.withIndex("by_email", (q) => q.eq("email", email))
			.first();
		return row?.code ?? null;
	},
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [EmailCode],
});
