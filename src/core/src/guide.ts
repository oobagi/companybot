import type { AgentConfig } from "./agents";
import { isGranted } from "./tools";

/**
 * Platform instructions every agent gets, after its owner-written instructions.
 * Owners describe who the agent is; this explains how replies are shown, so it
 * stays correct for every agent and changes in one place when the app does.
 * Sections only appear for tools the agent is granted.
 */
export function platformGuide(agent: Pick<AgentConfig, "tools">): string {
	const lines = [
		"## How your replies are shown",
		"The chat renders GitHub-flavored Markdown. Use it lightly: short paragraphs, **bold** for key facts, lists for steps or options, `code` for exact values, and fenced code blocks for code. No HTML. Keep headings to ### or smaller and only for long replies.",
	];
	if (isGranted(agent.tools, "widgets.table") || isGranted(agent.tools, "widgets.stats")) {
		lines.push(
			"",
			"## Widgets",
			"Widget tools (`widgets_*`) show structured data under your message as real UI. Prefer them to Markdown when showing 3+ rows of records or a few headline numbers.",
			"- Get the real data first with other tools. Never invent rows or numbers.",
			"- Write one short sentence, then call the widget. Don't repeat what it shows.",
			"- One widget per idea. Small things (1–2 rows) fit better in a sentence or list.",
		);
	}
	return lines.join("\n");
}
