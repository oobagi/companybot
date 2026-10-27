import { z } from "zod";
import { defineTool, type ToolDef } from "./tools";

const id = z.string().min(1);
const ids = z.array(id).max(50);
const page = { cursor: z.string().optional() };
const skillConfig = z.object({ name: z.string().max(64), description: z.string().max(200), instructions: z.string().max(20_000) });
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
			z.strictObject({ action: z.literal("open_dm"), userIds: ids, agentIds: ids }),
			z.strictObject({
				action: z.literal("send"),
				chat: id.describe("Chat id or #channel"),
				threadId: id.optional(),
				text: z.string().min(1).max(20_000),
				userIds: ids.optional(),
				agentIds: ids.optional(),
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
			z.strictObject({ action: z.literal("add_members"), chat: id, userIds: ids, agentIds: ids }),
			z
				.strictObject({ action: z.literal("remove_member"), chat: id, userId: id.optional(), agentId: id.optional() })
				.refine((x) => !!x.userId !== !!x.agentId, "Choose one person or agent"),
			z.strictObject({ action: z.literal("join"), chat: id }),
			z.strictObject({ action: z.literal("leave"), chat: id }),
		]),
	}),
	"automations.manage": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("list"), ...page }),
			z.strictObject({ action: z.literal("get"), id }),
			z.strictObject({
				action: z.literal("edit"),
				id,
				expectedVersion: z.number().int(),
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
			z.strictObject({ action: z.literal("edit"), id, expectedVersion: z.number().int(), config: skillConfig }),
			z.strictObject({ action: z.literal("install"), id }),
		]),
	}),
	"skills.remove": z.object({ request: z.strictObject({ action: z.literal("delete"), id }) }),
	"members.invite": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("invite"), email: z.string().email() }),
			z.strictObject({ action: z.literal("resend"), id }),
			z.strictObject({ action: z.literal("cancel"), id }),
		]),
	}),
	"members.remove": z.object({
		request: z.strictObject({ action: z.literal("remove"), id: id.describe("Membership id from find_people; removes personal workspace data") }),
	}),
	"workspace.settings": z.object({
		request: z.discriminatedUnion("action", [
			z.strictObject({ action: z.literal("get") }),
			z.strictObject({
				action: z.literal("update"),
				expectedVersion: z.number().int(),
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
const descriptions: Record<ManageTool, string> = {
	"chat.manage":
		"Find people (paged directory, including agent ids), list your chats, open a DM with exact participant ids, or deliver a message to a chosen chat/thread. Sent as you for the person; never triggers agents or automations. Only send when asked; do not copy private information to a wider audience without their request.",
	"channels.manage":
		"Browse public channels, inspect a visible channel and paged participants, create, rename, set/clear topic, add/remove members, join or leave. Use chat ids or #names. Managers remove members; everyone stays in general. No delete or archive action.",
	"automations.manage":
		"List or inspect visible automations (prompt, version, agent, state), edit custom config using its current expectedVersion, pause/resume globally, or change agent/audience. Confirm changes first. Resuming grants no consent: future outside actions still ask. Webhook secrets are omitted.",
	"automations.remove":
		"Permanently delete/uninstall an automation by id. Stops runs and removes subscriptions and approval grants. The exact call waits for approval.",
	"skills.manage":
		"Browse custom and library skills, read full instructions and current version, edit a custom skill with expectedVersion, or install a library skill (owners). Confirm exact instructions before editing. Changes are shared with the team.",
	"skills.remove": "Permanently delete a custom skill or uninstall a library skill by id. The exact call waits for approval.",
	"members.invite":
		"Invite an email as a member, resend or cancel an invitation (owners). Invite and resend send email outside the workspace and wait for approval. Cannot invite owners or change roles.",
	"members.remove":
		"Remove another member by membership id (owners). Deletes their personal workspace data and access. The exact call waits for approval; cannot remove yourself.",
	"workspace.settings":
		"Read workspace name, default currency, memory switch and version; update these as an owner using the current expectedVersion. Existing amounts keep their currency; the default only affects new amounts. Memory off keeps stored memories. Change only when asked.",
};
const titles: Record<ManageTool, string> = {
	"chat.manage": "Manage messages and DMs",
	"channels.manage": "Manage channels",
	"automations.manage": "Manage automations",
	"automations.remove": "Delete an automation",
	"skills.manage": "Manage skills",
	"skills.remove": "Delete or uninstall a skill",
	"members.invite": "Manage member invitations",
	"members.remove": "Remove a member",
	"workspace.settings": "Manage workspace settings",
};
export const manageTools: ToolDef[] = (Object.keys(manageInputs) as ManageTool[]).map((id) =>
	defineTool<unknown>({
		id,
		title: titles[id],
		description: descriptions[id],
		input: manageInputs[id],
		...((id === "members.invite" || id === "members.remove") && { permission: "members.manage" as const }),
		...(id.endsWith(".remove") ? { risk: "locked" as const } : id === "members.invite" ? { risk: "outside" as const } : {}),
		execute: (input, { manage }) => manage.run(id, input),
	}),
);
