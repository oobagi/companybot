import { can } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { checkPermission, getMember, requireInWorkspace, requireMember } from "./lib";
import { accessInfo, reach, requireAccess, requireKeepsEdit, savedAccess } from "./placeAccess";
import { createType, fieldsOf, fieldsShown, typesOf, updateType } from "./recordOps";
import { canReadSources } from "./replyPrivacy";
import { changeAccessSources } from "./replySources";
import { accessArg } from "./schema";

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
		const types = (await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived && reach(member, t.access)).sort((a, b) => a._creationTime - b._creationTime);
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
					...access,
					canEdit: level === "edit" && can(member, "records.edit"),
					canManage: manage,
					fields: await Promise.all(
						[...fields.filter((f) => !f.archived), ...fields.filter((f) => f.archived)].map(async (f) => ({
							_id: f._id,
							...(await shown(f)),
							archived: f.archived,
							/** Its kind, one/several or linked database is changing: values are converting, and it can't be edited until it's done. */
							...(f.change && { changing: true as const }),
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
 * Who can access a database, its records and their pages: Everyone or roles, each at View or Edit.
 * People with `fields.edit` and Edit in it choose.
 */
export const setAccess = mutation({
	args: { typeId: v.id("recordTypes"), access: accessArg },
	handler: async (ctx, { typeId, access }) => {
		const member = await requireMember(ctx);
		checkPermission(member, "fields.edit");
		const type = requireInWorkspace(member, await ctx.db.get(typeId), "Database");
		requireAccess(member, "database", type.plural, type.access, "edit");
		if (type.archived) throw new ConvexError("This database is in Archive. Restore it to make changes.");
		const list = await savedAccess(ctx, member, access);
		requireKeepsEdit(member, "database", list);
		await changeAccessSources(ctx, member, type, { access: list });
		// Everyone at Edit is the default: store nothing.
		const open = list.length === 1 && list[0]!.role === "everyone" && list[0]!.level === "edit";
		await ctx.db.patch(type._id, { access: open ? undefined : list, version: (type.version ?? 0) + 1, updatedAt: Date.now() });
	},
});

/**
 * COMPAT(0.1.0-alpha.11): alpha.10 apps send their All tab's layout, grouping and widths here, though only while
 * `list` says `canSetDisplay`, which it no longer does. All is a saved view now (migrations.allView). Delete with `display` (schema.ts).
 */
export const setDisplay = mutation({
	args: { typeId: v.id("recordTypes"), display: v.any() },
	handler: async () => {
		throw new ConvexError("Update Companybot to change this view.");
	},
});

/** COMPAT(0.1.0-alpha.11): alpha.10 apps import this computer's old All tab layout once; there's nothing to import it into now. Delete with `arrangements.migrate`. */
export const migrateDisplay = mutation({
	args: { databaseKey: v.string(), display: v.any() },
	handler: async () => {},
});
