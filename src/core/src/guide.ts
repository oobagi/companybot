import type { AgentConfig } from "./agent-config";
import { grantedConnectorIds } from "./agents";
import { chatTools } from "./chat";
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
	if (grantedConnectorIds(agent).length > 0) {
		lines.push(
			"",
			"## Connected services",
			"Tools for outside services aren't loaded up front. When a message lists connected services and you need one, call connectors_search: with an empty query first if you haven't used that service yet in this conversation (it lists every tool and the service's usage notes; follow them), then with a few words or exact tool ids to get input schemas. Run tools with connectors_call. Reuse what you found earlier in this conversation instead of searching again.",
			"- Calls that change something in an outside service wait for the person you act for to approve them in the chat; your reply ends there and you hear the outcome in a later message. The approval is the confirmation, so don't also ask for a yes in text; do ask if details are missing.",
		);
	}
	if (chatTools.some((t) => isGranted(agent.tools, t.id))) {
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
	if (isGranted(agent.tools, "skills.create")) {
		lines.push(
			"",
			"## Saving skills",
			"When someone explains how the team does something you'll be asked again (\"here's how we write proposals\"), or asks you to remember a process for everyone, offer to save it as a skill. Skills are shared with the whole team; personal preferences belong in memory instead.",
			"- Ask only for what's missing: the steps, rules, and an example if they have one.",
			"- Show the name, the one-line description of when to use it, and the instructions, and ask them to confirm. Then call skills_create and say where they can change it: Customize → Skills.",
		);
	}
	if (isGranted(agent.tools, "automations.create")) {
		lines.push(
			"",
			"## Setting up automations",
			"People can ask you to do something on a schedule, when something happens here, or when another app sends a webhook. Most aren't technical: never say \"trigger\", \"webhook\", or \"audience\" unless they do.",
			"- Ask only for what's missing, one short question at a time: what you should do each time, when (time and days, or which channel to watch, or when someone joins), and who gets it (just them by default; \"anyone who turns it on\"; or a channel).",
			"- Write the prompt as them asking you, specific enough to run alone later.",
			"- Before creating it, show a 3-line summary (what, when, who gets it) and ask them to confirm. Then call automations_create and say where they can change it: Customize → Automations.",
			"- Only offer a webhook if they mention an outside app that can send one; give them the URL it returns and say to keep it secret.",
			"- To turn on an existing one for them (\"I want the morning brief too\"), find it with automations_list and use automations_set_mine.",
		);
	}
	return lines.join("\n");
}
