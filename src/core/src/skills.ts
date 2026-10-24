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

// ---- Skills people make ----

/**
 * What someone writes when they make their own skill. Field names and limits follow
 * Claude's Agent Skills (SKILL.md `name` / `description` frontmatter, body loaded on
 * demand): https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
 */
export interface CustomSkillConfig {
	name: string;
	/** What it does and when to use it. Agents see it in every prompt, so it stays short. */
	description: string;
	/** Markdown, loaded only when an agent calls `skills.load`. */
	instructions: string;
}

/** Claude's limit for `name`. */
export const SKILL_NAME_MAX = 64;
/** Stricter than Claude's 1,024: every installed skill's description is in every agent prompt. */
export const SKILL_DESCRIPTION_MAX = 200;
/** About 5k tokens, Claude's guidance for a SKILL.md body. */
export const SKILL_INSTRUCTIONS_MAX = 20_000;

const xmlTag = /<\/?[a-zA-Z][^>]*>/;

/** The first problem with a custom skill, in a line, or null. */
export function customSkillError(config: CustomSkillConfig): string | null {
	const name = config.name.trim();
	if (!name) return "Give it a name.";
	if (name.length > SKILL_NAME_MAX) return `Keep the name under ${SKILL_NAME_MAX} characters.`;
	const description = config.description.trim();
	if (!description) return "Say what it does and when to use it.";
	if (description.length > SKILL_DESCRIPTION_MAX) return `Keep the description under ${SKILL_DESCRIPTION_MAX} characters.`;
	if (xmlTag.test(name) || xmlTag.test(description)) return "The name and description can't contain tags like <this>.";
	const instructions = config.instructions.trim();
	if (!instructions) return "Write the instructions.";
	if (instructions.length > SKILL_INSTRUCTIONS_MAX)
		return `Keep the instructions under ${SKILL_INSTRUCTIONS_MAX.toLocaleString("en-US")} characters.`;
	return null;
}

/** Agents make skills for the person they're helping, with the same rules as the app. */
export interface SkillStore {
	create(config: CustomSkillConfig): Promise<{ created: string; name: string } | { error: string }>;
}

/** A custom skill as the same shape the catalog uses, so agents load both the same way. */
export function customSkill(id: string, config: CustomSkillConfig, version: number): Skill {
	return {
		id,
		name: config.name.trim(),
		description: config.description.trim(),
		version: String(version),
		instructions: config.instructions.trim(),
	};
}

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
