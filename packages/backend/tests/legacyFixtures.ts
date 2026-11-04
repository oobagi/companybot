import { api } from "../convex/_generated/api";
import { agentsOf, workspaceOf, type As, type newTest } from "./helpers";
import { type Field, NAME_KEY, defineAutomation, defineSkill, keyOf } from "@companybot/core";
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

// What the retired skill and automation libraries left in existing workspaces: installs with a stored definition.
export const retainedSkill = defineSkill({
	id: "meeting-notes",
	name: "Meeting notes",
	description: "Turn rough meeting notes into a summary with decisions and action items.",
	version: "0.1.0",
	instructions: `Rewrite the notes as:
1. **Summary** — two or three sentences.
2. **Decisions** — bullet list. Write "None" if there were none.
3. **Action items** — "- [ ] Owner: task (due date if mentioned)".
Keep the people's own wording for decisions. Don't invent owners or dates.`,
});

export const retainedAutomation = defineAutomation({
	id: "morning-brief",
	name: "Morning brief",
	description: "Every weekday at 8am, each person gets their day at a glance.",
	details: "Each weekday morning the agent messages every member with their day at a glance.",
	version: "0.1.0",
	publisher: "Companybot",
	trigger: { type: "schedule", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
	connectors: [],
	prompt: `Morning brief. Give me my day at a glance, in this order:
1. **Today** — meetings, deadlines, and anything time-sensitive.
2. **Open tasks** — follow-ups and action items still waiting on me.
3. **Overnight** — what changed since yesterday.
Use your memory and any tools you have. Skip a section if there's nothing for it. Keep it short.`,
});

const retainedAutomations = {
	"morning-brief": retainedAutomation,
	"after-call-summary": defineAutomation({
		id: "after-call-summary",
		name: "After-call summary",
		description: "When a call ends, get a summary with next steps and action items.",
		details: `After each call, the agent writes up:
	- **Summary** — two or three sentences.
	- **Next steps** — what was agreed.
	- **Action items** — who does what, by when.
	
	**Setup:** copy this automation's webhook URL into your phone system, or anything that can send a webhook when a call ends. Pick a channel like #calls, or leave it on DMs to message the person each call is for.`,
		version: "0.2.0",
		publisher: "Companybot",
		trigger: {
			type: "webhook",
			webhookEvent: "call.ended",
			label: "When a call ends",
			sample: {
				event: "call.ended",
				id: "sample",
				data: {
					direction: "inbound",
					caller: { name: "Dana Reyes", phone: "+15305550142" },
					takenBy: "AI receptionist",
					durationSeconds: 212,
					summary:
						"Dana's water heater is leaking. She wants a quote to replace it this week and asked whether tankless is worth it. Agreed a technician visits Thursday 10am; office to text a confirmation.",
				},
			},
		},
		connectors: [],
		prompt: `A call just ended. Using the call details below, write:
	1. **Summary** — two or three sentences: who called and why.
	2. **Next steps** — what was agreed.
	3. **Action items** — "- [ ] Owner: task (due date)". Leave out the owner or date when the details don't name one; never guess.
	If the details include a link to the call, add it at the end. Don't comment on what the details leave out.`,
	}),
};

export async function seedAutomation(t: ReturnType<typeof newTest>, as: As, automationId: keyof typeof retainedAutomations, timeZone = "America/Los_Angeles") {
	const workspaceId = await workspaceOf(as);
	const installedBy = (await as.query(api.workspace.me))!.userId;
	const agentId = (await agentsOf(as)).companybot._id;
	const definition = retainedAutomations[automationId];
	await t.run(async (ctx) => {
		const installId = await ctx.db.insert("automationInstalls", { workspaceId, automationId, definition, installedBy, agentId, timeZone, enabled: true, audience: "subscribers", webhookToken: definition.trigger.type === "webhook" ? "a".repeat(48) : undefined });
		await ctx.db.insert("automationSubscriptions", { installId, userId: installedBy });
	});
}

export async function seedSkill(t: ReturnType<typeof newTest>, as: As, skillId: "meeting-notes") {
	const workspaceId = await workspaceOf(as);
	await t.run((ctx) => ctx.db.insert("skillInstalls", { workspaceId, skillId, definition: retainedSkill }));
}
