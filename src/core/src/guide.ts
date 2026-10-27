import type { AgentConfig } from "./agent-config";
import { grantedConnectorIds, resolveTools } from "./agents";
import { chatTools } from "./chat";
import { pageTools } from "./page-tools";
import { recordTools } from "./record-tools";
import type { ToolDef } from "./tools";
import { widgetCatalog } from "./widgets";

/**
 * Platform instructions every agent gets, after its owner-written instructions.
 * Owners describe who the agent is; this explains how replies are shown, so it
 * stays correct for every agent and changes in one place when the app does.
 * Sections only appear for tools the agent is granted.
 */
export function platformGuide(agent: Pick<AgentConfig, "tools">, available?: readonly ToolDef[]): string {
	const usable = available ?? resolveTools(agent, { userId: "", role: "owner" });
	const has = (id: string) => usable.some((t) => t.id === id);
	const lines = [
		"## How your replies are shown",
		"The chat renders GitHub-flavored Markdown. Use it lightly: short paragraphs, **bold** for key facts, lists for steps or options, `code` for exact values, and fenced code blocks for code. No HTML. Keep headings to ### or smaller and only for long replies.",
	];
	if (widgetCatalog.some((w) => has(`widgets.${w.type}`))) {
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
	if (chatTools.some((t) => has(t.id))) {
		lines.push(
			"",
			"## Chat",
			"You work in a team chat of channels, DMs, and threads. Each new message to you says where you are and lists what was said there since your last reply, labeled `[Name time]`, then the message to answer. Your reply is posted right there. Don't start it with your name or a label. Your earlier replies end with the tools you used in them; trust that record.",
		);
		if (has("chat.read") || has("chat.search")) {
			lines.push("- Use chat tools for older messages, threads, or other channels instead of guessing.");
		}
		if (has("chat.react")) lines.push("- A reaction (chat_react) can acknowledge a message; still reply when there's something to say.");
	}
	if (recordTools.some((t) => has(t.id))) {
		lines.push(
			"",
			"## Databases",
			"The workspace's CRM: clients, deals, tasks, calls, and databases the team adds. Facts about customers and work (contact details, deal stages, amounts, due dates, who owns what) go on records, not in memory; memory is for preferences and how people like to work.",
		);
		if (has("records.types")) lines.push("- Learn the databases and field keys with records_types before using unfamiliar schema and again before schema changes; reuse unchanged keys. Stable choice ids preserve existing values when labels change. Refer to teammates by name or \"me\", and linked records by exact name or id.");
		if (has("records.save_database")) lines.push("- Owners can create, rename and delete databases with records_save_database. Read the current version first. Change databases only when asked.");
		if (has("records.views")) lines.push("- Shared sorting and filtering is in records_views.");
		if (has("records.save_view")) lines.push("- Change shared views with records_save_view, from their current version, only when asked.");
		if (has("records.find")) lines.push("- Find before you create, so there are no duplicates. If several records match, ask which one.");
		if (has("records.save") || has("records.save_field")) {
			lines.push(
				"- Changes run right away, logged as you acting for the person. Say in a sentence what you changed.",
				"- Deleting moves things to Trash: whoever deleted it, or an owner, can restore it for 30 days. You cannot delete anything forever.",
				"- Before changing or deleting more than 3 records at once, list them and ask the person to confirm. Add or change fields only when asked.",
			);
		}
		if (has("records.history")) lines.push("- records_history pages full record history by id or workspace Activity without id; source agents reads visible tool activity. Continue with continueCursor while isDone is false.");
		if (has("records.undo")) lines.push("- Record changes return a change id; records_undo reverses those if they ask.");
		if (has("widgets.table")) lines.push("- Show 3+ records with widgets_table, passing `from: { ref, path: \"rows\", fields }` with field keys.");
		if (has("widgets.card")) lines.push("- Show one record worth a closer look with widgets_card.");
		lines.push(
			"- Values come formatted for people: dates like \"Nov 15, 2026\", amounts in their own currency (\"$\" is US dollars). Write them that way in replies too. In tool input, dates are YYYY-MM-DD, and amounts go without a code for the workspace's currency or with one (\"EUR 1200\"). Never convert or add up amounts in different currencies.",
		);
	}
	if (pageTools.some((t) => has(t.id))) {
		lines.push(
			"",
			"## Pages",
			"Pages hold longer writing: wiki pages, how-tos, meeting notes. Every record also has a page body for notes about it.",
		);
		if (has("pages.read")) lines.push("- pages_read history lists retained versions with a cursor; version previews one. For colored or aligned content, read format blocks and edit the complete JSON array so formatting survives. Markdown drops colors and alignment.");
		if (has("pages.find")) lines.push("- Find a page with pages_find before creating one, so there are no duplicates.");
		if (has("pages.write"))
			lines.push(
				`- ${has("pages.read") ? "Read a page with pages_read before you replace it; to" : "To"} add to it, append with pages_write. Writes run right away and are saved in the page's history as you acting for the person, so they can be restored. Say in a sentence what you wrote, and where.`,
			);
	}
	if (has("skills.create")) {
		lines.push(
			"",
			"## Saving skills",
			"When someone explains how the team does something you'll be asked again (\"here's how we write proposals\"), or asks you to remember a process for everyone, offer to save it as a skill. Skills are shared with the whole team; personal preferences belong in memory instead.",
			"- Ask only for what's missing: the steps, rules, and an example if they have one.",
			"- Show the name, the one-line description of when to use it, and the instructions, and ask them to confirm. Then call skills_create and say where they can change it: Customize → Skills.",
		);
	}
	if (has("automations.create")) {
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
	if (has("automations.list") && has("automations.set_mine")) {
		lines.push(
			"",
			"## Existing automations",
			"- To turn on an existing one for them (\"I want the morning brief too\"), find it with automations_list and use automations_set_mine. That doesn't allow its actions: anything that would ask still asks.",
		);
	}
	if (has("agents.manage")) lines.push("", "## Agents", "Use agents_manage for agent metadata, paged history, tool-free creation, archiving and another agent's instructions/model (archiving and instruction/model changes wait for approval). Read the current version first. Tool grants, your own instructions/model, restoring prior config and reactivation need a person directly.");
	if (has("chat.manage")) lines.push("- chat_manage can edit your person's own messages, delete them with approval, react to an exact message, or mark a chat read only when explicitly asked. Delivery never starts agents or automations.");
	if (has("workspace.settings")) lines.push("- workspace_settings manages workspace settings (owners) and the acting person's preferences; device measurements stay automatic.");
	lines.push("", "Use only the tools you're given. If something can't be done with them, say so. Role changes, tool grants, sign-ins and approvals are for the person to do directly.");
	return lines.join("\n");
}
