import { z } from "zod";
import { SKILL_DESCRIPTION_MAX, SKILL_INSTRUCTIONS_MAX, SKILL_NAME_MAX } from "./skills";
import { defineTool, type ToolDef } from "./tools";

const id = z.string().min(1);
const ids = z.array(id).max(50);
const userIds = ids.describe("User ids from find_people");
const agentIds = ids.describe("Agent ids from find_people with kind \"agents\"");
const version = z.number().int().describe("version from get; a stale one is refused");
const page = { cursor: z.string().optional() };
const skillConfig = z.object({ name: z.string().max(SKILL_NAME_MAX), description: z.string().max(SKILL_DESCRIPTION_MAX), instructions: z.string().max(SKILL_INSTRUCTIONS_MAX) });
const trigger = z.union([
	z.object({ type: z.literal("schedule"), time: z.string(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }),
	z.object({ type: z.literal("event"), event: z.literal("member.joined") }),
	z.object({ type: z.literal("event"), event: z.literal("message.posted"), channelId: id }),
	z.object({ type: z.literal("webhook") }),
]);
// Keep the root an object for provider tool schemas; only the chosen action's fields are valid.
export const manageInputs = {
	"chat.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("find_people"), kind: z.enum(["people", "agents", "invites"]).optional(), ...page }),
			z.strictObject({ action: z.literal("list_chats"), ...page }),
			z.strictObject({ action: z.literal("mark_read"), chat: id }),
			z.strictObject({ action: z.literal("edit"), messageId: id, text: z.string().min(1).max(20_000) }),
			z.strictObject({ action: z.literal("delete"), messageId: id }),
			z.strictObject({ action: z.literal("react"), messageId: id, emoji: z.string().min(1).max(16) }),
			z.strictObject({ action: z.literal("open_dm"), userIds: userIds.describe("Others in the DM; you are added"), agentIds }),
			z.strictObject({
				action: z.literal("send"),
				chat: id.describe("Chat id or #channel"),
				threadId: id.optional().describe("Top-level message id, to reply in its thread"),
				text: z.string().min(1).max(20_000),
				userIds: userIds.optional().describe("People to @mention"),
				agentIds: agentIds.optional().describe("Agents to @mention; they don't reply"),
			}),
		]),
	}),
	"channels.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("list"), ...page }),
			z.strictObject({ action: z.literal("get"), chat: id, ...page }),
			z.strictObject({ action: z.literal("create"), name: z.string().min(1).max(80), topic: z.string().max(2000).optional(), private: z.boolean() }),
			z.strictObject({ action: z.literal("rename"), chat: id, name: z.string().min(1).max(80) }),
			z.strictObject({ action: z.literal("set_topic"), chat: id, topic: z.string().max(2000) }),
			z.strictObject({ action: z.literal("add_members"), chat: id, userIds, agentIds }),
			z
				.strictObject({ action: z.literal("remove_member"), chat: id, userId: id.optional(), agentId: id.optional() })
				.refine((x) => !!x.userId !== !!x.agentId, "Choose one person or agent"),
			z.strictObject({ action: z.literal("join"), chat: id }),
			z.strictObject({ action: z.literal("leave"), chat: id }),
			z.strictObject({ action: z.literal("delete"), chat: id }),
			z.strictObject({ action: z.literal("restore"), chat: id.describe("Exact id of the deleted channel") }),
		]),
	}),
	"automations.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("list"), ...page }),
			z.strictObject({ action: z.literal("get"), id }),
			z.strictObject({ action: z.literal("install"), id, timeZone: z.string() }),
			z.strictObject({ action: z.literal("run"), id }),
			z.strictObject({
				action: z.literal("edit"),
				id,
				expectedVersion: version,
				config: z.object({ name: z.string(), prompt: z.string().max(20_000), trigger }),
			}),
			z.strictObject({ action: z.literal("pause"), id }),
			z.strictObject({ action: z.literal("resume"), id }),
			z.strictObject({ action: z.literal("set_agent"), id, agentId: id }),
			z.strictObject({ action: z.literal("set_audience"), id, audience: z.enum(["creator", "subscribers", "channel"]), channelId: id.optional() }),
		]),
	}),
	"automations.remove": z.object({ request: z.strictObject({ action: z.literal("delete"), id }) }),
	"skills.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("list"), ...page }),
			z.strictObject({ action: z.literal("get"), id }),
			z.strictObject({ action: z.literal("install"), id }),
		]),
	}),
	"skills.edit": z.object({ request: z.strictObject({ action: z.literal("edit"), id, expectedVersion: version, config: skillConfig }) }),
	"skills.remove": z.object({ request: z.strictObject({ action: z.literal("delete"), id }) }),
	"members.invite": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("invite"), email: z.string().email() }),
			z.strictObject({ action: z.literal("resend"), email: z.string().email() }),
			z.strictObject({ action: z.literal("cancel"), email: z.string().email() }),
		]),
	}),
	"members.remove": z.object({
		request: z.strictObject({ action: z.literal("remove"), email: z.string().email() }),
	}),
	"agents.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("list"), ...page }),
			z.strictObject({ action: z.literal("get"), id }),
			z.strictObject({ action: z.literal("models"), search: z.string().optional().describe("Words in a model's name or id, like \"claude\" or \"openai\"") }),
			z.strictObject({ action: z.literal("history"), id, ...page }),
			z.strictObject({ action: z.literal("create") }),
			z.strictObject({ action: z.literal("delete"), id }),
			z.strictObject({ action: z.literal("update"), id, expectedVersion: version, name: z.string().optional(), description: z.string().optional(), instructions: z.string().optional(), model: z.string().optional() }),
		]),
	}),
	"workspace.settings": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("get") }),
			z.strictObject({ action: z.literal("get_preferences") }),
			z.strictObject({ action: z.literal("update_preferences"), displayName: z.string().max(60).optional(), sendWith: z.enum(["enter", "mod-enter"]).optional(), notify: z.enum(["all", "mentions", "off"]).optional(), timeZone: z.string().nullable().optional() }),
			z.strictObject({
				action: z.literal("update"),
				expectedVersion: version,
				name: z.string().min(1).optional(),
				currency: z.string().optional(),
				memory: z.boolean().optional(),
			}),
		]),
	}),
};
export type ManageTool = keyof typeof manageInputs;
export interface ManageStore {
	run(tool: ManageTool, input: unknown): Promise<unknown>;
}
/** Each tool's title and description. */
const about: Record<ManageTool, [title: string, description: string]> = {
	"chat.manage": ["Manage messages and DMs", "Find people (paged directory, including agent ids), list your chats, open a DM with exact participant ids, deliver a message to a chosen chat/thread, edit your person's own messages, delete them with locked approval, react to an exact message, or explicitly mark a chat read when asked. Sent as you for the person; never triggers agents or automations. Only send when asked; do not copy private information to a wider audience without their request."],
	"channels.manage": ["Manage channels", "Browse public channels, inspect a visible channel and paged participants, create, rename, set/clear topic, add/remove members, join or leave. Use chat ids or #names. Managers remove members; everyone stays in general. Delete moves a channel to Trash for 30 days and waits for approval; only its creator or an owner can do it. Restore by its exact id as the deleter or an owner. Never deletes forever."],
	"automations.manage": ["Manage automations", "List or inspect visible automations (prompt, version, agent, state), edit custom config using its current expectedVersion, pause/resume globally, change agent/audience, install a library automation, or run a sample once just for the person. Runs cannot start other runs. Confirm changes first. Resuming grants no consent: future outside actions still ask. Webhook secrets are omitted."],
	"automations.remove": ["Delete an automation", "Delete an automation someone made, or uninstall a library one, by id. A deleted one goes to Trash for 30 days and stops running; its maker or an owner can restore it from Trash. Uninstalling removes subscriptions and approval grants. The exact call waits for approval."],
	"skills.manage": ["Manage skills", "Browse custom and library skills, read full instructions and current version, or install a library skill (owners). Editing is a separate tool that asks first."],
	"skills.edit": ["Edit a skill", "Edit a custom skill's name, description and instructions, using its current expectedVersion from skills_manage get. Every agent here follows skills, so the exact call waits for approval. Confirm the exact instructions with the person first."],
	"skills.remove": ["Delete or uninstall a skill", "Delete a custom skill (to Trash for 30 days; agents stop seeing it; the maker or an owner can restore it) or uninstall a library skill, by id. The exact call waits for approval."],
	"members.invite": ["Manage member invitations", "Invite an email as a member, or resend or cancel the invitation for an email (owners). Invite and resend send email outside the workspace and wait for approval. Cannot invite owners or change roles."],
	"members.remove": ["Remove a member", "Remove another member by their email (owners). Deletes their personal workspace data and access. The exact call waits for approval; cannot remove yourself."],
	"agents.manage": ["Manage agents", "Browse agents and their paged configuration history, create an agent with no tools, edit metadata, or delete an agent (to Trash for 30 days; the last agent stays). Writes require an owner. Deleting and changing another agent's instructions or model wait for approval; do them only when asked; you cannot change your own instructions/model, grant tools, restore grants or restore an agent from Trash. Use the current expectedVersion. models lists the AI Gateway models an agent can run on (id, context, $ per M input/output tokens); use one of those ids."],
	"workspace.settings": ["Manage workspace settings", "Read/update the acting person's display name, send shortcut, notification preference and explicit time zone (null = automatic). Device time zone is measured by the device. Read workspace name, default currency, memory switch and version; update these as an owner using the current expectedVersion. Existing amounts keep their currency; the default only affects new amounts. Memory off keeps stored memories. Change only when asked."],
};
/** What a call does to whom, for its card and tool line: "Remove ben@acme.com from the workspace", "Post in #sales". */
function manageLabel(input: unknown): string | undefined {
	const r = (input as { request?: Record<string, unknown> } | undefined)?.request;
	const at = (key: string) => (typeof r?.[key] === "string" ? (r[key] as string) : "");
	// A chat is a #name or an id; ids aren't words, so they read as "a chat".
	const chat = /^[a-z0-9]{31,}$/.test(at("chat")) ? "a chat" : `#${at("chat").replace(/^#/, "")}`;
	switch (r?.action) {
		case "invite":
			return `Invite ${at("email")} to the workspace`;
		case "resend":
			return `Resend the invitation to ${at("email")}`;
		case "cancel":
			return `Cancel the invitation for ${at("email")}`;
		case "remove":
			return `Remove ${at("email")} from the workspace`;
		case "send":
			return `Post in ${chat}`;
		case "remove_member":
			return `Remove someone from ${chat}`;
		case "add_members":
			return `Add people to ${chat}`;
	}
}

export const manageTools: ToolDef[] = (Object.keys(manageInputs) as ManageTool[]).map((id) =>
	defineTool<unknown>({
		id,
		title: about[id][0],
		description: about[id][1],
		input: manageInputs[id],
		...((id === "members.invite" || id === "members.remove") && { permission: "members.manage" as const }),
		...(id.endsWith(".remove") ? { risk: "locked" as const } : id === "members.invite" || id === "skills.edit" ? { risk: "outside" as const } : {}),
		// Deleting, or rewriting another agent's instructions/model, always asks.
		...((id === "channels.manage" || id === "chat.manage" || id === "agents.manage") && {
			riskFor: (input: unknown) => {
				const r = manageInputs[id].safeParse(input).data?.request as { action: string; instructions?: string; model?: string } | undefined;
				const locked = r && (r.action === "delete" || (r.action === "update" && (r.instructions !== undefined || r.model !== undefined)));
				return locked ? "locked" as const : "inside" as const;
			},
		}),
		execute: (input, { manage }) => manage.run(id, input),
		label: manageLabel,
	}),
);
