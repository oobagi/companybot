import type { AgentConfig } from "./agent-config";
import { grantedConnectorIds, resolveTools } from "./agents";
import { chatTools } from "./chat";
import { pageTools } from "./page-tools";
import { recordTools } from "./record-tools";
import { type ToolDef, isGranted, modelToolName } from "./tools";
import { widgetCatalog } from "./widgets";

/**
 * Platform instructions every agent gets, after its owner-written instructions.
 * Owners describe who the agent is; this explains how replies are shown, so it
 * stays correct for every agent and changes in one place when the app does.
 * Sections only appear for tools the agent is granted.
 */
export function platformGuide(agent: Pick<AgentConfig, "tools">, available?: readonly ToolDef[]): string {
	const usable = available ?? resolveTools(agent, { userId: "", role: "owner" });
	const has = (id: string) => usable.some(t => t.id === id);
	const grants = { tools: usable.map(t => t.id) };
	const lines = [
		"## How your replies are shown",
		"The chat renders GitHub-flavored Markdown. Use it lightly: short paragraphs, **bold** for key facts, lists for steps or options, `code` for exact values, and fenced code blocks for code. No HTML. Keep headings to ### or smaller and only for long replies.",
	];
	if (widgetCatalog.some((w) => isGranted(grants.tools, `widgets.${w.type}`))) {
		lines.push(
			"",
			"## Widgets",
			"Widget tools (`widgets_*`) show structured data in your message as real UI. Prefer them to Markdown for 3+ rows of records, a few headline numbers, or one record worth a closer look.",
			"- Get the real data first with other tools. Never invent rows or numbers.",
			"- Say what you did or found in one short sentence, once: before or after the widget, never both. Don't restate what it shows or point at it (\"the table above\", \"below\"). If the task needs more steps after it (\"then mark them all won\"), keep going; otherwise, after it, call no more tools.",
			"- Tool results that return data come as `{ ref, data }`. To show a list from one in a table, pass `from: { ref, path, fields }` instead of copying rows. It's faster and always exact.",
			"- One widget per idea. Small things (1–2 rows) fit better in a sentence or list.",
		);
	}
	if (grantedConnectorIds(agent).length > 0) {
		lines.push(
			"",
			"## Connected services",
			"Tools for outside services aren't loaded up front. When a message lists connected services and you need one, call connectors_search: with an empty query first if you haven't used that service yet in this conversation (it lists every tool and the service's usage notes; follow them), then with a few words or exact tool ids to get input schemas. Run tools with connectors_call. Reuse what you found earlier in this conversation instead of searching again.",
			"- Calls that change something in an outside service wait for the person you act for to approve them in the chat; your reply ends there and you hear the outcome in a later message. The approval is the confirmation, so don't also ask for a yes in text; do ask if details are missing. Some run without asking because the person allowed them; a blocked call says so: tell them and don't retry it.",
		);
	}
	if (chatTools.some((t) => isGranted(grants.tools, t.id))) {
		lines.push(
			"",
			"## Chat",
			"You work in a team chat of channels, DMs, and threads. Each new message to you says where you are and lists what was said there since your last reply, labeled `[Name time]`, then the message to answer. Your reply is posted right there. Don't start it with your name or a label. Your earlier replies end with the tools you used in them; trust that record.",
		);
		if (isGranted(grants.tools, "chat.read") || isGranted(grants.tools, "chat.search")) {
			lines.push("- Use chat tools for older messages, threads, or other channels instead of guessing.");
		}
		if (isGranted(grants.tools, "chat.react")) lines.push("- A reaction (chat_react) can acknowledge a message; still reply when there's something to say.");
	}
	if (recordTools.some(t => has(t.id))) {
		lines.push("", "## Databases", "Customer and work facts belong on records; memory is for preferences. Values come formatted for people; dates in tool input are YYYY-MM-DD. Never convert or sum different currencies.");
		if (has("records.types")) lines.push("- Learn current databases and field keys with records_types. Refresh the schema before writing shared settings; it can change during a conversation.");
		if (has("records.find")) lines.push("- Find before creating to avoid duplicates; ask which record when several match.");
		if (has("records.save_database")) lines.push("- Use records_save_database for database changes only when asked, with a fresh version.");
		if (has("records.views")) lines.push("- Inspect shared views with records_views.");
		if (has("records.save_view")) lines.push("- Change shared views with records_save_view only when asked, with their current version.");
		if (has("records.save") || has("records.save_field")) lines.push("- Changes run right away and are logged as you acting for the person. Confirm before changing more than 3 records. Change fields only when asked.");
		if (has("records.undo")) lines.push("- records_undo reverses a record change by its change id.");
		if (has("widgets.table")) lines.push('- Show 3+ records with widgets_table using the result ref, path "rows", and field keys.');
		if (has("widgets.card")) lines.push("- Use widgets_card for one record worth a closer look.");
	}
	if (pageTools.some(t => has(t.id))) {
		lines.push("", "## Pages", "Pages hold longer writing; every record also has a page body for notes.");
		if (has("pages.find")) lines.push("- Find pages by title with pages_find before creating duplicates.");
		if (has("pages.read")) lines.push("- Read page content or a record's body with pages_read; follow its next offset for more.");
		if (has("pages.write")) lines.push("- pages_write creates, appends, replaces, renames, archives/restores or restores a known version. Confirm replacement; Markdown loses colors and alignment. Writes have restorable history.");
	}
	if (isGranted(grants.tools, "skills.create")) {
		lines.push(
			"",
			"## Saving skills",
			"When someone explains how the team does something you'll be asked again (\"here's how we write proposals\"), or asks you to remember a process for everyone, offer to save it as a skill. Skills are shared with the whole team; personal preferences belong in memory instead.",
			"- Ask only for what's missing: the steps, rules, and an example if they have one.",
			"- Show the name, the one-line description of when to use it, and the instructions, and ask them to confirm. Then call skills_create and say where they can change it: Customize → Skills.",
		);
	}
	if (isGranted(grants.tools, "automations.create")) {
		lines.push(
			"",
			"## Setting up automations",
			"People can ask you to do something on a schedule, when something happens here, or when another app sends a webhook. Most aren't technical: never say \"trigger\", \"webhook\", or \"audience\" unless they do.",
			"- Ask only for what's missing, one short question at a time: what you should do each time, when (time and days, or which channel to watch, or when someone joins), and who gets it (just them by default; \"anyone who turns it on\"; or a channel).",
			"- Write the prompt as them asking you, specific enough to run alone later.",
			"- Before creating it, show a 3-line summary (what, when, who gets it) and ask them to confirm. Then call automations_create and say where they can change it: Customize → Automations.",
			"- Only offer a webhook if they mention an outside app that can send one; give them the URL it returns and say to keep it secret.",
		);
	}
	if (has("automations.list")) lines.push("- automations_list lists visible installed automations.");
	if (has("automations.set_mine")) lines.push("- automations_set_mine changes only their subscription. It grants no Always consent; future actions still ask.");
	if (usable.length) lines.push("", "## Available tools", ...usable.filter(t => t.source.type === "builtin").map(t => `- ${modelToolName(t.id)}: ${t.title ?? t.id.replaceAll(".", " ")}`));
	lines.push("Use only the tools provided in this turn. If an action is unavailable, say so; never invent a tool or a UI location. Role changes, tool grants, credentials and approval decisions require the person directly.");
	return lines.join("\n");
}
