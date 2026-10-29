import { isLocalBackend } from "@companybot/core/local-auth";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Field, Form, Notice, descriptionClass, inputClass, primaryButton, useRun } from "../ui";
import { Mark, Split } from "./Landing";

/**
 * Email, then the 6-digit code it was sent: one flow for a first sign-in and every one after.
 * The form sits centered on the left half; the right half is a picture, so the screen isn't a lone box.
 */
export function SignIn({ onBack }: { onBack?: () => void }) {
	const { signIn } = useAuthActions();
	const convex = useConvex();
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [sentTo, setSentTo] = useState<string>();
	const { error, busy, run: submit, fail } = useRun((e) => (sentTo ? "That code didn't work. Try again." : errorMessage(e)));
	const run = (fields: Record<string, string>, then?: () => unknown) => submit(signIn("email-code", fields).then(then));

	return (
		<Split>
			<Form
				className="flex w-full flex-col gap-6 text-left"
				onSubmit={() => {
					const to = email.trim();
					// The browser accepts "jaden@c"; a cut-off address would sign in as a new, wrong person.
					if (!sentTo && !/^\S+@\S+\.\S+$/.test(to)) return fail("Enter your full email address.");
					if (sentTo) run({ email: sentTo, code: code.trim() });
					else if (isLocalBackend(import.meta.env.CONVEX_URL)) {
						// Local backend: no email is sent, so read the code back and sign straight in.
						run({ email: to }, async () => {
							const localCode = await convex.query(api.auth.localCode, { email: to });
							if (localCode) await signIn("email-code", { email: to, code: localCode });
						});
					} else run({ email: to }, () => setSentTo(to));
				}}
			>
				<div className="flex flex-col items-center gap-5 text-center">
					<Mark className="size-12 rounded-xl text-xl" />
					<h1 className="text-xl font-semibold tracking-tight text-neutral-900">{sentTo ? "Check your email" : "Sign in to Companybot"}</h1>
					<p className={descriptionClass}>{sentTo ? `We sent a 6-digit code to ${sentTo}.` : "New here? Your first sign-in makes your account."}</p>
				</div>
				{sentTo ? (
					<Field label="Code">
						<input
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="123456"
							className={`${inputClass} bg-white py-2.5 tracking-widest`}
						/>
					</Field>
				) : (
					<Field label="Email" hint="No password. We'll email you a code.">
						<input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={`${inputClass} bg-white py-2.5`} />
					</Field>
				)}
				<Notice>{error}</Notice>
				<div className="flex flex-col gap-4">
					<button type="submit" disabled={busy} className={`${primaryButton} py-2.5`}>
						{sentTo ? "Sign in" : "Email me a code"}
					</button>
					{sentTo ? (
						<button type="button" onClick={() => (setSentTo(undefined), setCode(""), fail())} className={`${descriptionClass} hover:text-neutral-700`}>
							Use a different email
						</button>
					) : (
						onBack && (
							<button type="button" onClick={onBack} className={`${descriptionClass} hover:text-neutral-700`}>
								Back
							</button>
						)
					)}
				</div>
			</Form>
		</Split>
	);
}
