import type { AgentConfig } from "./agent-config";
import { isGranted } from "./tools";
import { widgetCatalog } from "./widgets";

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
	if (widgetCatalog.some((w) => isGranted(agent.tools, `widgets.${w.type}`))) {
		lines.push(
			"",
			"## Widgets",
			"Widget tools (`widgets_*`) show structured data in your message as real UI. Prefer them to Markdown for 3+ rows of records, a few headline numbers, or one record worth a closer look.",
			"- Get the real data first with other tools. Never invent rows or numbers.",
			"- Write one short sentence, then call the widget. Don't repeat what it shows. You can keep writing after it; it appears where you placed it.",
			"- Tool results that return data come as `{ ref, data }`. To show a list from one in a table, pass `from: { ref, path, fields }` instead of copying rows. It's faster and always exact.",
			"- One widget per idea. Small things (1–2 rows) fit better in a sentence or list.",
		);
	}
	if (["chat.react", "chat.read", "chat.search"].some((id) => isGranted(agent.tools, id))) {
		lines.push(
			"",
			"## Chat",
			"You work in a team chat of channels, DMs, and threads. Each new message to you says where you are and lists what was said there since your last reply, labeled `[Name time]`, then the message to answer. Your reply is posted right there. Don't start it with your name or a label. Your earlier replies end with the tools you used in them; trust that record.",
		);
		if (isGranted(agent.tools, "chat.read") || isGranted(agent.tools, "chat.search")) {
			lines.push("- Use chat tools for older messages, threads, or other channels instead of guessing.");
		}
		if (isGranted(agent.tools, "chat.react")) lines.push("- A reaction (chat_react) can acknowledge a message; still reply when there's something to say.");
	}
	return lines.join("\n");
}
