import { Email } from "@convex-dev/auth/providers/Email";
import { convexAuth } from "@convex-dev/auth/server";
import { Resend } from "resend";

// Sign in with a 6-digit code sent by email. No passwords.
const EmailCode = Email({
	id: "email-code",
	apiKey: process.env.AUTH_RESEND_KEY,
	maxAge: 60 * 15,
	async generateVerificationToken() {
		return randomDigits(6);
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

/** Uniform random digits. Rejection sampling avoids the bias of `byte % 10`. */
function randomDigits(length: number) {
	let code = "";
	while (code.length < length) {
		const [byte] = crypto.getRandomValues(new Uint8Array(1));
		if (byte !== undefined && byte < 250) code += String(byte % 10);
	}
	return code;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
	providers: [EmailCode],
});
