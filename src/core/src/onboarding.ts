import { can } from "./permissions";
import type { Role } from "./types";

// Onboarding: Companybot's welcome in #general, and the tutorial above the composer (wiki/chat.md).
// No dependencies, so the app can import it.

/** Why a turn starts with no message: someone made the workspace, or joined it. */
export type Welcome = "new_workspace" | "joined";

/** Asked one at a time. The person who makes the workspace answers for the company too. */
export const welcomeQuestions: Record<Welcome, string[]> = {
	new_workspace: [
		"their role",
		"what the company does",
		"who its customers are",
		"the top goal right now",
		"the tools they use today",
	],
	// What the company does is known by now: ask only about them.
	joined: ["their role", "what they're working on right now"],
};

/** The tutorial's steps, in order. Each completes when the person does it (backend onboarding.ts). */
export const tutorialSteps = ["mention", "dm", "thread", "invite"] as const;
export type TutorialStep = (typeof tutorialSteps)[number];

/** Everyone gets the same steps; people who can invite get that one too. */
export const tutorialStepsFor = (role: Role): TutorialStep[] =>
	tutorialSteps.filter((s) => s !== "invite" || can(role, "members.manage"));
