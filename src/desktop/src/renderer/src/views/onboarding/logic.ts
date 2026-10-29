// Onboarding's logic, kept out of the screen so it can be tested.

/** Whole addresses only: a cut-off one would invite a stranger, or nobody. */
const emailPattern = /^\S+@\S+\.\S+$/;

/**
 * The emails typed into "Invite your team": one per line, or separated by commas, semicolons
 * or spaces. Lowercased and deduplicated; `except` (your own address) is dropped, since you're
 * already in. `invalid` lists what isn't an email, in the order typed.
 */
export function parseInvites(text: string, except = ""): { emails: string[]; invalid: string[] } {
	const emails: string[] = [];
	const invalid: string[] = [];
	for (const raw of text.split(/[\s,;]+/)) {
		const email = raw.trim().toLowerCase();
		if (!email || email === except.trim().toLowerCase() || emails.includes(email) || invalid.includes(email)) continue;
		(emailPattern.test(email) ? emails : invalid).push(email);
	}
	return { emails, invalid };
}

export const onboardingSteps = ["you", "company", "team"] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];
