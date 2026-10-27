import { api } from "../convex/_generated/api";
import { legacyAutomation } from "../convex/legacyCatalogs";
import { agentsOf, workspaceOf, type As, type newTest } from "./helpers";
import { type Field, NAME_KEY, keyOf } from "@companybot/core";
import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";

export { scribe } from "../../core/test/fixtures";

const options = (...labels: string[]) => labels.map((label) => ({ id: keyOf(label, []), label }));
const field = (key: string, label: string, kind: Field["kind"] = "text", extra: Partial<Field> = {}): Field => ({ key, label, kind, ...extra });
const name = field(NAME_KEY, "Name");
const client = field("client", "Client", "link", { linkType: "client" });
const deal = field("deal", "Deal", "link", { linkType: "deal" });
const owner = field("owner", "Owner", "user");
const legacyRecordTypes = [
	{ key: "client", name: "Client", plural: "Clients", fields: [name,
		field("status", "Status", "choice", { options: options("Lead", "Active", "Past") }),
		field("email", "Email", "email"), field("phone", "Phone", "phone"), field("address", "Address"), field("website", "Website", "url"), owner,
	] },
	{ key: "deal", name: "Deal", plural: "Deals", fields: [name, client,
		field("stage", "Stage", "choice", { options: options("New", "Qualified", "Proposal", "Won", "Lost") }),
		field("value", "Value", "currency"), field("close_date", "Close date", "date"), owner,
	] },
	{ key: "task", name: "Task", plural: "Tasks", fields: [field(NAME_KEY, "Task"),
		field("status", "Status", "choice", { options: options("To do", "Doing", "Done") }),
		field("due", "Due", "date"), field("assignee", "Assignee", "user"), client, deal,
	] },
	{ key: "call", name: "Call", plural: "Calls", fields: [field(NAME_KEY, "Title"), client, deal,
		field("direction", "Direction", "choice", { options: options("Inbound", "Outbound") }),
		field("date", "Date", "date"), field("minutes", "Minutes", "number"), field("summary", "Summary"),
	] },
];

/** Models databases from an existing alpha workspace, not new-workspace defaults. */
export async function seedLegacyRecords(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
	const ids = new Map<string, Id<"recordTypes">>();
	for (const { key, name, plural } of legacyRecordTypes) ids.set(key, await ctx.db.insert("recordTypes", { workspaceId, key, name, plural, archived: false, createdBy: userId, updatedAt: Date.now() }));
	for (const type of legacyRecordTypes) for (const [position, { linkType, ...field }] of type.fields.entries())
		await ctx.db.insert("recordFields", { workspaceId, typeId: ids.get(type.key)!, ...field, ...(linkType && { linkTypeId: ids.get(linkType)! }), position, archived: false, createdBy: userId, updatedAt: Date.now() });
}

export async function seedAutomation(t: ReturnType<typeof newTest>, as: As, automationId: string, timeZone = "America/Los_Angeles") {
	const workspaceId = await workspaceOf(as);
	const installedBy = (await as.query(api.workspace.me))!.userId;
	const agentId = (await agentsOf(as)).companybot._id;
	const definition = legacyAutomation(automationId)!;
	await t.run(async (ctx) => {
		const installId = await ctx.db.insert("automationInstalls", { workspaceId, automationId, installedBy, agentId, timeZone, enabled: true, audience: "subscribers", webhookToken: definition.trigger.type === "webhook" ? "a".repeat(48) : undefined });
		await ctx.db.insert("automationSubscriptions", { installId, userId: installedBy });
	});
}

export async function seedSkill(t: ReturnType<typeof newTest>, as: As, skillId: string) {
	const workspaceId = await workspaceOf(as);
	await t.run((ctx) => ctx.db.insert("skillInstalls", { workspaceId, skillId }));
}
