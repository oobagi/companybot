import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { type RandomReader, generateRandomString } from "@oslojs/crypto/random";
import { Resend } from "resend";

// Sign in with a 6-digit code sent by email. No passwords.
const EmailCode = Email({
	id: "email-code",
	apiKey: process.env.AUTH_RESEND_KEY,
	maxAge: 60 * 15,
	async generateVerificationToken() {
		const random: RandomReader = {
			read: (bytes) => {
				crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
			},
		};
		return generateRandomString(random, "0123456789", 6);
	},
	async sendVerificationRequest({ identifier: email, provider, token }) {
		const { error } = await new Resend(provider.apiKey).emails.send({
			from: process.env.AUTH_EMAIL_FROM ?? "Companybot <onboarding@resend.dev>",
			to: [email],
			subject: `Your Companybot code: ${token}`,
			text: `Your Companybot sign-in code is ${token}. It expires in 15 minutes.`,
		});
		if (error) throw new Error(JSON.stringify(error));
	},
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [EmailCode],
});
