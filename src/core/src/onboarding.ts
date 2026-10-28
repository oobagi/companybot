import { can } from "./permissions";
import type { Role } from "./types";

// Onboarding: Companybot's welcome (#general for a new workspace, a DM for each joiner), and the tutorial above the composer (wiki/chat.md).
// No dependencies, so the app can import it.

/** Why the main agent speaks first: someone made the workspace, or joined it. */
export type Welcome = "new_workspace" | "joined";

/**
 * The main agent's first message. Fixed text, not a model call: making or joining a workspace
 * costs nothing, and there's no multi-turn script for a thread or a later turn to lose. One open
 * ask instead of a question-by-question interview; the reply is an ordinary turn, and the agent
 * sees this message in its history.
 */
export function welcomeText(kind: Welcome, { agent, name, memory }: { agent: string; name: string | null; memory: boolean }) {
	if (kind === "joined")
		return [
			`Welcome${name ? `, ${name}` : ""}! I'm ${agent}. Ask me anything here, and @mention me in channels.`,
			`Tell me your role and what you're working on${memory ? ", and I'll remember it" : ""}.`,
		].join("\n\n");
	return [
		`Hi${name ? ` ${name}` : ""}, I'm ${agent}. I help the whole team here. Outside DMs, I only answer messages that @mention me.`,
		`To get started, @mention me with a few lines about the company: what you do, who your customers are, and what you're focused on right now.${memory ? " I'll save it to team memory, which everyone here can see and edit." : ""}`,
	].join("\n\n");
}

/** The tutorial's steps, in order. Each completes when the person does it (backend onboarding.ts). */
export const tutorialSteps = ["mention", "dm", "thread", "invite"] as const;
export type TutorialStep = (typeof tutorialSteps)[number];

/** Everyone gets the same steps; people who can invite get that one too. */
export const tutorialStepsFor = (role: Role): TutorialStep[] =>
	tutorialSteps.filter((s) => s !== "invite" || can(role, "members.manage"));
