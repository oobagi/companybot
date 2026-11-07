import { can } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, requireInWorkspace, requireMember, requirePermission } from "./lib";
import { accessInfo, canAdd, reach, requireAccess, requireKeepsEdit, savedAccess } from "./placeAccess";
import { NO_BOARD, createType, fieldsOf, fieldsShown, groupsCards, requireType, typesOf, updateType } from "./recordOps";
import { canReadSources } from "./replyPrivacy";
import { changeAccessSources } from "./replySources";
import { accessArg, databaseDisplay } from "./schema";

// Databases: the workspace's data model. People with `fields.edit` add types; fields
// are in fields.ts. Each has a Who can access list (placeAccess.ts). See wiki/data.md.

/**
 * Every live type the person can see, oldest first, with its fields in order, ones in Archive last
 * and marked `archived`. `canEdit`: they can change its records; `canManage`: its fields, name and access.
 */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		// Add (without View) still shows the database: its fields and the records they made.
		const types = (await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived && (reach(member, t.access) || canAdd(member, t.access))).sort((a, b) => a._creationTime - b._creationTime);
		const readable = (await Promise.all(types.map(async (t) => await canReadSources(ctx, member, t.usedPlaces) ? t : null))).filter((t) => t !== null);
		const shown = fieldsShown(ctx, member);
		return Promise.all(
			readable.map(async (t) => {
				const fields = await fieldsOf(ctx, t._id);
				const { level, ...access } = accessInfo(member, t.access);
				const manage = can(member, "fields.edit") && level === "edit";
				return {
					_id: t._id,
					key: t.key,
					name: t.name,
					plural: t.plural,
					version: t.version ?? 0,
					display: t.display ?? { layout: "table" as const },
					...access,
					canEdit: level === "edit" && can(member, "records.edit"),
					/** Add: they create records and see and change only their own (records.list shows just those). */
					canAdd: access.canAdd && can(member, "records.edit"),
					/** Whether they see every record, or (Add) only the ones they made. */
					seesAll: !!level,
					/** Whether they may change the All tab's shared layout and grouping (recordTypes.setDisplay). */
					canSetDisplay: level === "edit" && can(member, "sidebar.arrange"),
					canManage: manage,
					fields: await Promise.all(
						[...fields.filter((f) => !f.archived), ...fields.filter((f) => f.archived)].map(async (f) => ({
							_id: f._id,
							...(await shown(f)),
							archived: f.archived,
							canEdit: manage,
						})),
					),
				};
			}),
		);
	},
});

export const create = mutation({
	args: { plural: v.string() },
	handler: async (ctx, input) => createType(ctx, { member: await requireMember(ctx) }, input),
});

export const update = mutation({
	args: { typeId: v.id("recordTypes"), name: v.optional(v.string()), plural: v.optional(v.string()), version: v.number() },
	handler: async (ctx, { typeId, ...input }) => updateType(ctx, { member: await requireMember(ctx) }, typeId, input),
});

/**
 * Who can access a database, its records and their pages: Everyone, roles or Public, each at View, Add
 * (create records and see and change only their own) or Edit. Public never gets Edit (core
 * `publicLevelProblem`). People with `fields.edit` and Edit in it choose.
 */
export const setAccess = mutation({
	args: { typeId: v.id("recordTypes"), access: accessArg },
	handler: async (ctx, { typeId, access }) => {
		const member = await requireMember(ctx);
		checkPermission(member, "fields.edit");
		const type = requireInWorkspace(member, await ctx.db.get(typeId), "Database");
		requireAccess(member, "database", type.plural, type.access, "edit");
		if (type.archived) throw new ConvexError("This database is in Archive. Restore it to make changes.");
		const list = await savedAccess(ctx, member, access, "database");
		requireKeepsEdit(member, "database", list);
		await changeAccessSources(ctx, member, type, { access: list });
		// Everyone at Edit is the default: store nothing.
		const open = list.length === 1 && list[0]!.role === "everyone" && list[0]!.level === "edit";
		await ctx.db.patch(type._id, { access: open ? undefined : list, version: (type.version ?? 0) + 1, updatedAt: Date.now() });
	},
});

type Display = { layout?: "table" | "board"; groupBy?: string };

/** Each change names only what it sets, so two people changing layout and grouping at once don't undo each other. */
async function saveDisplay(ctx: MutationCtx, member: Member, typeId: Id<"recordTypes">, change: Display) {
	// Everyone's All tab shows it, so changing it takes Edit in the database, not just View.
	const type = await requireType(ctx, member, typeId, "edit");
	if (type.archived) throw new ConvexError("This database is in Archive. Restore it to make changes.");
	if (change.groupBy && !(await groupable(ctx, typeId, change.groupBy))) throw new ConvexError("Group a board by a live choice field that holds one option.");
	if (change.layout === "board" && !(await fieldsOf(ctx, typeId)).some(groupsCards)) throw new ConvexError(NO_BOARD);
	const display = { layout: change.layout ?? type.display?.layout ?? "table", groupBy: change.groupBy ?? type.display?.groupBy };
	await ctx.db.patch(typeId, { display });
}

const groupable = async (ctx: MutationCtx, typeId: Id<"recordTypes">, key: string) => (await fieldsOf(ctx, typeId)).some((f) => f.key === key && groupsCards(f));

export const setDisplay = mutation({
	args: { typeId: v.id("recordTypes"), display: v.object({ layout: v.optional(databaseDisplay.fields.layout), groupBy: v.optional(v.string()) }) },
	handler: async (ctx, { typeId, display }) => saveDisplay(ctx, await requirePermission(ctx, "sidebar.arrange"), typeId, display),
});

/** COMPAT(0.1.0-alpha.10): one-time import of this computer's old choice; delete with `arrangements.migrate`. Anything that can never succeed is skipped, not thrown, so the importer can clear the key. */
export const migrateDisplay = mutation({
	args: { databaseKey: v.string(), display: databaseDisplay },
	handler: async (ctx, { databaseKey, display }) => {
		const member = await requireMember(ctx);
		if (!can(member, "sidebar.arrange")) return;
		const type = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", databaseKey)).unique();
		// The same limits as setDisplay: Edit in the database, and no board without a field to group by.
		if (!type || type.archived || type.display || reach(member, type.access) !== "edit" || !(await canReadSources(ctx, member, type.usedPlaces))) return;
		const fields = await fieldsOf(ctx, type._id);
		if (display.layout === "board" && !fields.some(groupsCards)) return;
		const groupBy = display.groupBy && fields.some((f) => f.key === display.groupBy && groupsCards(f)) ? display.groupBy : undefined;
		await ctx.db.patch(type._id, { display: { layout: display.layout, groupBy } });
	},
});
