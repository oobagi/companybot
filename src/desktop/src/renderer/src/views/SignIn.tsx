import { isLocalBackend } from "@companybot/core/local-auth";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Notice } from "../ui";

export function SignIn() {
	const { signIn } = useAuthActions();
	const convex = useConvex();
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [sentTo, setSentTo] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	const run = async (fields: Record<string, string>, then?: () => unknown) => {
		setBusy(true);
		setError(undefined);
		try {
			await signIn("email-code", fields);
			await then?.();
		} catch (e) {
			setError(sentTo ? "That code didn't work. Try again." : errorMessage(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="drag flex h-screen items-center justify-center bg-neutral-50">
			<form
				className="no-drag flex w-80 flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					const to = email.trim();
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
						<p className="text-sm text-neutral-500">We sent a 6-digit code to {sentTo}.</p>
						<input
							autoFocus
							inputMode="numeric"
							autoComplete="one-time-code"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="123456"
							className="rounded-xl border border-neutral-200 bg-white px-3 py-2 tracking-widest outline-none focus:border-neutral-300"
						/>
					</>
				) : (
					<input
						autoFocus
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="you@company.com"
						className="rounded-xl border border-neutral-200 bg-white px-3 py-2 outline-none focus:border-neutral-300"
					/>
				)}
				{error && <Notice>{error}</Notice>}
				<button type="submit" disabled={busy} className="rounded-xl bg-neutral-900 py-2 text-sm text-white disabled:opacity-50">
					{sentTo ? "Sign in" : "Email me a code"}
				</button>
				{sentTo && (
					<button
						type="button"
						onClick={() => (setSentTo(undefined), setCode(""), setError(undefined))}
						className="text-sm text-neutral-500"
					>
						Use a different email
					</button>
				)}
			</form>
		</div>
	);
}
