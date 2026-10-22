/**
 * A skill is a set of instructions an agent loads when a task calls for it.
 * Agents see every installed skill's name and description, and pull the full
 * instructions only when needed, so unused skills cost almost no context.
 */
export interface Skill {
	id: string;
	name: string;
	description: string;
	version: string;
	instructions: string;
}

export const defineSkill = (skill: Skill) => skill;

/** The skills marketplace. */
export const skillCatalog: Skill[] = [
	defineSkill({
		id: "meeting-notes",
		name: "Meeting notes",
		description: "Turn rough meeting notes into a summary with decisions and action items.",
		version: "0.1.0",
		instructions: `Rewrite the notes as:
1. **Summary** — two or three sentences.
2. **Decisions** — bullet list. Write "None" if there were none.
3. **Action items** — "- [ ] Owner: task (due date if mentioned)".
Keep the people's own wording for decisions. Don't invent owners or dates.`,
	}),
	defineSkill({
		id: "email-reply",
		name: "Email reply",
		description: "Draft a short, friendly reply to an email.",
		version: "0.1.0",
		instructions: `Draft a reply that:
- Opens by answering the main question directly.
- Stays under 120 words unless the email needs more.
- Ends with one clear next step.
- Uses a warm, plain tone. No "I hope this email finds you well."
Offer one alternative subject line only if the original is unclear.`,
	}),
];

/** One line per skill, for the agent's instructions. */
export const skillsIndex = (skills: Skill[]) =>
	skills.length === 0
		? ""
		: `Skills you can load with skills_load before doing a task they cover:\n${skills
				.map((s) => `- ${s.id}: ${s.description}`)
				.join("\n")}`;
