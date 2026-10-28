import { isLocalBackend } from "@companybot/core/local-auth";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Form, Notice, descriptionClass, inputClass, primaryButton, useRun } from "../ui";

export function SignIn() {
	const { signIn } = useAuthActions();
	const convex = useConvex();
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [sentTo, setSentTo] = useState<string>();
	const { error, busy, run: submit, fail } = useRun((e) => (sentTo ? "That code didn't work. Try again." : errorMessage(e)));
	const run = (fields: Record<string, string>, then?: () => unknown) => submit(signIn("email-code", fields).then(then));

	return (
		<div className="drag flex h-screen items-center justify-center bg-neutral-50">
			<Form
				className="no-drag flex w-80 flex-col gap-3"
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
				<h1 className="text-xl font-medium">Sign in to Companybot</h1>
				{sentTo ? (
					<>
						<p className={descriptionClass}>We sent a 6-digit code to {sentTo}.</p>
						<input
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="123456"
							className={`${inputClass} bg-white tracking-widest`}
						/>
					</>
				) : (
					<input
						autoFocus
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="you@company.com"
						className={`${inputClass} bg-white`}
					/>
				)}
				<Notice>{error}</Notice>
				<button type="submit" disabled={busy} className={primaryButton}>
					{sentTo ? "Sign in" : "Email me a code"}
				</button>
				{sentTo && (
					<button
						type="button"
						onClick={() => (setSentTo(undefined), setCode(""), fail())}
						className={descriptionClass}
					>
						Use a different email
					</button>
				)}
			</Form>
		</div>
	);
}
