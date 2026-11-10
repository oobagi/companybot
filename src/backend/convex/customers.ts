import { type Field, type InboxChannel, NAME_KEY, can, formatPhone, indexEntries, phoneKeys, searchTextOf } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, requireMember } from "./lib";
import { fieldsOf, toField, typeVisible, typesOf, writeIndex } from "./recordOps";

// Inbox's customers: one database (Settings → Email and phone → Customers) whose records are the people
// writing in. A conversation links to the record there whose email field (email) or phone field (texts)
// holds its contact, and, when the setting says so, someone new gets a record made for them. Nothing is
// linked when no database is picked. The setting lives on the database (`recordTypes.customers`), so it
// goes and comes back with it (Trash), and at most one per workspace has it.

const RELINK_BATCH = 100;

/** The workspace's customers database, if one is picked and live. */
export async function customersOf(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	return (await typesOf(ctx, workspaceId)).find((t) => t.customers && !t.archived) ?? null;
}

const kindOf = (channel: InboxChannel): "email" | "phone" => (channel === "email" ? "email" : "phone");

/** Its first live field of a kind: where a contact's email or phone goes, and is looked up. */
const contactField = (fields: Doc<"recordFields">[], kind: "email" | "phone") => fields.find((f) => f.kind === kind && !f.archived);

/**
 * The live record in the customers database whose email field (for email) or phone field (for texts) holds this
 * contact, if any. One indexed lookup per field of that kind. Records index emails case-insensitively and phones
 * as digits (core records.ts `indexEntries`); a US number matches with or without its country code.
 */
export async function matchCustomer(ctx: QueryCtx, workspaceId: Id<"workspaces">, channel: InboxChannel, contact: string) {
	const type = await customersOf(ctx, workspaceId);
	if (!type) return null;
	const kind = kindOf(channel);
	const keys = kind === "email" ? indexEntries({ kind } as Field, contact).flatMap((e) => ("str" in e && e.str ? [e.str] : [])) : phoneKeys(contact);
	const fields = await ctx.db.query("recordFields").withIndex("by_type_kind", (q) => q.eq("typeId", type._id).eq("kind", kind)).take(20);
	for (const field of fields) {
		if (field.archived) continue;
		for (const key of keys) {
			const values = await ctx.db.query("recordValues").withIndex("by_field_str", (q) => q.eq("fieldId", field._id).eq("str", key)).take(5);
			for (const value of values) {
				const record = await ctx.db.get(value.recordId);
				if (record && !record.archived && record.typeId === type._id) return record._id;
			}
		}
	}
	return null;
}

/**
 * Links a conversation to its customer's record, or (when `isNew` and the setting adds new people) makes one:
 * their name (or address), and the address in the database's email or phone field. Nothing when the database
 * has no field for it, since the next message couldn't find the record again.
 */
export async function linkCustomer(ctx: MutationCtx, c: Doc<"inboxConversations">, isNew: boolean) {
	if (c.recordId) return;
	const found = await matchCustomer(ctx, c.workspaceId, c.channel, c.contact);
	if (found) return void (await ctx.db.patch(c._id, { recordId: found }));
	const type = isNew ? await customersOf(ctx, c.workspaceId) : null;
	if (!type?.customers?.addNew) return;
	const fields = await fieldsOf(ctx, type._id);
	const field = contactField(fields, kindOf(c.channel));
	if (!field) return;
	const title = c.contactName ?? (c.channel === "sms" ? formatPhone(c.contact) : c.contact);
	const values = { [NAME_KEY]: title, [field.key]: c.contact };
	const agentId = c.mode === "agent" ? c.agentId : undefined;
	const id = await ctx.db.insert("records", {
		workspaceId: c.workspaceId,
		typeId: type._id,
		title,
		values,
		searchText: searchTextOf(fields.map(toField), values),
		archived: false,
		updatedAt: Date.now(),
		...(agentId && { updatedByAgent: agentId }),
	});
	await writeIndex(ctx, (await ctx.db.get(id))!, fields);
	// History says it came from them, by their address, as an outsider's own changes do.
	await ctx.db.insert("recordHistory", {
		workspaceId: c.workspaceId,
		typeId: type._id,
		recordId: id,
		action: "created",
		contact: c.contact,
		...(agentId && { agentId }),
		changes: Object.entries(values).map(([key, value]) => ({ key, new: value })),
	});
	await ctx.db.patch(c._id, { recordId: id });
}

const canSee = (member: Member) => can(member, "inbox.use") || can(member, "inbox.setup");

/** The setting as Settings shows it: the picked database (and whether it has email and phone fields), and the ones to pick from. */
export const get = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !canSee(member)) return null;
		const visible = typeVisible(ctx, member);
		const types = (await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived);
		const options = [];
		for (const t of types) if (await visible(t._id)) options.push({ id: t._id, name: t.plural });
		const picked = types.find((t) => t.customers);
		const fields = picked ? await fieldsOf(ctx, picked._id) : [];
		return {
			database: picked ? { id: picked._id, name: picked.plural, email: !!contactField(fields, "email"), phone: !!contactField(fields, "phone"), addNew: !!picked.customers?.addNew } : null,
			options,
		};
	},
});

/**
 * Picks the customers database (null: none) and whether new people get a record. A different database relinks
 * every conversation to its records there, in the background.
 */
export async function setCustomers(ctx: MutationCtx, member: Member, typeId: Id<"recordTypes"> | null, addNew: boolean) {
	checkPermission(member, "inbox.setup");
	const types = await typesOf(ctx, member.workspaceId);
	const next = typeId && types.find((t) => t._id === typeId && !t.archived);
	if (typeId && (!next || !(await typeVisible(ctx, member)(typeId)))) throw new ConvexError("Database not found.");
	const before = types.find((t) => t.customers);
	for (const t of types) if (t.customers && t._id !== typeId) await ctx.db.patch(t._id, { customers: undefined });
	if (next) await ctx.db.patch(next._id, { customers: { addNew } });
	if (before?._id !== (next ? next._id : undefined)) await ctx.scheduler.runAfter(0, internal.customers.relink, { workspaceId: member.workspaceId });
}

export const set = mutation({
	args: { typeId: v.union(v.id("recordTypes"), v.null()), addNew: v.boolean() },
	handler: async (ctx, { typeId, addNew }) => setCustomers(ctx, await requireMember(ctx), typeId, addNew),
});

/** Points every conversation at its customer's record in the database picked now (none when none is), a batch at a time. */
export const relink = internalMutation({
	args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.string()) },
	handler: async (ctx, { workspaceId, cursor }) => {
		const page = await ctx.db.query("inboxConversations").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).paginate({ cursor: cursor ?? null, numItems: RELINK_BATCH });
		for (const c of page.page) {
			const recordId = (await matchCustomer(ctx, workspaceId, c.channel, c.contact)) ?? undefined;
			if (recordId !== c.recordId) await ctx.db.patch(c._id, { recordId });
		}
		if (!page.isDone) await ctx.scheduler.runAfter(0, internal.customers.relink, { workspaceId, cursor: page.continueCursor });
	},
});
